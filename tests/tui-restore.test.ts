import { describe, expect, it } from 'vitest';
import type { RolloutEvent } from '../src/session/types.js';
import { restoreTranscript, TuiApp } from '../src/tui/index.js';

function event(seq: number, type: string, data: Record<string, unknown>): RolloutEvent {
  return {
    seq,
    ts: '2026-01-02T12:34:56.000Z',
    type,
    eventId: 'e' + seq,
    ...data,
  };
}

describe('restoreTranscript', () => {
  it('restores user, assistant, tool and turn-summary cells', () => {
    const cells = restoreTranscript([
      event(1, 'session.start', { cwd: '/w', model: 'm' }),
      event(2, 'user.message', { text: 'hello' }),
      event(3, 'assistant.message', { turnId: 't1', text: 'answer' }),
      event(4, 'tool.call', { callId: 'c1', name: 'Shell', input: { command: 'ls' } }),
      event(5, 'tool.result', {
        callId: 'c1',
        name: 'Shell',
        content: 'file.txt',
        isError: false,
        durationMs: 120,
      }),
      event(6, 'turn.end', {
        status: 'done',
        durationMs: 1000,
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }),
    ]);
    expect(cells.map((cell) => cell.type)).toEqual(['user', 'assistant', 'exec', 'turn']);
    expect(cells[0]).toMatchObject({ type: 'user', text: 'hello' });
    expect(cells[1]).toMatchObject({ type: 'assistant', text: 'answer' });
    expect(cells[2]).toMatchObject({
      type: 'exec',
      command: 'ls',
      output: 'file.txt',
      durationMs: 120,
      running: false,
    });
    expect(cells[3]).toMatchObject({
      type: 'turn',
      outcome: 'done',
      durationMs: 1000,
      usage: { inputTokens: 10, outputTokens: 4 },
    });
  });

  it('restores plan cells and error notices', () => {
    const cells = restoreTranscript([
      event(1, 'plan.updated', { steps: [{ step: 'verify', status: 'completed' }] }),
      event(2, 'turn.end', {
        status: 'error',
        durationMs: 50,
        error: { code: 'E_TEST', message: 'boom' },
        usage: { inputTokens: 1, outputTokens: 0 },
      }),
    ]);
    expect(cells.map((cell) => cell.type)).toEqual(['plan', 'notice', 'turn']);
    expect(cells[1]).toMatchObject({ type: 'notice', text: 'E_TEST: boom' });
    expect(cells[2]).toMatchObject({ type: 'turn', outcome: 'error' });
  });

  it('assigns unique ids and tolerates malformed events', () => {
    const cells = restoreTranscript([
      event(1, 'user.message', { text: 'a' }),
      event(2, 'user.message', { text: 'b' }),
      event(3, 'tool.result', { callId: 'missing', content: 'x' }),
    ]);
    expect(cells).toHaveLength(3);
    expect(new Set(cells.map((cell) => cell.id)).size).toBe(3);
  });
});

describe('TuiApp restored transcript', () => {
  it('shows restored history instead of the welcome card', () => {
    const app = new TuiApp({
      session: { sessionId: 's1', cwd: '/w', model: 'm' },
      version: '0.1.0',
      width: 80,
      height: 24,
      initialTranscript: restoreTranscript([
        event(1, 'user.message', { text: 'restored question' }),
        event(2, 'assistant.message', { turnId: 't1', text: 'restored answer' }),
        event(3, 'turn.end', {
          status: 'done',
          durationMs: 10,
          usage: { inputTokens: 2, outputTokens: 1 },
        }),
      ]),
    });
    let text = '';
    const frame = app.renderFrame();
    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) text += frame.get(x, y)?.symbol ?? ' ';
      text += '\n';
    }
    expect(text).toContain('restored question');
    expect(text).toContain('restored answer');
    expect(text).toContain('_ codingx');
    expect(text).toContain('session: s1');
  });
});