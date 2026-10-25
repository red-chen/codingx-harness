import type { TokenUsage } from '../../providers/types.js';
import type { RolloutEvent } from '../../session/types.js';
import type { PlanStep } from '../../tools/types.js';
import type {
  ExecCell,
  NoticeCell,
  PlanCell,
  TranscriptCell,
  TurnSummaryCell,
  TuiTurnOutcome,
} from './types.js';

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function usageOf(value: unknown): TokenUsage {
  const usage = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    inputTokens: numberValue(usage.inputTokens),
    outputTokens: numberValue(usage.outputTokens),
    cacheReadTokens: numberValue(usage.cacheReadTokens),
    cacheCreationTokens: numberValue(usage.cacheCreationTokens),
  };
}

function toolLabel(name: string, input: unknown): string {
  const value = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  if (typeof value.command === 'string' && value.command.length > 0) return value.command;
  if (typeof value.path === 'string' && value.path.length > 0) return name + ' ' + value.path;
  return name;
}

function planSteps(value: unknown): PlanStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps: PlanStep[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const step = typeof record.step === 'string' ? record.step : '';
    const status = record.status;
    if (step.length === 0) continue;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue;
    steps.push({ step, status });
  }
  return steps.length > 0 ? steps : undefined;
}

/**
 * Rebuild the visible transcript from a rollout. Model history is rebuilt
 * separately; this restores what the user saw when the session was last open.
 */
export function restoreTranscript(events: readonly RolloutEvent[]): TranscriptCell[] {
  const cells: TranscriptCell[] = [];
  const execs = new Map<string, number>();
  let nextId = 0;
  const id = (prefix: string): string => 'restored-' + prefix + '-' + ++nextId;

  for (const event of events) {
    switch (event.type) {
      case 'user.message': {
        const value = text(event.text);
        if (value.length > 0) cells.push({ type: 'user', id: id('user'), text: value });
        break;
      }
      case 'assistant.message': {
        const value = text(event.text);
        if (value.length > 0) cells.push({ type: 'assistant', id: id('assistant'), turnId: text(event.turnId), text: value });
        break;
      }
      case 'tool.call': {
        const callId = text(event.callId) || text(event.id);
        const name = text(event.name);
        if (callId.length === 0) break;
        const cell: ExecCell = {
          type: 'exec',
          id: id('exec'),
          callId,
          name,
          command: toolLabel(name, event.input),
          output: '',
          isError: false,
          running: true,
        };
        execs.set(callId, cells.length);
        cells.push(cell);
        break;
      }
      case 'tool.result': {
        const callId = text(event.callId);
        const index = execs.get(callId);
        const base: ExecCell = index === undefined
          ? {
              type: 'exec',
              id: id('exec'),
              callId,
              name: text(event.name),
              command: text(event.name),
              output: '',
              isError: false,
              running: false,
            }
          : (cells[index] as ExecCell);
        const updated: ExecCell = {
          ...base,
          output: text(event.content),
          isError: event.isError === true,
          durationMs: numberValue(event.durationMs),
          running: false,
        };
        if (index === undefined) cells.push(updated);
        else cells[index] = updated;
        break;
      }
      case 'plan.updated': {
        const steps = planSteps(event.steps);
        if (steps) {
          const cell: PlanCell = { type: 'plan', id: id('plan'), steps };
          cells.push(cell);
        }
        break;
      }
      case 'turn.end':
      case 'turn.aborted': {
        const outcome: TuiTurnOutcome = event.type === 'turn.aborted'
          ? 'aborted'
          : event.status === 'error'
            ? 'error'
            : 'done';
        if (outcome === 'error') {
          const code = text(event.error && typeof event.error === 'object' && (event.error as Record<string, unknown>).code);
          const message = text(event.error && typeof event.error === 'object' && (event.error as Record<string, unknown>).message);
          const notice: NoticeCell = {
            type: 'notice',
            id: id('notice'),
            level: 'error',
            text: code.length > 0 ? code + ': ' + message : message || 'turn failed',
          };
          cells.push(notice);
        }
        const summary: TurnSummaryCell = {
          type: 'turn',
          id: id('turn'),
          outcome,
          completedAt: Number.isFinite(Date.parse(event.ts)) ? Date.parse(event.ts) : 0,
          durationMs: numberValue(event.durationMs),
          llmDurationMs: 0,
          toolDurationMs: 0,
          usage: usageOf(event.usage),
        };
        cells.push(summary);
        break;
      }
      default:
        break;
    }
  }
  return cells;
}
