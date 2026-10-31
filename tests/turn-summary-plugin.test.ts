import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TuiApp } from '../src/tui/state/app.js';
import { restoreTranscript } from '../src/tui/state/restore.js';
import { buildTurnSummaryLines } from '../src/tui/widgets/transcript.js';
import { displayWidth } from '../src/tui/text/index.js';
import { ATTR_DIM } from '../src/tui/terminal/buffer.js';
import { executeTurnSummaryPlugin, parseTurnSummaryView, readPluginDirectory } from '../src/plugins/status-bar.js';
import { TurnSummaryPluginHost, turnSummaryInput } from '../src/plugins/turn-summary.js';
import type { RequestUsage } from '../src/providers/usage.js';
import type { TurnSummaryCell } from '../src/tui/state/types.js';
import type { RolloutEvent } from '../src/session/types.js';
import type { TurnSummaryInput, TurnSummaryView } from '../src/plugins/types.js';

const usage = { inputTokens: 8400, outputTokens: 160, cacheReadTokens: 1400, cacheCreationTokens: 0 };
const record: RequestUsage = { requestId: 'r1', turnId: 't1', model: 'deepseek-flash', provider: 'provider-a',
  origin: 'https://api.deepseek.com', startedAt: '2026-11-02T02:00:00.000Z', purpose: 'turn',
  complete: true, cacheBreakdownKnown: true, usage };
const cell: TurnSummaryCell = { type: 'turn', id: 'summary-1', turnId: 't1', outcome: 'done',
  completedAt: Date.parse(record.startedAt), durationMs: 2356, llmDurationMs: 2356, toolDurationMs: 0, usage };
function appWithTurn() {
  return new TuiApp({ session: { sessionId: 'session-a', cwd: '/tmp', model: 'another-model' }, version: 'test',
    initialRequestUsage: [record], initialTranscript: [cell] });
}
const moduleUrl = new URL('../plugins/deepseek-cost/cost.mjs', import.meta.url).href;
const pricing = async () => JSON.parse(await readFile('plugins/deepseek-cost/pricing.json', 'utf8'));
const turn = (): TurnSummaryInput => turnSummaryInput(appWithTurn(), cell);

describe('turn summary fee breakdown', () => {
  it('shows quantities, unit prices, subtotals and an independently calculated turn total', async () => {
    const { calculateTurnCost } = await import(moduleUrl);
    const view = calculateTurnCost(turn(), await pricing());
    expect(view.segments[0].text).toBe(' · 合计 ≈¥0.018136');
    const details = view.details.map((line: { segments: { text: string }[] }) => line.segments[0]!.text);
    expect(details).toEqual([
      '费用构成 · deepseek-flash · 高峰',
      '输入（未命中） 8,400 tok × ¥2/百万 = ¥0.016800',
      '缓存命中 1,400 tok × ¥0.04/百万 = ¥0.000056',
      '输出 160 tok × ¥8/百万 = ¥0.001280',
    ]);
  });

  it('separates peak/off-peak groups and excludes unrelated turns', async () => {
    const { calculateTurnCost } = await import(moduleUrl);
    const input = turn();
    input.usageRecords = [record, { ...record, requestId: 'r2', startedAt: '2026-11-02T12:00:00.000Z' },
      { ...record, requestId: 'r3', turnId: 'different', model: 'deepseek-v4-pro' }];
    const view = calculateTurnCost(input, await pricing());
    expect(view.segments[0].text).toBe(' · 合计 ≈¥0.027204');
    expect(view.details).toHaveLength(8);
    expect(JSON.stringify(view.details)).toContain('空闲');
    expect(JSON.stringify(view.details)).not.toContain('deepseek-v4-pro');
  });

  it('omits unpriceable turns and shows a plain approximation when some usage is missing', async () => {
    const { calculateTurnCost } = await import(moduleUrl);
    const data = await pricing();
    expect(calculateTurnCost({ ...turn(), usageRecords: [] }, data).segments).toEqual([]);
    expect(calculateTurnCost({ ...turn(), usageRecords: [{ ...record, cacheBreakdownKnown: false }] }, data).segments).toEqual([]);
    expect(calculateTurnCost({ ...turn(), usageRecords: [{ ...record, origin: 'https://other.example' }] }, data).segments).toEqual([]);
    const partial = calculateTurnCost({ ...turn(), usageIncomplete: true,
      usageRecords: [record, { ...record, requestId: 'missing-cache', cacheBreakdownKnown: false }] }, data);
    expect(partial.segments[0].text).toBe(' · 合计 ≈¥0.018136');
    expect(JSON.stringify(partial)).not.toContain('?');
  });

  it('executes the manifest-declared capability and sanitizes detailed output', async () => {
    const plugin = await readPluginDirectory(path.resolve('plugins/deepseek-cost'));
    expect(plugin.manifest.capabilities.turn_summary?.protocol).toBe('codingx.turn-summary/v1');
    const view = await executeTurnSummaryPlugin({ ...plugin, input: turn(), timeoutMs: 2000, env: process.env });
    expect(view.details).toHaveLength(4);
    expect(parseTurnSummaryView({ version: 1, segments: [], details: [{ segments: [{ text: '\x1b[31m费用\n¥1\x1b[0m' }] }] })
      .details?.[0]?.segments[0]?.text).toBe('费用 ¥1');
    expect(() => parseTurnSummaryView({ version: 1, segments: [], details: [{ segments: [{ text: 'x', fg: 'invalid' }] }] })).toThrow();
  });

  it('wraps styled fee breakdowns on narrow screens without losing amounts', async () => {
    const { calculateTurnCost } = await import(moduleUrl);
    const view = calculateTurnCost(turn(), await pricing());
    for (const width of [20, 40, 80, 120]) {
      const lines = buildTurnSummaryLines({ ...cell, pluginView: view }, width);
      for (const line of lines) expect(displayWidth(line.segments.map((s) => s.text).join(''))).toBeLessThanOrEqual(width);
      const flattened = lines.map((line) => line.segments.map((s) => s.text).join('')).join('').replace(/\s/g, '');
      for (const label of ['合计≈¥0.018136', '输入（未命中）', '缓存命中', '输出', '¥0.016800', '¥0.000056', '¥0.001280']) {
        expect(flattened).toContain(label);
      }
      for (const segment of lines.flatMap((line) => line.segments).filter((segment) => segment.text.trim().length > 0 && !segment.text.includes('✓'))) {
        expect(segment.style).toEqual({ attrs: ATTR_DIM });
      }
    }
  });

  it('restores stable turn IDs and detects per-turn attribution gaps', () => {
    const events: RolloutEvent[] = [{ seq: 1, eventId: 'event-1', type: 'turn.end', turnId: 't1', status: 'done', ts: record.startedAt, usage }];
    const restored = restoreTranscript(events).find((c): c is TurnSummaryCell => c.type === 'turn')!;
    expect(restored.turnId).toBe('t1');
    const app = appWithTurn();
    expect(turnSummaryInput(app, restored).usageIncomplete).toBe(false);
    expect(turnSummaryInput(app, { ...restored, usage: { ...usage, outputTokens: 999 } }).usageIncomplete).toBe(true);
    app.setModel('totally-different-provider-model');
    expect(turnSummaryInput(app, restored).usageRecords).toEqual([record]);
    app.handleEvent({ type: 'turn.finished', turnId: 't2', status: 'done', usage, durationMs: 5 });
    expect(app.state.transcript.at(-1)).toMatchObject({ type: 'turn', turnId: 't2' });
  });
});

