import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EmbeddedSessionStore, deriveSessionStatus } from '../src/session/index.js';
import type { SessionHandle } from '../src/session/index.js';
import { rebuildHistory } from '../src/agent/index.js';

let root: string;
let directory: string;
let store: EmbeddedSessionStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codingx-fork-'));
  directory = path.join(root, 'sessions');
  store = new EmbeddedSessionStore({ directory });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function createSource(): Promise<SessionHandle> {
  return store.createSession({
    cwd: '/work/source',
    model: 'source-model',
    provider: 'primary',
    cliVersion: '0.1.0',
  });
}

async function appendFirstTurn(session: SessionHandle): Promise<void> {
  await session.append({ type: 'user.message', text: 'first request' });
  await session.append({ type: 'turn.start', turnId: 'turn-1' });
  await session.append({
    type: 'assistant.message',
    turnId: 'turn-1',
    text: 'reading',
    calls: [{ id: 'call-1', name: 'read_file', input: { path: 'a.ts' } }],
  });
  await session.append({
    type: 'tool.call',
    turnId: 'turn-1',
    callId: 'call-1',
    name: 'read_file',
    input: { path: 'a.ts' },
  });
  await session.append({
    type: 'tool.result',
    turnId: 'turn-1',
    callId: 'call-1',
    name: 'read_file',
    content: 'line',
    isError: false,
  });
  await session.append({ type: 'assistant.message', turnId: 'turn-1', text: 'first answer', calls: [] });
  await session.append({ type: 'turn.end', turnId: 'turn-1', status: 'done' });
}

describe('EmbeddedSessionStore.forkSession', () => {
  it('copies events into a new session with forkedFrom and leaves the source unchanged', async () => {
    const source = await createSource();
    await appendFirstTurn(source);
    const sourceEventsBefore = await source.replay();
    await source.close();

    const fork = await store.forkSession(source.id.slice(0, 6), { cliVersion: '0.1.0' });
    expect(fork.id).not.toBe(source.id);
    const header = (await fork.replay())[0];
    expect(header).toMatchObject({
      type: 'session.start',
      cwd: '/work/source',
      model: 'source-model',
      provider: 'primary',
      forkedFrom: source.id,
    });

    const forkedEvents = await fork.replay();
    expect(forkedEvents.filter((event) => event.type === 'session.start')).toHaveLength(1);
    expect(forkedEvents.map((event) => event.type)).toEqual([
      'session.start',
      'user.message',
      'turn.start',
      'assistant.message',
      'tool.call',
      'tool.result',
      'assistant.message',
      'turn.end',
    ]);
    expect(forkedEvents.some((event) => event.type === 'session.end')).toBe(false);

    const rebuilt = rebuildHistory(forkedEvents);
    expect(rebuilt.messages).toHaveLength(4);
    expect(rebuilt.messages[1]?.content[0]).toMatchObject({ type: 'text', text: 'reading' });

    await fork.append({ type: 'user.message', text: 'fork only' });
    await fork.close();

    const sourceEventsAfter = await store.replaySession(source.id);
    expect(sourceEventsAfter).toEqual(sourceEventsBefore);
    expect(sourceEventsAfter.some((event) => event.text === 'fork only')).toBe(false);
  });

  it('supports forking at an earlier sequence and from an ended session', async () => {
    const source = await createSource();
    await appendFirstTurn(source);
    const firstTurnEnd = (await source.replay()).find((event) => event.type === 'turn.end');
    if (!firstTurnEnd) throw new Error('missing turn.end');
    await source.append({ type: 'user.message', text: 'second request' });
    await source.append({ type: 'turn.start', turnId: 'turn-2' });
    await source.append({ type: 'assistant.message', turnId: 'turn-2', text: 'later', calls: [] });
    await source.append({ type: 'turn.end', turnId: 'turn-2', status: 'done' });
    await source.end();
    await source.close();

    const fork = await store.forkSession(source.id, { upToSeq: firstTurnEnd.seq, cliVersion: '0.1.0' });
    const events = await fork.replay();
    expect(events.some((event) => event.text === 'second request')).toBe(false);
    expect(events.some((event) => event.text === 'first answer')).toBe(true);
    expect(events.some((event) => event.type === 'session.end')).toBe(false);
    expect(deriveSessionStatus(events)).toBe('idle');
    await fork.close();
  });

  it('allows cwd/model/provider overrides in the fork header', async () => {
    const source = await createSource();
    await appendFirstTurn(source);
    await source.close();
    const fork = await store.forkSession(source.id, {
      cwd: '/work/other',
      model: 'override-model',
      provider: 'secondary',
      cliVersion: '0.2.0',
    });
    expect((await fork.replay())[0]).toMatchObject({
      cwd: '/work/other',
      model: 'override-model',
      provider: 'secondary',
      cliVersion: '0.2.0',
      forkedFrom: source.id,
    });
    await fork.close();
  });

  it('rejects running sessions and invalid cut positions while releasing the source lock', async () => {
    const source = await createSource();
    await appendFirstTurn(source);
    await source.append({ type: 'turn.start', turnId: 'turn-2' });
    await source.close();

    await expect(store.forkSession(source.id, { cliVersion: '0.1.0' })).rejects.toThrow(/is running/);

    const reopened = await store.attachSession(source.id, 'write');
    await reopened.append({ type: 'turn.end', turnId: 'turn-2', status: 'done' });
    await reopened.close();
    await expect(store.forkSession(source.id, { upToSeq: 999, cliVersion: '0.1.0' })).rejects.toThrow(
      /upToSeq must be between/,
    );

    const sourceAgain = await store.attachSession(source.id, 'write');
    await sourceAgain.close();
  });

  it('rejects forking an actively locked session', async () => {
    const source = await createSource();
    await expect(store.forkSession(source.id, { cliVersion: '0.1.0' })).rejects.toThrow(/already locked/);
    await source.close();
  });

  it('converges a fork cut in the middle of a turn', async () => {
    const source = await createSource();
    await appendFirstTurn(source);
    await source.append({ type: 'user.message', text: 'second request' });
    const turnStart = await source.append({ type: 'turn.start', turnId: 'turn-2' });
    await source.append({ type: 'assistant.message', turnId: 'turn-2', text: 'later', calls: [] });
    await source.append({ type: 'turn.end', turnId: 'turn-2', status: 'done' });
    await source.close();

    const fork = await store.forkSession(source.id, {
      upToSeq: turnStart[0]?.seq,
      cliVersion: '0.1.0',
    });
    const events = await fork.replay();
    expect(events.some((event) => event.type === 'turn.aborted')).toBe(true);
    expect(deriveSessionStatus(events)).toBe('idle');
    expect(events.some((event) => event.text === 'later')).toBe(false);
    await fork.close();
  });

  it('keeps the source writable after a successful fork', async () => {
    const source = await createSource();
    await appendFirstTurn(source);
    await source.close();
    const fork = await store.forkSession(source.id, { cliVersion: '0.1.0' });
    await fork.close();

    const sourceAgain = await store.attachSession(source.id, 'write');
    await sourceAgain.append({ type: 'user.message', text: 'source still works' });
    await sourceAgain.close();
  });
});
