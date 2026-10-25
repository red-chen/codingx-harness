import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EmbeddedSessionStore } from '../src/session/index.js';
import {
  SessiondRegistry,
  type RegistryNotification,
} from '../src/sessiond/index.js';

let root: string;
let directory: string;
let store: EmbeddedSessionStore;
let registry: SessiondRegistry;

const createParams = {
  cwd: '/work/repo',
  model: 'model-a',
  provider: 'primary',
  cliVersion: '0.1.0',
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function paramsOf(message: RegistryNotification): Record<string, unknown> {
  return (message.params ?? {}) as Record<string, unknown>;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codingx-registry-'));
  directory = path.join(root, 'sessions');
  store = new EmbeddedSessionStore({ directory });
  registry = new SessiondRegistry({ store, leaseTtlMs: 2_000 });
});

afterEach(async () => {
  await registry.shutdown(true).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe('SessiondRegistry sessions and leases', () => {
  it('creates, appends, replays, observes and reports sessions', async () => {
    const created = await registry.create('client-a', createParams);
    expect(created.lastSeq).toBe(1);
    const appended = await registry.append('client-a', {
      sessionId: created.sessionId,
      leaseId: created.leaseId,
      events: [{ type: 'user.message', text: 'hello' }],
    });
    expect(appended.lastSeq).toBe(2);
    expect(appended.appended).toHaveLength(1);

    const replay = await registry.replay({ sessionId: created.sessionId });
    expect(replay.events.map((event) => event.type)).toEqual(['session.start', 'user.message']);
    expect(replay.hasMore).toBe(false);

    const observe = await registry.attach('client-b', { sessionId: created.sessionId, mode: 'observe' });
    expect(observe).toMatchObject({ mode: 'observe', status: 'idle', lastSeq: 2 });

    const got = await registry.get(created.sessionId);
    expect(got.session).toMatchObject({ id: created.sessionId, clients: 2, writer: 'client-a' });
    expect(got.lease).toMatchObject({ clientId: 'client-a', mode: 'write' });

    const listed = await registry.list();
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({ clients: 2, writer: 'client-a' });

    await expect(
      registry.attach('client-b', { sessionId: created.sessionId, mode: 'write' }),
    ).rejects.toMatchObject({ kind: 'SESSION_BUSY' });
    await expect(
      registry.append('client-b', { sessionId: created.sessionId, leaseId: created.leaseId, events: [] }),
    ).rejects.toMatchObject({ kind: 'LEASE_REVOKED' });
  });

  it('expires leases, revokes the lease and lets another client attach', async () => {
    const short = new SessiondRegistry({ store, leaseTtlMs: 60 });
    try {
      const created = await short.create('client-a', createParams);
      const notes: RegistryNotification[] = [];
      await short.subscribe('client-b', { sessionId: created.sessionId }, (message) => notes.push(message));

      await wait(120);
      expect(notes.some((note) => note.method === 'session.lease_revoked')).toBe(true);
      await expect(
        short.append('client-a', {
          sessionId: created.sessionId,
          leaseId: created.leaseId,
          events: [{ type: 'user.message', text: 'late' }],
        }),
      ).rejects.toMatchObject({ kind: 'LEASE_REVOKED' });

      const reattached = await short.attach('client-b', { sessionId: created.sessionId, mode: 'write' });
      expect(reattached.mode).toBe('write');
      expect(reattached.leaseId).toBeTruthy();
    } finally {
      await short.shutdown(true).catch(() => undefined);
    }
  });

  it('renews a lease on heartbeat', async () => {
    const short = new SessiondRegistry({ store, leaseTtlMs: 120 });
    try {
      const created = await short.create('client-a', createParams);
      await wait(70);
      const heartbeat = await short.heartbeat('client-a', {
        sessionId: created.sessionId,
        leaseId: created.leaseId,
      });
      expect(heartbeat.ok).toBe(true);
      await wait(70);
      const appended = await short.append('client-a', {
        sessionId: created.sessionId,
        leaseId: created.leaseId,
        events: [{ type: 'user.message', text: 'still alive' }],
      });
      expect(appended.lastSeq).toBe(2);
    } finally {
      await short.shutdown(true).catch(() => undefined);
    }
  });

  it('marks an active turn interrupted on client disconnect and resumed on attach', async () => {
    const created = await registry.create('client-a', createParams);
    await registry.append('client-a', {
      sessionId: created.sessionId,
      leaseId: created.leaseId,
      events: [{ type: 'turn.start', turnId: 't1' }],
    });
    const notes: RegistryNotification[] = [];
    await registry.subscribe('client-b', { sessionId: created.sessionId }, (message) => notes.push(message));

    await registry.disconnectClient('client-a');
    const interrupted = await registry.get(created.sessionId);
    expect(interrupted.session.status).toBe('interrupted');
    expect(notes.some((note) => note.method === 'session.lease_revoked')).toBe(true);

    const resumed = await registry.attach('client-b', { sessionId: created.sessionId, mode: 'write' });
    expect(resumed.status).toBe('idle');
    const events = await registry.replay({ sessionId: created.sessionId });
    expect(events.events.some((event) => event.type === 'session.interrupted')).toBe(true);
    expect(events.events.some((event) => event.type === 'session.resumed')).toBe(true);
  });

  it('does not mark an idle session interrupted on clean detach', async () => {
    const created = await registry.create('client-a', createParams);
    await registry.append('client-a', {
      sessionId: created.sessionId,
      leaseId: created.leaseId,
      events: [{ type: 'user.message', text: 'done' }],
    });
    await registry.detach('client-a', created.sessionId, created.leaseId);
    const events = await registry.replay({ sessionId: created.sessionId });
    expect(events.events.some((event) => event.type === 'session.interrupted')).toBe(false);

    const resumed = await registry.attach('client-b', { sessionId: created.sessionId, mode: 'write' });
    expect(resumed.status).toBe('idle');
  });

  it('clears a leased session back to its header and notifies subscribers', async () => {
    const created = await registry.create('client-a', createParams);
    await registry.append('client-a', {
      sessionId: created.sessionId,
      leaseId: created.leaseId,
      events: [{ type: 'user.message', text: 'old conversation' }],
    });
    const notes: RegistryNotification[] = [];
    await registry.subscribe('client-b', { sessionId: created.sessionId }, (message) => notes.push(message));

    const cleared = await registry.clear('client-a', {
      sessionId: created.sessionId,
      leaseId: created.leaseId,
    });
    expect(cleared).toEqual({ sessionId: created.sessionId, lastSeq: 1, eventCount: 1 });

    const replay = await registry.replay({ sessionId: created.sessionId });
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]).toMatchObject({ seq: 1, type: 'session.start' });
    expect(replay.events.some((event) => event.text === 'old conversation')).toBe(false);

    const got = await registry.get(created.sessionId);
    expect(got.session).toMatchObject({ status: 'idle', eventCount: 1 });
    expect(got.lastSeq).toBe(1);
    expect(notes.some((note) => note.method === 'session.cleared')).toBe(true);
    expect(paramsOf(notes.find((note) => note.method === 'session.cleared')!)).toMatchObject({
      sessionId: created.sessionId,
      lastSeq: 1,
      eventCount: 1,
    });

    await expect(registry.clear('client-b', { sessionId: created.sessionId })).rejects.toMatchObject({
      kind: 'LEASE_REVOKED',
    });
    const appended = await registry.append('client-a', {
      sessionId: created.sessionId,
      leaseId: created.leaseId,
      events: [{ type: 'user.message', text: 'after clear' }],
    });
    expect(appended.lastSeq).toBe(2);
  });

  it('refuses to clear a session with an active turn', async () => {
    const created = await registry.create('client-a', createParams);
    await registry.append('client-a', {
      sessionId: created.sessionId,
      leaseId: created.leaseId,
      events: [{ type: 'turn.start', turnId: 't1' }],
    });
    await expect(
      registry.clear('client-a', { sessionId: created.sessionId, leaseId: created.leaseId }),
    ).rejects.toMatchObject({ kind: 'SESSION_BUSY' });
  });

  it('broadcasts appended events and supports unsubscribe', async () => {
    const created = await registry.create('client-a', createParams);
    const notes: RegistryNotification[] = [];
    const subscription = await registry.subscribe(
      'client-b',
      { sessionId: created.sessionId },
      (message) => notes.push(message),
    );
    expect(subscription.backlog).toHaveLength(1);

    await registry.append('client-a', {
      sessionId: created.sessionId,
      leaseId: created.leaseId,
      events: [{ type: 'user.message', text: 'broadcast me' }],
    });
    const eventNote = notes.find((note) => note.method === 'session.event');
    expect(eventNote).toBeDefined();
    expect(paramsOf(eventNote!).events).toHaveLength(1);

    subscription.unsubscribe();
    const before = notes.length;
    await registry.append('client-a', {
      sessionId: created.sessionId,
      leaseId: created.leaseId,
      events: [{ type: 'user.message', text: 'silent' }],
    });
    expect(notes.length).toBe(before);
  });

  it('ends a session and rejects further writes', async () => {
    const created = await registry.create('client-a', createParams);
    await registry.append('client-a', {
      sessionId: created.sessionId,
      leaseId: created.leaseId,
      events: [{ type: 'user.message', text: 'bye' }],
    });
    await registry.end('client-a', { sessionId: created.sessionId, leaseId: created.leaseId, reason: 'done' });

    const got = await registry.get(created.sessionId);
    expect(got.session.status).toBe('ended');
    await expect(
      registry.attach('client-b', { sessionId: created.sessionId, mode: 'write' }),
    ).rejects.toMatchObject({ kind: 'SESSION_BUSY' });
    await expect(
      registry.append('client-a', { sessionId: created.sessionId, events: [{ type: 'user.message', text: 'x' }] }),
    ).rejects.toMatchObject({ kind: 'LEASE_REVOKED' });
  });

  it('forks an idle, unleased session into a new leased session', async () => {
    const source = await registry.create('client-a', createParams);
    await registry.append('client-a', {
      sessionId: source.sessionId,
      leaseId: source.leaseId,
      events: [
        { type: 'user.message', text: 'source prompt' },
        { type: 'turn.start', turnId: 't1' },
        { type: 'turn.end', turnId: 't1', status: 'done' },
      ],
    });
    await expect(
      registry.fork('client-b', { sessionId: source.sessionId, cliVersion: '0.1.0' }),
    ).rejects.toMatchObject({ kind: 'SESSION_BUSY' });

    await registry.detach('client-a', source.sessionId, source.leaseId);
    const fork = await registry.fork('client-b', { sessionId: source.sessionId, cliVersion: '0.1.0' });
    expect(fork.sessionId).not.toBe(source.sessionId);
    expect(fork.leaseId).toBeTruthy();
    const forkEvents = await registry.replay({ sessionId: fork.sessionId });
    expect(forkEvents.events[0]).toMatchObject({ type: 'session.start', forkedFrom: source.sessionId });
    expect(forkEvents.events.some((event) => event.text === 'source prompt')).toBe(true);
    const sourceEvents = await registry.replay({ sessionId: source.sessionId });
    expect(sourceEvents.events.some((event) => event.type === 'session.end')).toBe(false);
  });

  it('paginates and filters the session list', async () => {
    const a = await registry.create('client-a', createParams);
    const b = await registry.create('client-a', { ...createParams, cwd: '/work/other' });
    const page = await registry.list({ limit: 1 });
    expect(page.sessions).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const next = await registry.list({ limit: 1, cursor: page.nextCursor });
    expect(next.sessions).toHaveLength(1);
    expect(next.sessions[0]?.id).not.toBe(page.sessions[0]?.id);

    const filtered = await registry.list({ cwd: '/work/other' });
    expect(filtered.sessions).toHaveLength(1);
    expect(filtered.sessions[0]?.id).toBe(b.sessionId);
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('prunes old ended sessions but leaves active sessions alone', async () => {
    const ended = await registry.create('client-a', createParams);
    await registry.append('client-a', {
      sessionId: ended.sessionId,
      leaseId: ended.leaseId,
      events: [{ type: 'user.message', text: 'old ended' }],
    });
    await registry.end('client-a', { sessionId: ended.sessionId, leaseId: ended.leaseId, reason: 'done' });

    const active = await registry.create('client-b', createParams);
    await registry.append('client-b', {
      sessionId: active.sessionId,
      leaseId: active.leaseId,
      events: [{ type: 'user.message', text: 'still open' }],
    });

    const dry = await registry.prune({ olderThanDays: 0, dryRun: true });
    expect(dry.pruned).toContain(ended.sessionId);
    expect(dry.pruned).not.toContain(active.sessionId);
    expect(dry.skipped).toBeGreaterThanOrEqual(1);
    const endedReplay = await registry.replay({ sessionId: ended.sessionId });
    expect(endedReplay.events.length).toBeGreaterThan(0);

    const pruned = await registry.prune({ olderThanDays: 0 });
    expect(pruned.pruned).toContain(ended.sessionId);
    const listed = await registry.list({ limit: 10 });
    expect(listed.sessions.map((session) => session.id)).not.toContain(ended.sessionId);
    expect(listed.sessions.map((session) => session.id)).toContain(active.sessionId);
    await expect(registry.replay({ sessionId: ended.sessionId })).rejects.toThrow();
  });

  it('rejects shutdown with active leases unless forced', async () => {
    await registry.create('client-a', createParams);
    await expect(registry.shutdown()).rejects.toMatchObject({ kind: 'SESSION_BUSY' });
    await registry.shutdown(true);
    await expect(registry.create('client-b', createParams)).rejects.toMatchObject({ kind: 'INTERNAL' });
  });
});

describe('SessiondRegistry recovery', () => {
  it('marks unfinished sessions interrupted and resumes them on attach', async () => {
    const recoveryStore = new EmbeddedSessionStore({ directory: path.join(root, 'recovery') });
    const raw = await recoveryStore.createSession({
      cwd: '/work/repo',
      model: 'model-a',
      cliVersion: '0.1.0',
    });
    await raw.append({ type: 'turn.start', turnId: 't1' });
    await raw.close();

    const recovered = new SessiondRegistry({ store: recoveryStore });
    try {
      expect(await recovered.recover()).toBe(1);
      const listed = await recovered.list();
      expect(listed.sessions[0]?.status).toBe('interrupted');

      const attached = await recovered.attach('client-a', { sessionId: raw.id, mode: 'write' });
      expect(attached.status).toBe('idle');
      const events = await recovered.replay({ sessionId: raw.id });
      expect(events.events.some((event) => event.type === 'session.interrupted')).toBe(true);
      expect(events.events.some((event) => event.type === 'session.resumed')).toBe(true);
    } finally {
      await recovered.shutdown(true).catch(() => undefined);
    }
  });
});