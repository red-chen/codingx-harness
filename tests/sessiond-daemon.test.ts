import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureSessiond } from '../src/session/index.js';
import { SessiondDaemon } from '../src/sessiond/index.js';

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
});
