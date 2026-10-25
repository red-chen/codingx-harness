import { describe, expect, it } from 'vitest';
import { TuiApp, type CellBuffer } from '../src/tui/index.js';
import type { TurnSummaryCell } from '../src/tui/state/types.js';
import { buildTurnSummaryLines } from '../src/tui/widgets/transcript.js';
import type { TokenUsage } from '../src/providers/types.js';

const USAGE: TokenUsage = {
  inputTokens: 1_200,
  outputTokens: 345,
  cacheReadTokens: 67,
  cacheCreationTokens: 0,
};

function screenText(frame: CellBuffer): string {
  const rows: string[] = [];
  for (let y = 0; y < frame.height; y++) {
    let row = '';
    for (let x = 0; x < frame.width; x++) row += frame.get(x, y)?.symbol ?? ' ';
    rows.push(row.replace(/\s+$/u, ''));
  }
  return rows.join('\n');
}

describe('turn summary', () => {
  it('renders completion time, elapsed time and token usage', () => {
    const completedAt = new Date(2026, 0, 2, 12, 34, 56).getTime();
    const cell: TurnSummaryCell = {
      type: 'turn',
      id: 'turn-1',
      outcome: 'done',
      completedAt,
      durationMs: 12_345,
      llmDurationMs: 10_000,
      toolDurationMs: 1_000,
      usage: USAGE,
    };
    const lines = buildTurnSummaryLines(cell, 100);
    const text = lines.map((line) => line.segments.map((segment) => segment.text).join('')).join('\n');
    expect(text).toContain('12:34:56');
    expect(text).toContain('total 12s');
    expect(text).toContain('llm 10s');
    expect(text).toContain('tools 1s');
    expect(text).toContain('in 1.2k');
    expect(text).toContain('out 345');
    expect(text).toContain('cache 67');
    expect(text).toContain('✓');
  });

  it('uses different markers for aborted and failed turns', () => {
    const base: TurnSummaryCell = {
      type: 'turn',
      id: 'turn-1',
      outcome: 'done',
      completedAt: 0,
      durationMs: 0,
      llmDurationMs: 0,
      toolDurationMs: 0,
      usage: USAGE,
    };
    const text = (outcome: TurnSummaryCell['outcome']): string =>
      buildTurnSummaryLines({ ...base, outcome }, 80)[0]!.segments.map((segment) => segment.text).join('');
    expect(text('aborted')).toContain('!');
    expect(text('error')).toContain('✗');
  });

  it('shows total turn and current step in the status row', () => {
    const app = new TuiApp({
      session: { sessionId: 's1', cwd: '/tmp/work', model: 'glm-5.3' },
      version: '0.1.0',
      width: 100,
      height: 30,
    });
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    app.handleEvent({ type: 'context.updated', turnId: 't1', usedTokens: 10_000, windowTokens: 1_000_000, steps: 2 });
    expect(screenText(app.frame())).toContain('turn 1 · step 2');
    app.handleEvent({
      type: 'turn.finished',
      turnId: 't1',
      status: 'done',
      usage: USAGE,
      durationMs: 10,
    });
    app.handleEvent({ type: 'turn.started', turnId: 't2' });
    app.handleEvent({ type: 'context.updated', turnId: 't2', usedTokens: 20_000, windowTokens: 1_000_000, steps: 1 });
    expect(screenText(app.frame())).toContain('turn 2 · step 1');
  });

  it('aggregates LLM/tool timings and total token usage', () => {
    const app = new TuiApp({
      session: { sessionId: 's1', cwd: '/tmp/work', model: 'glm-5.3' },
      version: '0.1.0',
      width: 100,
      height: 30,
    });
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    app.handleEvent({ type: 'text.delta', turnId: 't1', text: 'working' });
    app.handleEvent({ type: 'llm.finished', turnId: 't1', durationMs: 2_000 });
    app.handleEvent({
      type: 'tool.started',
      turnId: 't1',
      call: { id: 'c1', name: 'Shell', input: { command: 'npm test' } },
    });
    app.handleEvent({
      type: 'tool.finished',
      turnId: 't1',
      callId: 'c1',
      name: 'Shell',
      result: { content: 'ok', isError: false },
      durationMs: 1_000,
    });
    app.handleEvent({
      type: 'turn.finished',
      turnId: 't1',
      status: 'done',
      usage: USAGE,
      durationMs: 3_000,
    });
    expect(app.transcript.find((cell) => cell.type === 'assistant')).toMatchObject({ durationMs: 2_000 });
    expect(app.transcript.find((cell) => cell.type === 'exec')).toMatchObject({ durationMs: 1_000 });
    expect(app.transcript.at(-1)).toMatchObject({
      type: 'turn',
      durationMs: 3_000,
      llmDurationMs: 2_000,
      toolDurationMs: 1_000,
    });
    const text = screenText(app.frame());
    expect(text).toContain('llm 2s');
    expect(text).toContain('tools 1s');
    expect(text).toContain('tok 1.6k');
  });

  it('sums total token usage across turns', () => {
    const app = new TuiApp({
      session: { sessionId: 's1', cwd: '/tmp/work', model: 'glm-5.3' },
      version: '0.1.0',
      width: 100,
      height: 30,
    });
    for (const [turnId] of [['t1'], ['t2']] as const) {
      app.handleEvent({ type: 'turn.started', turnId });
      app.handleEvent({ type: 'turn.finished', turnId, status: 'done', usage: USAGE, durationMs: 1 });
    }
    expect(app.state.totalUsage.inputTokens).toBe(2_400);
    expect(app.state.totalUsage.outputTokens).toBe(690);
    expect(app.state.totalUsage.cacheReadTokens).toBe(134);
    expect(screenText(app.frame())).toContain('tok 3.2k');
  });

  it('appends a summary cell and shows ctx tokens with a 200K default window', () => {
    const now = new Date(2026, 0, 2, 12, 34, 56).getTime();
    const app = new TuiApp({
      session: { sessionId: 's1', cwd: '/tmp/work', model: 'glm-5.3' },
      version: '0.1.0',
      width: 100,
      height: 30,
      now: () => now,
    });
    expect(app.state.contextUsedTokens).toBe(0);
    expect(app.state.contextWindowTokens).toBe(200_000);
    expect(screenText(app.frame())).toContain('ctx 0/200k');

    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    app.handleEvent({ type: 'text.delta', turnId: 't1', text: 'done text' });
    app.handleEvent({
      type: 'turn.finished',
      turnId: 't1',
      status: 'done',
      usage: USAGE,
      durationMs: 12_345,
    });
    const summary = app.transcript.at(-1);
    expect(summary).toMatchObject({ type: 'turn', outcome: 'done', durationMs: 12_345 });
    const text = screenText(app.frame());
    expect(text).toContain('12:34:56');
    expect(text).toContain('total 12s');
    expect(text).toContain('in 1.2k');
    expect(text).toContain('tok 1.6k');

    app.handleEvent({
      type: 'context.updated',
      turnId: 't1',
      usedTokens: 250_000,
      windowTokens: 1_000_000,
      steps: 1,
    });
    expect(app.state.contextUsedTokens).toBe(250_000);
    expect(screenText(app.frame())).toContain('ctx 250k/1m');
  });
});