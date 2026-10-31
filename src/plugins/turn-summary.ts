import type { TuiApp } from '../tui/state/app.js';
import type { TurnSummaryCell } from '../tui/state/types.js';
import { EMPTY_USAGE, addUsage } from '../providers/types.js';
import { executeTurnSummaryPlugin } from './status-bar.js';
import type { PluginManifest, TurnSummaryInput } from './types.js';

export function turnSummaryInput(app: TuiApp, turn: TurnSummaryCell): TurnSummaryInput {
  const state = app.state;
  const records = state.requestUsage.filter((record) => record.turnId === turn.turnId);
  const totals = records.reduce((sum, record) => addUsage(sum, record.usage), { ...EMPTY_USAGE });
  const incomplete = records.length === 0 || records.some((record) => !record.complete) ||
    (Object.keys(totals) as (keyof typeof totals)[]).some((key) => totals[key] !== turn.usage[key]);
  return {
    version: 1, sessionId: state.session.sessionId, generation: state.transcriptGeneration, cwd: state.session.cwd,
    turn: { id: turn.turnId ?? turn.id, outcome: turn.outcome, completedAt: turn.completedAt,
      durationMs: turn.durationMs, usage: turn.usage }, usageRecords: records, usageIncomplete: incomplete,
  };
}

/** One execution per completed cell, in history order. Model switches never reprice previous turns. */
export class TurnSummaryPluginHost {
  private active: AbortController | undefined;
  private pending: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private warned = false;

  constructor(private readonly options: {
    app: TuiApp; manifest: PluginManifest; directory: string; timeoutMs: number; env: NodeJS.ProcessEnv;
    onChange: () => void; warn: (message: string) => void; execute?: typeof executeTurnSummaryPlugin;
  }) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), 100);
    this.timer.unref();
  }

  poll(): void {
    if (this.active || this.stopped) return;
    const app = this.options.app;
    const cell = app.state.transcript.find((cell): cell is TurnSummaryCell => cell.type === 'turn' && cell.pluginPending === true);
    if (!cell) return;
    const input = turnSummaryInput(app, cell);
    const controller = this.active = new AbortController();
    const current = () => !this.stopped && app.state.session.sessionId === input.sessionId && app.state.transcriptGeneration === input.generation;
    this.pending = (async () => {
      try {
        const view = await (this.options.execute ?? executeTurnSummaryPlugin)({ ...this.options, input, signal: controller.signal });
        if (current()) app.resolveTurnSummaryPlugin(cell.id, input.generation, view);
      } catch {
        if (current()) {
          app.resolveTurnSummaryPlugin(cell.id, input.generation, { version: 1, segments: [] });
          if (!this.warned) {
            this.warned = true;
            this.options.warn('PLUGIN_ERROR: turn summary plugin failed; using the default summary.');
          }
        }
      } finally {
        this.active = undefined;
        if (!this.stopped) {
          this.options.onChange();
          // Drain restored turns without paying a timer interval per entry.
          this.poll();
        }
      }
    })();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.active?.abort();
    await this.pending;
  }
}
