import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, appendFile, chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EmbeddedSessionStore,
  deriveSessionStatus,
  readRollout,
  type RolloutEvent,
} from '../src/session/index.js';

let root: string;
let directory: string;
let store: EmbeddedSessionStore;

const createOptions = {
  cwd: '/work/repo',
  model: 'model-a',
  provider: 'primary',
  cliVersion: '0.1.0',
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codingx-session-'));
  directory = path.join(root, 'sessions');
  store = new EmbeddedSessionStore({ directory });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function event(type: string, extra: Record<string, unknown> = {}): RolloutEvent {
  return { seq: 1, ts: new Date().toISOString(), type, eventId: type, ...extra };
}

describe('EmbeddedSessionStore lifecycle', () => {
  it('creates a 0600 JSONL rollout under a 0700 directory and appends monotonic events', async () => {
    const handle = await store.createSession(createOptions);
    const info = await stat(handle.filePath);
    expect(info.mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(path.basename(handle.filePath)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-z]{12})[.]jsonl$/,
    );
    expect(handle.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(handle.meta).toMatchObject({ ...createOptions, id: handle.id });

    const initial = await handle.replay();
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({
      seq: 1,
      type: 'session.start',
      cwd: createOptions.cwd,
      model: createOptions.model,
      provider: createOptions.provider,
      cliVersion: createOptions.cliVersion,
    });

    const written = await handle.append([
      { type: 'user.message', text: 'hello' },
      { type: 'turn.start', turnId: 't1' },
    ]);
    expect(written.map((item) => item.seq)).toEqual([2, 3]);
    const replay = await handle.replay({ fromSeq: 2 });
    expect(replay.map((item) => item.type)).toEqual(['user.message', 'turn.start']);

    const end = await handle.end('done');
    expect(end.type).toBe('session.end');
    expect(end.seq).toBe(4);
    await expect(handle.append({ type: 'user.message', text: 'too late' })).rejects.toThrow(/ended/);
    await handle.close();
    await expect(access(handle.filePath + '.lock')).rejects.toThrow();

    const summaries = await store.listSessions();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id: handle.id, status: 'ended', eventCount: 4 });
  });

  it('deduplicates eventId retries and keeps one file line', async () => {
    const handle = await store.createSession(createOptions);
    const first = await handle.append({ type: 'user.message', text: 'hi', eventId: 'fixed-id' });
    const second = await handle.append({ type: 'user.message', text: 'hi', eventId: 'fixed-id' });
    expect(second).toEqual(first);
    const third = await handle.append({ type: 'user.message', text: 'next' });
    expect(third[0]?.seq).toBe(3);
    const all = await handle.replay();
    expect(all).toHaveLength(3);
    const lines = (await readFile(handle.filePath, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    await handle.close();
  });

  it('redacts credentials before writing and keeps the input unchanged', async () => {
    const handle = await store.createSession(createOptions);
    const secret = 'API_KEY=supersecretvalue123';
    const input = { type: 'user.message', text: secret };
    const [written] = await handle.append(input);
    expect(written).toMatchObject({ redacted: true });
    expect(String(written?.text)).toBe('API_KEY=[REDACTED:secret]');
    expect(input.text).toBe(secret);
    const raw = await readFile(handle.filePath, 'utf8');
    expect(raw).not.toContain('supersecretvalue123');
    await handle.close();
  });

  it('allows the authority path to append reserved events', async () => {
    const handle = await store.createSession(createOptions);
    expect(handle.appendSystem).toBeDefined();
    const events = await handle.appendSystem?.([
      { type: 'session.interrupted', reason: 'test' },
      { type: 'session.resumed' },
    ]);
    if (!events) throw new Error('appendSystem missing');
    expect(events.map((event) => event.type)).toEqual(['session.interrupted', 'session.resumed']);
    await handle.close();
  });

  it('rejects reserved event types and oversized events', async () => {
    const handle = await store.createSession(createOptions);
    await expect(handle.append({ type: 'session.start' })).rejects.toThrow(/reserved/);
    await expect(handle.append({ type: 'session.end' })).rejects.toThrow(/reserved/);
    await expect(handle.append({ type: 'session.interrupted' })).rejects.toThrow(/reserved/);
    await expect(handle.append({ type: 'user.message', text: 'x'.repeat(1024 * 1024 + 10) })).rejects.toThrow(
      /1 MiB/,
    );
    const events = await handle.replay();
    expect(events).toHaveLength(1);
    await handle.close();
  });

  it('continues the sequence after reopening a session', async () => {
    const first = await store.createSession(createOptions);
    await first.append({ type: 'user.message', text: 'one' });
    const id = first.id;
    await first.close();

    const resumed = await store.attachSession(id, 'write');
    expect(resumed.meta.id).toBe(id);
    const [next] = await resumed.append({ type: 'assistant.message', text: 'two' });
    expect(next?.seq).toBe(3);
    await resumed.close();

    const readOnly = await store.attachSession(id, 'read');
    expect(readOnly.writable).toBe(false);
    await expect(readOnly.append({ type: 'user.message', text: 'nope' })).rejects.toThrow(/read-only/);
    await expect(readOnly.end()).rejects.toThrow(/read-only/);
    await readOnly.close();
  });

  it('clears the rollout to a fresh header and restarts the sequence', async () => {
    const handle = await store.createSession(createOptions);
    await handle.append([
      { type: 'user.message', text: 'conversation secret' },
      { type: 'turn.start', turnId: 't1' },
      { type: 'turn.end', turnId: 't1', status: 'done' },
    ]);
    const before = (await handle.replay())[0];
    expect(before?.type).toBe('session.start');

    await handle.clear();

    const events = await handle.replay();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      seq: 1,
      type: 'session.start',
      cwd: createOptions.cwd,
      model: createOptions.model,
      provider: createOptions.provider,
      cliVersion: createOptions.cliVersion,
      createdAt: before?.createdAt,
    });
    expect(events[0]?.eventId).not.toBe(before?.eventId);
    const raw = await readFile(handle.filePath, 'utf8');
    expect(raw).not.toContain('conversation secret');
    expect(raw.trimEnd().split('\n')).toHaveLength(1);
    expect((await store.listSessions())[0]).toMatchObject({ status: 'idle', eventCount: 1 });

    const [next] = await handle.append({ type: 'user.message', text: 'after clear' });
    expect(next?.seq).toBe(2);
    await handle.close();
  });

  it('clears a reopened (append-mode) session without leaving a sparse hole', async () => {
    const first = await store.createSession(createOptions);
    await first.append({ type: 'user.message', text: 'before reopen' });
    const id = first.id;
    await first.close();

    const resumed = await store.attachSession(id, 'write');
    await resumed.clear();
    const raw = await readFile(resumed.filePath, 'utf8');
    expect(raw.startsWith('{"seq":1')).toBe(true);
    expect(raw).not.toContain('\u0000');
    expect(raw).not.toContain('before reopen');
    const [next] = await resumed.append({ type: 'user.message', text: 'after reopen clear' });
    expect(next?.seq).toBe(2);
    await resumed.close();
  });

  it('rejects clear on read-only and ended handles', async () => {
    const handle = await store.createSession(createOptions);
    const readOnly = await store.attachSession(handle.id, 'read');
    await expect(readOnly.clear()).rejects.toThrow(/read-only/);
    await readOnly.close();
    await handle.end();
    await expect(handle.clear()).rejects.toThrow(/ended/);
    await handle.close();
  });

  it('enforces a single writer and recovers stale locks', async () => {
    const handle = await store.createSession(createOptions);
    await expect(store.attachSession(handle.id, 'write')).rejects.toThrow(/already locked/);
    await handle.close();

    const reopened = await store.attachSession(handle.id, 'write');
    await reopened.close();

    const filePath = await store.resolveFilePath(handle.id);
    await writeFile(
      filePath + '.lock',
      JSON.stringify({ pid: 999_999, token: 'stale', createdAt: new Date(0).toISOString() }),
    );
    const afterStale = await store.attachSession(handle.id, 'write');
    await afterStale.append({ type: 'user.message', text: 'after stale' });
    await afterStale.close();
  });

  it('recovers from an incomplete trailing line and rejects corrupt complete lines', async () => {
    const handle = await store.createSession(createOptions);
    await handle.append({ type: 'user.message', text: 'before crash' });
    await handle.close();

    const filePath = await store.resolveFilePath(handle.id);
    await appendFile(filePath, '{"seq":99,"type":"turn.sta');
    expect((await store.replaySession(handle.id)).map((item) => item.type)).toEqual([
      'session.start',
      'user.message',
    ]);

    const resumed = await store.attachSession(handle.id, 'write');
    const [next] = await resumed.append({ type: 'assistant.message', text: 'recovered' });
    expect(next?.seq).toBe(3);
    await resumed.close();

    await appendFile(filePath, 'not json\n');
    await expect(store.replaySession(handle.id)).rejects.toThrow(/Corrupt rollout/);
  });

  it('lists sessions, resolves prefixes, and supports read-only replay', async () => {
    const a = await store.createSession(createOptions);
    await a.append({ type: 'turn.start', turnId: 't1' });
    await a.append({ type: 'turn.status', status: 'awaiting_approval' });
    let listed = await store.listSessions();
    expect(listed[0]?.status).toBe('awaiting_approval');
    await a.append({ type: 'turn.end', turnId: 't1' });
    await a.end();
    const b = await store.createSession({ ...createOptions, model: 'model-b' });
    await b.close();

    listed = await store.listSessions();
    expect(listed).toHaveLength(2);
    expect(new Set(listed.map((item) => item.id))).toEqual(new Set([a.id, b.id]));

    const replay = await store.replaySession(a.id.slice(0, 6));
    expect(replay[0]?.type).toBe('session.start');
    await expect(store.replaySession('zzzzzzzzzzzz')).rejects.toThrow(/No session/);

    const read = await store.attachSession(b.id.slice(0, 6), 'read');
    expect(read.id).toBe(b.id);
    await read.close();
  });

  it('refuses to reopen an ended session for writing', async () => {
    const handle = await store.createSession(createOptions);
    await handle.end();
    await handle.close();
    await expect(store.attachSession(handle.id, 'write')).rejects.toThrow(/ended/);
  });

  it('returns an empty list for a missing session directory', async () => {
    const missing = new EmbeddedSessionStore({ directory: path.join(root, 'missing') });
    expect(await missing.listSessions()).toEqual([]);
  });
});