describe('asynchronous summary host', () => {
  async function hostFor(app: TuiApp, execute: typeof executeTurnSummaryPlugin) {
    const plugin = await readPluginDirectory(path.resolve('plugins/deepseek-cost'));
    app.enableTurnSummaryPlugin();
    const warn = vi.fn();
    const onChange = vi.fn();
    const host = new TurnSummaryPluginHost({ ...plugin, app, timeoutMs: 1000, env: {}, execute, warn, onChange });
    return { host, warn, onChange };
  }

  it('runs once per summary and keeps previous turn results when the model changes', async () => {
    const app = appWithTurn();
    const execute = vi.fn().mockResolvedValue({ version: 1, segments: [{ text: ' · ¥0.1' }], details: [] });
    const { host } = await hostFor(app, execute);
    host.poll(); host.poll();
    await vi.waitFor(() => expect((app.state.transcript[0] as TurnSummaryCell).pluginPending).toBe(false));
    app.setModel('new'); host.poll();
    expect(execute).toHaveBeenCalledTimes(1);
    expect((app.state.transcript[0] as TurnSummaryCell).pluginView?.segments[0]?.text).toBe(' · ¥0.1');
    await host.close();
  });

  it('falls back once on failure and releases pending history', async () => {
    const app = appWithTurn();
    const { host, warn } = await hostFor(app, vi.fn().mockRejectedValue(new Error('timeout')));
    host.poll();
    await vi.waitFor(() => expect((app.state.transcript[0] as TurnSummaryCell).pluginPending).toBe(false));
    expect((app.state.transcript[0] as TurnSummaryCell).pluginView?.segments).toEqual([]);
    host.poll(); expect(warn).toHaveBeenCalledTimes(1);
    await host.close();
  });

  it('rejects late output after clear, and aborts running work on close', async () => {
    const app = appWithTurn();
    let resolve!: (view: TurnSummaryView) => void;
    let signal: AbortSignal | undefined;
    const execute = vi.fn((options) => { signal = options.signal; return new Promise<TurnSummaryView>((done) => { resolve = done; }); });
    const { host } = await hostFor(app, execute);
    host.poll();
    app.resetSession();
    resolve({ version: 1, segments: [{ text: 'stale' }] });
    await new Promise((done) => setImmediate(done));
    expect(app.state.transcript).toEqual([]);
    app.handleEvent({ type: 'turn.finished', turnId: 'new', status: 'done', durationMs: 1, usage });
    host.poll();
    const closed = host.close();
    expect(signal?.aborted).toBe(true);
    resolve({ version: 1, segments: [{ text: 'closed' }] });
    await closed;
    expect((app.state.transcript[0] as TurnSummaryCell).pluginView).toBeUndefined();
  });
});
