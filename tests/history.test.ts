import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SYNTHETIC_TOOL_RESULT,
  rebuildHistory,
  restoreReadTracker,
} from '../src/agent/index.js';
import type { RolloutEvent } from '../src/session/index.js';
import { ReadFileTracker } from '../src/tools/index.js';
import { canonicalizePath } from '../src/util/paths.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codingx-history-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let seq = 0;
function ev(type: string, extra: Record<string, unknown> = {}): RolloutEvent {
  seq += 1;
  return {
    seq,
    ts: new Date().toISOString(),
    type,
    eventId: 'event-' + seq,
    ...extra,
  };
}

describe('rebuildHistory', () => {
  it('rebuilds user/assistant/tool messages in order', () => {
    const events = [
      ev('session.start', { cwd: '/work', model: 'm' }),
      ev('user.message', { text: 'hello' }),
      ev('turn.start', { turnId: 't1' }),
      ev('turn.status', { turnId: 't1', status: 'streaming' }),
      ev('assistant.message', {
        turnId: 't1',
        text: 'reading',
        calls: [{ id: 'c1', name: 'read_file', input: { path: 'a.ts' } }],
      }),
      ev('tool.call', { turnId: 't1', callId: 'c1', name: 'read_file', input: { path: 'a.ts' } }),
      ev('tool.result', { turnId: 't1', callId: 'c1', name: 'read_file', content: '1\tconst a', isError: false }),
      ev('assistant.message', { turnId: 't1', text: 'done', calls: [] }),
      ev('turn.end', { turnId: 't1', status: 'done' }),
    ];

    const rebuilt = rebuildHistory(events);
    expect(rebuilt.messages).toHaveLength(4);
    expect(rebuilt.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    expect(rebuilt.messages[1]).toMatchObject({ role: 'assistant' });
    expect(rebuilt.messages[1]?.content[0]).toMatchObject({ type: 'text', text: 'reading' });
    expect(rebuilt.messages[1]?.content[1]).toMatchObject({ type: 'tool_use', name: 'read_file' });
    expect(rebuilt.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: '1\tconst a' }],
    });
    expect(rebuilt.messages[3]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'done' }] });
    expect(rebuilt.syntheticResults).toEqual([]);
    expect(rebuilt.lastTurnId).toBe('t1');
    expect(rebuilt.readFileCalls).toEqual([{ path: 'a.ts', isError: false }]);
  });

  it('creates synthetic is_error results for dangling tool calls', () => {
    const events = [
      ev('user.message', { text: 'do it' }),
      ev('assistant.message', {
        turnId: 't-dangling',
        text: '',
        calls: [
          { id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
          { id: 'c2', name: 'shell', input: { command: 'sleep 100' } },
        ],
      }),
      ev('tool.call', { turnId: 't-dangling', callId: 'c1', name: 'read_file', input: { path: 'a.ts' } }),
      ev('tool.result', {
        turnId: 't-dangling',
        callId: 'c1',
        name: 'read_file',
        content: 'line',
        isError: false,
      }),
      ev('turn.aborted', { turnId: 't-dangling', reason: 'interrupted' }),
    ];

    const rebuilt = rebuildHistory(events);
    expect(rebuilt.messages).toHaveLength(3);
    expect(rebuilt.syntheticResults).toHaveLength(1);
    expect(rebuilt.syntheticResults[0]).toEqual({
      turnId: 't-dangling',
      callId: 'c2',
      name: 'shell',
      content: SYNTHETIC_TOOL_RESULT,
      isError: true,
      synthetic: true,
    });
    const toolResults = rebuilt.messages[2];
    expect(toolResults).toMatchObject({ role: 'user' });
    expect(toolResults?.content).toHaveLength(2);
    expect(toolResults?.content[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 'c2',
      content: SYNTHETIC_TOOL_RESULT,
      is_error: true,
    });
    expect(rebuilt.readFileCalls).toEqual([{ path: 'a.ts', isError: false }]);
  });

  it('merges consecutive user texts left by aborted turns', () => {
    const events = [
      ev('user.message', { text: 'first request' }),
      ev('turn.aborted', { turnId: 't1', reason: 'user aborted' }),
      ev('user.message', { text: 'second request' }),
      ev('assistant.message', { turnId: 't2', text: 'answer', calls: [] }),
      ev('turn.end', { turnId: 't2', status: 'done' }),
    ];
    const rebuilt = rebuildHistory(events);
    expect(rebuilt.messages).toHaveLength(2);
    expect(rebuilt.messages[0]?.content).toEqual([
      { type: 'text', text: 'first request' },
      { type: 'text', text: 'second request' },
    ]);
    expect(rebuilt.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'answer' }] });
  });

  it('skips empty assistant messages and reports failed reads', () => {
    const events = [
      ev('user.message', { text: 'hi' }),
      ev('assistant.message', { turnId: 't1', text: '', calls: [] }),
      ev('assistant.message', {
        turnId: 't1',
        text: '',
        calls: [{ id: 'r1', name: 'read_file', input: { path: 'missing.ts' } }],
      }),
      ev('tool.result', {
        turnId: 't1',
        callId: 'r1',
        name: 'read_file',
        content: 'not found',
        isError: true,
      }),
    ];
    const rebuilt = rebuildHistory(events);
    expect(rebuilt.messages).toHaveLength(3);
    expect(rebuilt.readFileCalls).toEqual([{ path: 'missing.ts', isError: true }]);
  });

