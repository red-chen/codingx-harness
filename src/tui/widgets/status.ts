import { ATTR_DIM } from '../terminal/buffer.js';
import type { CellBuffer, Style } from '../terminal/buffer.js';
import type { Rect } from '../layout/index.js';
import { displayWidth, truncateToWidth } from '../text/index.js';
import type { TokenUsage } from '../../providers/types.js';
import type { TuiStatus } from '../state/types.js';
import { TUI_COLORS } from '../state/types.js';

/** Status row: turn spinner/elapsed/interrupt hint on the left, usage on the right. */

export interface StatusRowOptions {
  readonly status: TuiStatus;
  readonly usage: TokenUsage;
  readonly contextUsedTokens?: number;
  readonly contextWindowTokens?: number;
  readonly totalUsage?: TokenUsage;
  readonly turnNumber?: number;
  readonly currentTurnSteps?: number;
  readonly contextPercent?: number;
  /** Distinguish an approval wait from an AskUserQuestion wait. */
  readonly awaitingKind?: 'answer' | 'approval';
  readonly now?: number;
}

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

const ACTIVE_STYLE: Style = {};
const MUTED_STYLE: Style = { attrs: ATTR_DIM };
const WARNING_STYLE: Style = { fg: TUI_COLORS.warning };
const ERROR_STYLE: Style = { fg: TUI_COLORS.error };

export function spinnerFrame(elapsedMs: number): string {
  const index = Math.floor(Math.max(0, elapsedMs) / 125) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index] ?? '⠋';
}

export function statusElapsedMs(status: TuiStatus, now: number): number {
  if (
    (status.state === 'working' || status.state === 'awaiting') &&
    status.startedAt !== undefined &&
    Number.isFinite(now)
  ) {
    return Math.max(0, now - status.startedAt);
  }
  return Math.max(0, status.elapsedMs);
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (totalSeconds < 60) return totalSeconds + 's';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return minutes + 'm ' + String(seconds).padStart(2, '0') + 's';
  const hours = Math.floor(minutes / 60);
  return hours + 'h ' + String(minutes % 60).padStart(2, '0') + 'm';
}

export function formatTokenCount(value: number): string {
  const count = Math.max(0, Number.isFinite(value) ? Math.trunc(value) : 0);
  if (count >= 1_000_000) {
    const scaled = count / 1_000_000;
    return (Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1)) + 'm';
  }
  if (count >= 1_000) {
    const scaled = count / 1_000;
    return (Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1)) + 'k';
  }
  return String(count);
}

export function contextUsageLabel(
  usedTokens: number | undefined,
  windowTokens: number | undefined,
  width = 80,
): string | undefined {
  if (width < 40) return undefined;
  if (usedTokens === undefined || windowTokens === undefined) return undefined;
  if (!Number.isFinite(usedTokens) || !Number.isFinite(windowTokens) || windowTokens <= 0) return undefined;
  const used = Math.max(0, Math.min(windowTokens, usedTokens));
  return 'ctx ' + formatTokenCount(used) + '/' + formatTokenCount(windowTokens);
}

export function totalUsageLabel(usage: TokenUsage | undefined): string | undefined {
  if (usage === undefined) return undefined;
  const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  return 'tok ' + formatTokenCount(Math.max(0, total));
}

export function contextLabel(percent: number | undefined): string | undefined {
  if (percent === undefined || !Number.isFinite(percent)) return undefined;
  const clamped = Math.min(100, Math.max(0, Math.round(percent)));
  return 'ctx ' + clamped + '% left';
}

export function usageLabel(usage: TokenUsage): string {
  const parts: string[] = [];
  if (usage.inputTokens > 0) parts.push('in ' + formatTokenCount(usage.inputTokens));
  if (usage.outputTokens > 0) parts.push('out ' + formatTokenCount(usage.outputTokens));
  const cache = usage.cacheReadTokens + usage.cacheCreationTokens;
  if (cache > 0) parts.push('cache ' + formatTokenCount(cache));
  return parts.join(' · ');
}

