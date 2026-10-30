import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EmbeddedSessionStore,
  SessiondClient,
  SessiondStore,
} from '../src/session/index.js';
import {
  SessiondRegistry,
  SessiondServer,
  type JsonRpcNotification,
} from '../src/sessiond/index.js';

let root: string;
let store: EmbeddedSessionStore;
let registry: SessiondRegistry;
let server: SessiondServer;
let client: SessiondClient;
let remote: SessiondStore;
const extraClients: SessiondClient[] = [];

const createParams = {
  cwd: '/work/repo',
  model: 'model-a',
  provider: 'primary',
  cliVersion: '0.1.0',
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codingx-client-'));
  store = new EmbeddedSessionStore({ directory: path.join(root, 'sessions') });
  registry = new SessiondRegistry({ store, leaseTtlMs: 200 });
  server = new SessiondServer({
    registry,
    socketPath: path.join(root, 'run', 'sessiond.sock'),
    version: 'test-version',
  });
  await server.listen();
  client = await SessiondClient.connect({ socketPath: server.address });
  remote = new SessiondStore({ client, heartbeatIntervalMs: 50 });
});

afterEach(async () => {
  await remote.close().catch(() => undefined);
  for (const extra of extraClients.splice(0)) extra.close();
  client.close();
  await server.close().catch(() => undefined);
  await registry.shutdown(true).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe('SessiondClient', () => {
  it('scopes list, lookup, mutation and prune to the connection cwd', async () => {
    const cwd = path.join(root, 'repo');
    const nested = path.join(cwd, 'nested');
    await mkdir(nested, { recursive: true });
    const alias = path.join(root, 'alias');
    await symlink(cwd, alias);
    const first = await store.createSession({ ...createParams, cwd });
    const second = await store.createSession({ ...createParams, cwd: nested });
    await first.close();
    await second.close();
    const scoped = await SessiondClient.connect({ socketPath: server.address, cwd: alias });
    extraClients.push(scoped);
    expect(scoped.cwdIsolation).toBe(true);
    expect((await scoped.list({ cwd: nested })).sessions.map((item) => item.id)).toEqual([first.id]);
    expect((await scoped.get(first.id.slice(0, 8))).session.id).toBe(first.id);
    await expect(scoped.get(second.id)).rejects.toMatchObject({ kind: 'SESSION_NOT_FOUND' });
    await expect(scoped.attach({ sessionId: second.id, mode: 'write' })).rejects.toMatchObject({ kind: 'SESSION_NOT_FOUND' });
    await expect(scoped.replay({ sessionId: second.id })).rejects.toMatchObject({ kind: 'SESSION_NOT_FOUND' });
    await expect(scoped.fork({ sessionId: second.id })).rejects.toMatchObject({ kind: 'SESSION_NOT_FOUND' });
    await expect(scoped.clear({ sessionId: second.id })).rejects.toMatchObject({ kind: 'SESSION_NOT_FOUND' });
    await expect(scoped.create({ ...createParams, cwd: nested })).rejects.toMatchObject({ kind: 'INVALID_PARAMS' });
    expect((await scoped.prune({ olderThanDays: 0, cwd: nested })).pruned).toEqual([first.id]);
    expect((await store.listSessions()).map((item) => item.id)).toEqual([second.id]);
  });

  it('handshakes and exposes daemon status', async () => {
    const status = await client.status();
    expect(status).toMatchObject({
      socket: server.address,
      protocol: 1,
      version: 'test-version',
      sessionCount: 0,
      connectionCount: 1,
    });
  });

  it('records the methods advertised during initialize', () => {
    expect(client.supports('session.clear')).toBe(true);
    expect(client.supports('session.fork')).toBe(true);
    expect(client.missingMethods(['session.clear', 'session.fork'])).toEqual([]);
    expect(client.supports('session.does_not_exist')).toBe(false);
  });

  it('receives session.event notifications through subscribe', async () => {
    const created = await remote.createSession(createParams);
    const notes: JsonRpcNotification[] = [];
    const subscription = await client.subscribe(
      { sessionId: created.id, fromSeq: 1 },
      (message) => notes.push(message),
    );
    expect(subscription.sessionId).toBe(created.id);
    await created.append({ type: 'user.message', text: 'hello subscription' });
    await wait(20);
    const events = notes
      .filter((note) => note.method === 'session.event')
      .flatMap((note) => (note.params as { events: Array<{ text?: string }> }).events);
    expect(events.some((event) => event.text === 'hello subscription')).toBe(true);
    subscription.unsubscribe();
    await created.close();
  });
});

describe('SessiondStore', () => {
  it('creates, appends, replays, lists and ends through the daemon', async () => {
    const handle = await remote.createSession(createParams);
    expect(handle.filePath).toContain(root);
    expect(handle.writable).toBe(true);
    const events = await handle.append({ type: 'user.message', text: 'remote' });
    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(2);

    const replay = await handle.replay();
    expect(replay.map((event) => event.type)).toEqual(['session.start', 'user.message']);
    const summaries = await remote.listSessions();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id: handle.id, status: 'idle', eventCount: 2 });

    const endEvent = await handle.end('done');
    expect(endEvent.type).toBe('session.end');
    await handle.close();
    const ended = await remote.listSessions();
    expect(ended[0]?.status).toBe('ended');
  });

  it('clears a session through the daemon and restarts at seq 2', async () => {
    const handle = await remote.createSession(createParams);
    await handle.append({ type: 'user.message', text: 'remote secret' });
    await handle.clear();

    const replay = await handle.replay();
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ seq: 1, type: 'session.start' });
    const summaries = await remote.listSessions();
    expect(summaries[0]).toMatchObject({ id: handle.id, status: 'idle', eventCount: 1 });

    const [next] = await handle.append({ type: 'user.message', text: 'after clear' });
    expect(next?.seq).toBe(2);
    await handle.close();
  });

  it('attaches a read-only observer and enforces the write lease across clients', async () => {
    const handle = await remote.createSession(createParams);
    const observer = await remote.attachSession(handle.id, 'read');
    expect(observer.writable).toBe(false);
    await expect(observer.append({ type: 'user.message', text: 'nope' })).rejects.toThrow(/read-only/);
    await observer.close();

    const secondClient = await SessiondClient.connect({ socketPath: server.address });
    extraClients.push(secondClient);
    const secondStore = new SessiondStore({ client: secondClient });
    try {
      await expect(secondStore.attachSession(handle.id, 'write')).rejects.toMatchObject({
        kind: 'SESSION_BUSY',
      });
    } finally {
      await secondStore.close();
    }
    await handle.close();
  });

  it('keeps the lease alive with heartbeats beyond its nominal TTL', async () => {
    const handle = await remote.createSession(createParams);
    await wait(350);
    const appended = await handle.append({ type: 'user.message', text: 'still leased' });
    expect(appended[0]?.seq).toBe(2);
    await handle.close();
  });

  it('forks a detached idle session and writes to the fork', async () => {
    const source = await remote.createSession(createParams);
    await source.append({ type: 'user.message', text: 'source' });
    await source.close();
    const fork = await remote.forkSession(source.id, { cliVersion: '0.1.0' });
    expect(fork.id).not.toBe(source.id);
    expect(fork.writable).toBe(true);
    await fork.append({ type: 'user.message', text: 'fork' });
    const events = await fork.replay();
    expect(events.some((event) => event.text === 'source')).toBe(true);
    expect(events.some((event) => event.text === 'fork')).toBe(true);
    await fork.close();
  });
});