it('restores the last plan snapshot from plan.updated events', () => {
    const events = [
      ev('user.message', { text: 'do work' }),
      ev('plan.updated', {
        turnId: 't1',
        steps: [
          { step: 'first', status: 'completed' },
          { step: 'second', status: 'in_progress' },
        ],
      }),
      ev('plan.updated', {
        turnId: 't1',
        steps: [{ step: 'all done', status: 'completed' }],
      }),
    ];
    const rebuilt = rebuildHistory(events);
    expect(rebuilt.plan).toEqual([{ step: 'all done', status: 'completed' }]);
  });

  it('uses toolCallId and toolResultId fallbacks in stored results', () => {
    const events = [
      ev('user.message', { text: 'hi' }),
      ev('assistant.message', {
        turnId: 't1',
        text: '',
        calls: [{ id: 'c1', name: 'shell', input: { command: 'true' } }],
      }),
      ev('tool.result', { toolCallId: 'c1', name: 'shell', content: 'ok', isError: false }),
    ];
    const rebuilt = rebuildHistory(events);
    expect(rebuilt.syntheticResults).toEqual([]);
    expect(rebuilt.messages[2]?.content[0]).toMatchObject({ type: 'tool_result', content: 'ok' });
  });
});

describe('restoreReadTracker', () => {
  it('marks successful reads inside the workspace and skips failures/outside paths', async () => {
    const cwd = path.join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, 'a.ts'), 'a');
    await writeFile(path.join(root, 'outside.ts'), 'outside');

    const events = [
      ev('user.message', { text: 'read' }),
      ev('assistant.message', {
        turnId: 't1',
        text: '',
        calls: [
          { id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
          { id: 'c2', name: 'read_file', input: { path: '../outside.ts' } },
          { id: 'c3', name: 'read_file', input: { path: 'missing.ts' } },
        ],
      }),
      ev('tool.result', { callId: 'c1', name: 'read_file', content: 'a', isError: false }),
      ev('tool.result', { callId: 'c2', name: 'read_file', content: 'outside', isError: false }),
      ev('tool.result', { callId: 'c3', name: 'read_file', content: 'missing', isError: true }),
    ];

    const rebuilt = rebuildHistory(events);
    const tracker = new ReadFileTracker();
    const marked = await restoreReadTracker(rebuilt, cwd, tracker);

    expect(marked).toBe(1);
    expect(tracker.size).toBe(1);
    expect(tracker.hasRead(await canonicalizePath(path.join(cwd, 'a.ts')))).toBe(true);
    expect(tracker.hasRead(await canonicalizePath(path.join(root, 'outside.ts')))).toBe(false);
  });
});