import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, rm, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ensureSessiond } from '../src/session/index.js';
import { SessiondStore } from '../src/session/sessiond-store.js';
import { SESSIOND_METHODS } from '../src/sessiond/protocol.js';
import {
  JsonRpcPeer,
  SESSIOND_PROTOCOL_VERSION,
  SessiondDaemon,
  SessiondRpcError,
} from '../src/sessiond/index.js';

const roots: string[] = [];
const daemons: SessiondDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop('test cleanup').catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{ root: string; socket: string; sessions: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codingx-daemon-'));
  roots.push(root);
  return {
    root,
    socket: path.join(root, 'run', 'sessiond.sock'),
    sessions: path.join(root, 'sessions'),
  };
}

interface OutdatedDaemon {
  shutdownCalls: number;
  close(): Promise<void>;
}

/**
 * A stand-in for a daemon started before `session.clear` existed: it speaks
 * the same protocol but its initialize reply has no `methods` list.
 */
async function startOutdatedDaemon(
  socketPath: string,
  options: { busy?: boolean; advertiseMethods?: boolean } = {},
): Promise<OutdatedDaemon> {
  await mkdir(path.dirname(socketPath), { recursive: true });
  const peers = new Set<JsonRpcPeer>();
  let shutdownCalls = 0;
  let server: Server;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const peer of peers) peer.close();
    peers.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => undefined);
  };
  server = createServer((socket: Socket) => {
    const peer = new JsonRpcPeer({
      stream: socket,
      onRequest: async (request) => {
        switch (request.method) {
          case 'initialize':
            return {
              protocol: SESSIOND_PROTOCOL_VERSION,
              version: '0.0.9-outdated',
              pid: process.pid,
              startedAt: new Date().toISOString(),
              sessionCount: 0,
              ...(options.advertiseMethods ? { methods: SESSIOND_METHODS, cwdIsolation: true } : {}),
            };
          case 'daemon.shutdown':
            shutdownCalls += 1;
            if (options.busy === true) {
              throw new SessiondRpcError(
                'SESSION_BUSY',
                'Cannot shut down while 1 session lease(s) are active.',
              );
            }
            setImmediate(() => {
              void stop();
            });
            return { ok: true };
          default:
            throw new SessiondRpcError('METHOD_NOT_FOUND', 'Unknown method: ' + request.method);
        }
      },
    });
    peers.add(peer);
    socket.on('close', () => peers.delete(peer));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    get shutdownCalls() {
      return shutdownCalls;
    },
    close: stop,
  };
}

describe('SessiondDaemon', () => {
  it('exits after the idle timeout and removes its socket', async () => {
    const paths = await setup();
    const daemon = await SessiondDaemon.start({
      socketPath: paths.socket,
      sessionDir: paths.sessions,
      idleTimeoutMs: 80,
    });
    daemons.push(daemon);
    await daemon.wait();
    expect(daemon.isStopped).toBe(true);
    await expect(access(paths.socket)).rejects.toThrow();
  });

  it('refuses a second daemon on the same socket and allows restart after stop', async () => {
    const paths = await setup();
    const first = await SessiondDaemon.start({
      socketPath: paths.socket,
      sessionDir: paths.sessions,
      idleTimeoutMs: 0,
    });
    daemons.push(first);
    await expect(
      SessiondDaemon.start({
        socketPath: paths.socket,
        sessionDir: paths.sessions,
        idleTimeoutMs: 0,
      }),
    ).rejects.toMatchObject({ kind: 'SESSION_BUSY' });

    await first.stop('test');
    const second = await SessiondDaemon.start({
      socketPath: paths.socket,
      sessionDir: paths.sessions,
      idleTimeoutMs: 0,
    });
    daemons.push(second);
    expect(second.isStopped).toBe(false);
  });
});

describe('ensureSessiond', () => {
  it('throws when sessiond is absent and autostart is disabled', async () => {
    const paths = await setup();
    await expect(
      ensureSessiond({
        socketPath: paths.socket,
        sessionDir: paths.sessions,
        idleTimeoutSeconds: 60,
        autostart: false,
      }),
    ).rejects.toThrow(/sessiond is not running/);
  });

  it('spawns a daemon when autostart is enabled and connects to it', async () => {
    const paths = await setup();
    const ensured = await ensureSessiond({
      socketPath: paths.socket,
      sessionDir: paths.sessions,
      idleTimeoutSeconds: 60,
      autostart: true,
      spawnDaemon: () => {
        void SessiondDaemon.start({
          socketPath: paths.socket,
          sessionDir: paths.sessions,
          idleTimeoutMs: 0,
        }).then((daemon) => {
          daemons.push(daemon);
        });
      },
    });
    try {
      expect(ensured.started).toBe(true);
      const status = await ensured.client.status();
      expect(status.socket).toBe(paths.socket);
      expect(status.connectionCount).toBe(1);
    } finally {
      ensured.client.close();
    }
  });

  it.each([false, true])('replaces an outdated daemon (methods advertised: %s) and its /clear path works again', async (advertiseMethods) => {
    const paths = await setup();
    const outdated = await startOutdatedDaemon(paths.socket, { advertiseMethods });
    const ensured = await ensureSessiond({
      socketPath: paths.socket,
      sessionDir: paths.sessions,
      idleTimeoutSeconds: 60,
      autostart: true,
      spawnDaemon: () => {
        void SessiondDaemon.start({
          socketPath: paths.socket,
          sessionDir: paths.sessions,
          idleTimeoutMs: 0,
        }).then((daemon) => {
          daemons.push(daemon);
        });
      },
    });
    try {
      expect(ensured.started).toBe(true);
      expect(ensured.replacedStale).toBe(true);
      expect(outdated.shutdownCalls).toBe(1);
      expect(ensured.client.supports('session.clear')).toBe(true);
      expect(ensured.client.cwdIsolation).toBe(true);
      expect(ensured.client.readableWorkspaces).toBe(true);

      const store = new SessiondStore({ client: ensured.client });
      const handle = await store.createSession({
        cwd: '/work/repo',
        model: 'model-a',
        cliVersion: '0.1.0',
      });
      await handle.append({ type: 'user.message', text: 'before clear' });
      await handle.clear();
      const events = await handle.replay();
      expect(events.map((event) => event.type)).toEqual(['session.start']);
      await handle.close();
    } finally {
      ensured.client.close();
      await outdated.close();
    }
  });

  it('refuses to replace an outdated daemon that still holds session leases', async () => {
    const paths = await setup();
    const outdated = await startOutdatedDaemon(paths.socket, { busy: true });
    try {
      await expect(
        ensureSessiond({
          socketPath: paths.socket,
          sessionDir: paths.sessions,
          idleTimeoutSeconds: 60,
          autostart: true,
        }),
      ).rejects.toThrow(/older build[\s\S]*session leases/);
      expect(outdated.shutdownCalls).toBe(1);
    } finally {
      await outdated.close();
    }
  });
});