describe('deriveSessionStatus', () => {
  it('derives states from lifecycle events', () => {
    expect(deriveSessionStatus([event('session.start')])).toBe('idle');
    expect(deriveSessionStatus([event('turn.start')])).toBe('running');
    expect(deriveSessionStatus([event('turn.start'), event('turn.status', { status: 'awaiting_approval' })])).toBe(
      'awaiting_approval',
    );
    expect(deriveSessionStatus([event('turn.start'), event('turn.end')])).toBe('idle');
    expect(deriveSessionStatus([event('session.interrupted')])).toBe('interrupted');
    expect(deriveSessionStatus([event('session.interrupted'), event('session.resumed')])).toBe('idle');
    expect(deriveSessionStatus([event('turn.start'), event('session.end')])).toBe('ended');
  });
});

describe('readRollout', () => {
  it('leaves an incomplete tail unread but accepts a complete final line', async () => {
    const file = path.join(root, 'manual.jsonl');
    await writeFile(
      file,
      JSON.stringify({ ...event('session.start'), seq: 1 }) +
        '\n' +
        JSON.stringify({ ...event('user.message'), seq: 2 }) +
        '\npartial',
    );
    const events = await readRollout(file);
    expect(events).toHaveLength(2);
  });

  it('rejects invalid envelopes', async () => {
    const file = path.join(root, 'bad.jsonl');
    await writeFile(file, JSON.stringify({ seq: 1, type: 'x', ts: 'now', eventId: 'e' }) + '\n');
    await expect(readRollout(file)).resolves.toHaveLength(1);
    await chmod(file, 0o600);
    await writeFile(file, JSON.stringify({ seq: 0, type: 'x', ts: 'now', eventId: 'e' }) + '\n');
    await expect(readRollout(file)).rejects.toThrow(/invalid seq/);
  });
});