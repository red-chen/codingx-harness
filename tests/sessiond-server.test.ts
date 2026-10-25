import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EmbeddedSessionStore } from '../src/session/index.js';
import {
  JsonRpcPeer,
  SessiondRegistry,
  SessiondServer,
  type JsonRpcNotification,
} from '../src/sessiond/index.js';

let root: string;
let store: EmbeddedSessionStore;
let registry: SessiondRegistry;
let server: SessiondServer;
const peers: JsonRpcPeer[] = [];
const sockets: Socket[] = [];

interface Client {
  peer: JsonRpcPeer;
  notifications: JsonRpcNotification[];
}

async function connectClient(socketPath: string): Promise<Client> {
  const socket = connect(socketPath);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  const notifications: JsonRpcNotification[] = [];
  const peer = new JsonRpcPeer({
    stream: socket,
    onNotification: (message) => notifications.push(message),
  });
  peers.push(peer);
  return { peer, notifications };
}

async function initialize(client: Client, protocol = 1): Promise<unknown> {
  return client.peer.request('initialize', {
    protocol,
    client: { name: 'test-cli', version: '0.1.0' },
  });
}

const createParams = {
  cwd: '/work/repo',
  model: 'model-a',
  provider: 'primary',
  cliVersion: '0.1.0',
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codingx-sessiond-'));
  store = new EmbeddedSessionStore({ directory: path.join(root, 'sessions') });
  registry = new SessiondRegistry({ store });
  server = new SessiondServer({
    registry,
    socketPath: path.join(root, 'run', 'sessiond.sock'),
    version: 'test-version',
  });
  await server.listen();
});

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
  for (const socket of sockets.splice(0)) socket.destroy();
  await server.close().catch(() => undefined);
  await registry.shutdown(true).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe('SessiondServer', () => {
  it('handshakes, reports status and serves session create/append/replay/list/get', async () => {
    const client = await connectClient(server.address);
    const initialized = await initialize(client);
    expect(initialized).toMatchObject({
      protocol: 1,
      version: 'test-version',
      pid: process.pid,
      sessionCount: 0,
    });

    const status = await client.peer.request('daemon.status');
    expect(status).toMatchObject({
      socket: server.address,
      protocol: 1,
      version: 'test-version',
      sessionCount: 0,
      connectionCount: 1,
    });

    const created = (await client.peer.request('session.create', createParams)) as {
      sessionId: string;
      leaseId: string;
      lastSeq: number;
    };
    expect(created.lastSeq).toBe(1);

    const append = await client.peer.request('session.append', {
      sessionId: created.sessionId,
      leaseId: created.leaseId,
      events: [{ type: 'user.message', text: 'through the socket' }],
    });
    expect(append).toMatchObject({ lastSeq: 2 });

    const replay = (await client.peer.request('session.replay', { sessionId: created.sessionId })) as {
      events: Array<{ type: string }>;
    };
    expect(replay.events.map((event) => event.type)).toEqual(['session.start', 'user.message']);

    const listed = (await client.peer.request('session.list', { limit: 10 })) as {
      sessions: Array<{ id: string; writer?: string; clients: number }>;
    };
    expect(listed.sessions[0]).toMatchObject({ id: created.sessionId, writer: created.leaseId ? expect.any(String) : undefined, clients: 1 });

    const got = (await client.peer.request('session.get', { sessionId: created.sessionId })) as {
      session: { id: string };
      lease?: { clientId: string };
      lastSeq: number;
    };
    expect(got.session.id).toBe(created.sessionId);
    expect(got.lease?.clientId).toBeTruthy();
    expect(got.lastSeq).toBe(2);

    const afterStatus = (await client.peer.request('daemon.status')) as { sessionCount: number };
    expect(afterStatus.sessionCount).toBe(1);
  });

  it('requires initialize and rejects a protocol mismatch', async () => {
    const uninitialized = await connectClient(server.address);
    await expect(uninitialized.peer.request('daemon.status')).rejects.toMatchObject({
      kind: 'PROTOCOL_MISMATCH',
    });

    const mismatch = await connectClient(server.address);
    await expect(initialize(mismatch, 2)).rejects.toMatchObject({
      kind: 'PROTOCOL_MISMATCH',
      code: -32001,
    });
  });

  it('supports observe clients, heartbeat and session.end over the socket', async () => {
    const writer = await connectClient(server.address);
    await initialize(writer);
    const observer = await connectClient(server.address);
    await initialize(observer);

    const created = (await writer.peer.request('session.create', createParams)) as {
      sessionId: string;
      leaseId: string;
    };
    const observed = await observer.peer.request('session.attach', {
      sessionId: created.sessionId,
      mode: 'observe',
    });
    expect(observed).toMatchObject({ mode: 'observe', lastSeq: 1 });

    const heartbeat = await writer.peer.request('session.heartbeat', {
      sessionId: created.sessionId,
      leaseId: created.leaseId,
    });
    expect(heartbeat).toMatchObject({ ok: true });

    await expect(
      observer.peer.request('session.attach', { sessionId: created.sessionId, mode: 'write' }),
    ).rejects.toMatchObject({ kind: 'SESSION_BUSY' });

    await writer.peer.request('session.append', {
      sessionId: created.sessionId,
      leaseId: created.leaseId,
      events: [{ type: 'user.message', text: 'done' }],
    });
    await writer.peer.request('session.end', {
      sessionId: created.sessionId,
      leaseId: created.leaseId,
      reason: 'done',
    });
    const got = (await writer.peer.request('session.get', { sessionId: created.sessionId })) as {
      session: { status: string };
    };
    expect(got.session.status).toBe('ended');
  });

  it('streams session.event notifications to subscribers', async () => {
    const writer = await connectClient(server.address);
    await initialize(writer);
    const observer = await connectClient(server.address);
    await initialize(observer);

    const created = (await writer.peer.request('session.create', createParams)) as {
      sessionId: string;
      leaseId: string;
    };
    const subscribed = await observer.peer.request('session.subscribe', {
      sessionId: created.sessionId,
      fromSeq: 1,
    });
    expect(subscribed).toMatchObject({ sessionId: created.sessionId, fromSeq: 1 });

    await writer.peer.request('session.append', {
      sessionId: created.sessionId,
      leaseId: created.leaseId,
      events: [{ type: 'user.message', text: 'notify me' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const eventNotes = observer.notifications.filter((note) => note.method === 'session.event');
    expect(eventNotes.length).toBeGreaterThan(0);
    const notifiedEvents = eventNotes.flatMap(
      (note) => (note.params as { events: Array<{ text?: string }> }).events,
    );
    expect(notifiedEvents.some((event) => event.text === 'notify me')).toBe(true);
  });

  it('forks through the daemon and returns the new lease', async () => {
    const client = await connectClient(server.address);
    await initialize(client);
    const source = (await client.peer.request('session.create', createParams)) as {
      sessionId: string;
      leaseId: string;
    };
    await client.peer.request('session.append', {
      sessionId: source.sessionId,
      leaseId: source.leaseId,
      events: [
        { type: 'user.message', text: 'base' },
        { type: 'turn.start', turnId: 't1' },
        { type: 'turn.end', turnId: 't1', status: 'done' },
      ],
    });
    await client.peer.request('session.detach', {
      sessionId: source.sessionId,
      leaseId: source.leaseId,
    });

    const fork = (await client.peer.request('session.fork', {
      sessionId: source.sessionId,
      cliVersion: '0.1.0',
    })) as { sessionId: string; leaseId: string; lastSeq: number };
    expect(fork.sessionId).not.toBe(source.sessionId);
    expect(fork.leaseId).toBeTruthy();
    const replay = (await client.peer.request('session.replay', { sessionId: fork.sessionId })) as {
      events: Array<{ type: string; text?: string }>;
    };
    expect(replay.events[0]).toMatchObject({ type: 'session.start', forkedFrom: source.sessionId });
    expect(replay.events.some((event) => event.text === 'base')).toBe(true);
  });
});