/** Left-hand status label, already adapted to the viewport width. */
export function statusLabel(
  status: TuiStatus,
  now = 0,
  width = 80,
  awaitingKind: 'answer' | 'approval' = 'answer',
): string {
  const elapsed = statusElapsedMs(status, now);
  if (status.state === 'working') {
    if (width < 40) return 'Working';
    const hint = width >= 60 ? ' • esc to interrupt' : '';
    return spinnerFrame(elapsed) + ' Working (' + formatElapsed(elapsed) + hint + ')';
  }

  if (status.state === 'awaiting') {
    const label = awaitingKind === 'approval' ? 'approval' : 'answer';
    if (width < 40) return awaitingKind === 'approval' ? 'Approval' : 'Awaiting';
    return '! Awaiting ' + label + ' (' + formatElapsed(elapsed) + ')';
  }

  if (status.outcome === 'aborted') {
    return width < 40 ? 'Aborted' : '! Aborted';
  }

  if (status.outcome === 'error') {
    if (width < 40) return 'Error';
    const message = status.error?.message;
    return '! Error' + (message !== undefined && message.length > 0 ? ': ' + message : '');
  }

  return width < 40 ? 'Ready' : '• Ready';
}

export function statusStyle(status: TuiStatus): Style {
  if (status.state === 'working') return ACTIVE_STYLE;
  if (status.state === 'awaiting') return ACTIVE_STYLE;
  if (status.outcome === 'aborted') return WARNING_STYLE;
  if (status.outcome === 'error') return ERROR_STYLE;
  return MUTED_STYLE;
}

/** Right-hand usage/context label, or undefined when it should be hidden. */
export function statusRightLabel(
  usage: TokenUsage,
  contextPercent: number | undefined,
  width: number,
): string | undefined {
  if (width < 60) return undefined;
  const parts: string[] = [];
  const usageText = usageLabel(usage);
  if (usageText.length > 0) parts.push(usageText);
  const context = contextLabel(contextPercent);
  if (context !== undefined) parts.push(context);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function renderStatusRow(area: Rect, frame: CellBuffer, options: StatusRowOptions): number {
  if (area.width <= 0 || area.height <= 0) return 0;
  const now = options.now ?? 0;
  const style = statusStyle(options.status);
  const context = options.contextWindowTokens === undefined
    ? statusRightLabel(options.usage, options.contextPercent, area.width)
    : contextUsageLabel(options.contextUsedTokens, options.contextWindowTokens, area.width);
  const total = options.contextWindowTokens === undefined ? undefined : totalUsageLabel(options.totalUsage);
  const right = [context, total].filter((part): part is string => part !== undefined).join(' · ') || undefined;
  const rightWidth = right === undefined ? 0 : displayWidth(right);
  const leftLimit = right === undefined ? area.width : Math.max(1, area.width - rightWidth - 2);
  let left = truncateToWidth(
    statusLabel(options.status, now, area.width, options.awaitingKind ?? 'answer'),
    leftLimit,
  );
  if (options.turnNumber !== undefined && options.turnNumber > 0) {
    const step = Math.max(0, Math.floor(options.currentTurnSteps ?? 0));
    left = truncateToWidth(left + ' · turn ' + options.turnNumber + ' · step ' + step, leftLimit);
  }

  if (right !== undefined) {
    const leftWidth = displayWidth(left);
    if (leftWidth + 2 + rightWidth > area.width) {
      left = truncateToWidth(left, Math.max(1, area.width - rightWidth - 2));
    }
    const fits = displayWidth(left) + 2 + rightWidth <= area.width;
    if (fits) {
      frame.setString(area.x + area.width - rightWidth, area.y, right, MUTED_STYLE);
    }
  }

  frame.setString(area.x, area.y, left, style);
  return 1;
}

/** Widget wrapper matching the desiredHeight(width)/render(area, frame) contract. */
export class StatusRow {
  private readonly options: StatusRowOptions;

  constructor(options: StatusRowOptions) {
    this.options = options;
  }

  desiredHeight(_width?: number): number {
    return 1;
  }

  render(area: Rect, frame: CellBuffer): number {
    return renderStatusRow(area, frame, this.options);
  }
}
