import type { CellBuffer, Style } from '../terminal/buffer.js';
import { ATTR_BOLD } from '../terminal/buffer.js';
import type { Rect } from '../layout/index.js';
import { displayWidth, truncateToWidth, wrapText } from '../text/index.js';
import type {
  ActiveAssistantCell,
  AssistantCell,
  ExecCell,
  NoticeCell,
  PlanCell,
  TranscriptCell,
  TurnSummaryCell,
  UserCell,
} from '../state/types.js';
import { TUI_COLORS } from '../state/types.js';
import type { StyledTextLine, WelcomeCardOptions } from './welcome.js';
import { drawStyledLine, welcomeCardStyledLines } from './welcome.js';
import { renderMarkdown } from './markdown.js';
import { formatElapsed, usageLabel } from './status.js';

/**
 * Virtualized transcript viewport.
 *
 * Cells are immutable, so their wrapped lines are cached per width. Layout
 * walks from the live bottom and stops once the viewport is full: a 50k-cell
 * scrollback only wraps the handful of cells that are actually visible.
 */

export interface TranscriptViewportOptions {
  readonly cells: readonly TranscriptCell[];
  readonly active?: ActiveAssistantCell | null;
  /** Rows scrolled up from the bottom. 0 follows live output. */
  readonly scrollOffset?: number;
  readonly welcome?: WelcomeCardOptions | null;
}

export interface TranscriptRenderStats {
  readonly cellsVisited: number;
  readonly cellsRendered: number;
  readonly rows: number;
  readonly topBlock: number;
  readonly scrollOffset: number;
}

export interface TranscriptLayout {
  readonly lines: readonly StyledTextLine[];
  readonly stats: TranscriptRenderStats;
}

export const EXEC_OUTPUT_LINES = 5;

const ACCENT: Style = { fg: TUI_COLORS.accent };
const MUTED: Style = { fg: TUI_COLORS.muted };
const ERROR: Style = { fg: TUI_COLORS.error };
const WARNING: Style = { fg: TUI_COLORS.warning };
const SUCCESS: Style = { fg: TUI_COLORS.success };
const PLAIN: Style = {};

const EMPTY_LINE: StyledTextLine = { segments: [] };

const lineCache = new WeakMap<object, Map<number, readonly StyledTextLine[]>>();

function cachedLines(key: object, width: number, build: () => StyledTextLine[]): readonly StyledTextLine[] {
  let perWidth = lineCache.get(key);
  if (perWidth === undefined) {
    perWidth = new Map<number, readonly StyledTextLine[]>();
    lineCache.set(key, perWidth);
  }
  const hit = perWidth.get(width);
  if (hit !== undefined) return hit;
  const lines = build();
  perWidth.set(width, lines);
  return lines;
}

function prefixLines(
  text: string,
  width: number,
  firstPrefix: string,
  continuationPrefix: string,
  textStyle: Style,
  background?: StyledTextLine['background'],
): StyledTextLine[] {
  const prefixWidth = Math.max(displayWidth(firstPrefix), displayWidth(continuationPrefix));
  const contentWidth = Math.max(1, width - prefixWidth);
  const rows = wrapText(text, contentWidth);
  return rows.map((row, index) => ({
    segments: [
      { text: index === 0 ? firstPrefix : continuationPrefix, style: ACCENT },
      { text: row, style: textStyle },
    ],
    ...(background === undefined ? {} : { background }),
  }));
}

export function buildUserCellLines(cell: UserCell, width: number): StyledTextLine[] {
  return prefixLines(cell.text, width, '› ', '  ', PLAIN, TUI_COLORS.userBg);
}

export function buildAssistantTextLines(text: string, width: number): StyledTextLine[] {
  const inner = Math.max(1, width - 2);
  return renderMarkdown(text, inner).map((line, index) => ({
    segments: [
      { text: index === 0 ? '• ' : '  ', style: ACCENT },
      ...line.segments,
    ],
    ...(line.background === undefined ? {} : { background: line.background }),
  }));
}

export function buildAssistantCellLines(cell: AssistantCell, width: number): StyledTextLine[] {
  return buildAssistantTextLines(cell.text, width);
}

export function buildExecCellLines(cell: ExecCell, width: number): StyledTextLine[] {
  const duration = cell.durationMs === undefined ? '' : ' · ' + formatElapsed(cell.durationMs);
  const commandWidth = Math.max(1, width - displayWidth('• Ran ') - displayWidth(duration));
  const lines: StyledTextLine[] = [
    {
      segments: [
        { text: '• ', style: ACCENT },
        { text: 'Ran ', style: MUTED },
        { text: truncateToWidth(cell.command, commandWidth), style: PLAIN },
        ...(duration.length > 0 ? [{ text: duration, style: MUTED }] : []),
      ],
    },
  ];

  const output = cell.output.replace(/\r\n?/gu, '\n');
  const rawLines = output.split('\n');
  while (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const shown = rawLines.slice(0, EXEC_OUTPUT_LINES);
  const omitted = rawLines.length - shown.length;
  const gutterWidth = displayWidth('  │ ');

  for (let index = 0; index < shown.length; index++) {
    const isLast = index === shown.length - 1 && omitted === 0;
    const gutter = isLast ? '  └ ' : '  │ ';
    const raw = shown[index] ?? '';
    const outputStyle = cell.isError
      ? ERROR
      : /^\s*@@/u.test(raw)
        ? ACCENT
        : /^\s*\+\+\+/u.test(raw) || /^\s*---/u.test(raw)
          ? MUTED
          : /^\s*\+/u.test(raw)
            ? SUCCESS
            : /^\s*-/u.test(raw)
              ? ERROR
              : MUTED;
    const rows = wrapText(raw, Math.max(1, width - gutterWidth));
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      lines.push({
        segments: [
          { text: rowIndex === 0 ? gutter : '    ', style: MUTED },
          { text: rows[rowIndex] ?? '', style: outputStyle },
        ],
      });
    }
  }

  if (omitted > 0) {
    lines.push({ segments: [{ text: '    … +' + omitted + ' lines', style: MUTED }] });
  }
  return lines;
}

function clockTime(timestamp: number): string {
  const date = new Date(Number.isFinite(timestamp) ? timestamp : 0);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

export function buildTurnSummaryLines(cell: TurnSummaryCell, width: number): StyledTextLine[] {
  const icon = cell.outcome === 'done' ? '✓' : cell.outcome === 'aborted' ? '!' : '✗';
  const style = cell.outcome === 'done' ? SUCCESS : cell.outcome === 'aborted' ? WARNING : ERROR;
  const usage = usageLabel(cell.usage) || 'in 0 · out 0';
  const summary =
    clockTime(cell.completedAt) +
    ' · total ' + formatElapsed(cell.durationMs) +
    ' · llm ' + formatElapsed(cell.llmDurationMs) +
    ' · tools ' + formatElapsed(cell.toolDurationMs) +
    ' · ' + usage;
  return [{
    segments: [
      { text: '  ', style: MUTED },
      { text: icon + ' ', style },
      { text: truncateToWidth(summary, Math.max(1, width - 4)), style: MUTED },
    ],
  }];
}

const PLAN_MARKERS: Record<string, string> = {
  completed: '✔',
  in_progress: '▶',
  pending: '□',
};

export function buildPlanCellLines(cell: PlanCell, width: number): StyledTextLine[] {
  const lines: StyledTextLine[] = [
    {
      segments: [
        { text: '• ', style: ACCENT },
        { text: 'Updated Plan', style: { ...PLAIN, attrs: ATTR_BOLD } },
      ],
      background: TUI_COLORS.planBg,
    },
  ];

  for (const step of cell.steps) {
    const marker = PLAN_MARKERS[step.status] ?? '□';
    const markerStyle = step.status === 'completed' ? SUCCESS : step.status === 'in_progress' ? ACCENT : MUTED;
    const rows = wrapText(step.step, Math.max(1, width - 4));
    for (let index = 0; index < rows.length; index++) {
      lines.push({
        segments: [
          {
            text: index === 0 ? '  ' + marker + ' ' : '    ',
            style: markerStyle,
          },
          { text: rows[index] ?? '', style: PLAIN },
        ],
        background: TUI_COLORS.planBg,
      });
    }
  }
  return lines;
}

export function buildNoticeCellLines(cell: NoticeCell, width: number): StyledTextLine[] {
  const marker = cell.level === 'error' ? '✗ ' : cell.level === 'warning' ? '! ' : '· ';
  const style = cell.level === 'error' ? ERROR : cell.level === 'warning' ? WARNING : MUTED;
  const contentWidth = Math.max(1, width - 2);
  return wrapText(cell.text, contentWidth).map((row) => ({
    segments: [
      { text: marker, style },
      { text: row, style },
    ],
  }));
}

export function buildTranscriptCellLines(cell: TranscriptCell, width: number): readonly StyledTextLine[] {
  if (width <= 0) return [];
  return cachedLines(cell, width, () => {
    switch (cell.type) {
      case 'user':
        return buildUserCellLines(cell, width);
      case 'assistant':
        return buildAssistantCellLines(cell, width);
      case 'turn':
        return buildTurnSummaryLines(cell, width);
      case 'exec':
        return buildExecCellLines(cell, width);
      case 'plan':
        return buildPlanCellLines(cell, width);
      case 'notice':
        return buildNoticeCellLines(cell, width);
    }
  });
}

function blockCount(options: TranscriptViewportOptions): number {
  const hasActive = options.active !== null && options.active !== undefined && options.active.text.length > 0;
  const welcome = options.welcome !== null && options.welcome !== undefined ? 1 : 0;
  return welcome + options.cells.length + (hasActive ? 1 : 0);
}

function linesForBlock(options: TranscriptViewportOptions, width: number, index: number): readonly StyledTextLine[] {
  const welcomeOffset = options.welcome !== null && options.welcome !== undefined ? 1 : 0;
  if (welcomeOffset === 1 && index === 0 && options.welcome !== null && options.welcome !== undefined) {
    return welcomeCardStyledLines(options.welcome, width);
  }
  const cellIndex = index - welcomeOffset;
  if (cellIndex >= 0 && cellIndex < options.cells.length) {
    return buildTranscriptCellLines(options.cells[cellIndex] as TranscriptCell, width);
  }
  const active = options.active;
  if (active === null || active === undefined) return [];
  return cachedLines(active, width, () =>
    buildAssistantCellLines(
      {
        type: 'assistant',
        id: active.id,
        turnId: active.turnId,
        text: active.text,
        ...(active.durationMs === undefined ? {} : { durationMs: active.durationMs }),
      },
      width,
    ),
  );
}

function emptyStats(scrollOffset: number): TranscriptRenderStats {
  return { cellsVisited: 0, cellsRendered: 0, rows: 0, topBlock: -1, scrollOffset };
}

function collectVisible(
  options: TranscriptViewportOptions,
  width: number,
  height: number,
  allowFallback: boolean,
): TranscriptLayout {
  const total = blockCount(options);
  const requestedOffset = Math.max(0, Math.floor(options.scrollOffset ?? 0));
  if (width <= 0 || height <= 0 || total === 0) {
    return { lines: [], stats: emptyStats(requestedOffset) };
  }

  const chunks: StyledTextLine[][] = [];
  let remaining = height;
  let skip = requestedOffset;
  let cellsVisited = 0;
  let cellsRendered = 0;
  let topBlock = -1;

  for (let index = total - 1; index >= 0 && remaining > 0; index--) {
    const lines = linesForBlock(options, width, index);
    cellsVisited++;
    const lead = index > 0 ? 1 : 0;
    const blockHeight = lines.length + lead;
    if (skip >= blockHeight) {
      skip -= blockHeight;
      continue;
    }

    const blockRows: readonly StyledTextLine[] = lead === 1 ? [EMPTY_LINE, ...lines] : lines;
    const end = blockHeight - skip;
    const start = Math.max(0, end - remaining);
    const slice = blockRows.slice(start, end);
    if (slice.length > 0) {
      chunks.unshift([...slice]);
      cellsRendered++;
      topBlock = index;
      remaining -= slice.length;
    }
    skip = 0;
  }

  const lines = chunks.flat();
  if (lines.length === 0 && requestedOffset > 0 && allowFallback) {
    // Overscrolled: clamp to the live bottom rather than showing an empty screen.
    return collectVisible({ ...options, scrollOffset: 0 }, width, height, false);
  }

  return {
    lines,
    stats: {
      cellsVisited,
      cellsRendered,
      rows: lines.length,
      topBlock,
      scrollOffset: requestedOffset,
    },
  };
}

export function layoutTranscript(
  options: TranscriptViewportOptions,
  width: number,
  height: number,
): TranscriptLayout {
  return collectVisible(options, width, height, true);
}

export function renderTranscript(
  area: Rect,
  frame: CellBuffer,
  options: TranscriptViewportOptions,
): TranscriptRenderStats {
  const layout = layoutTranscript(options, area.width, area.height);
  let row = area.y;
  const bottom = area.y + area.height;
  let rendered = 0;
  for (const line of layout.lines) {
    if (row >= bottom) break;
    drawStyledLine(frame, area, row, line);
    row++;
    rendered++;
  }
  return { ...layout.stats, rows: rendered };
}

/** Total wrapped row count. Used by widgets that need a preferred height. */
export function transcriptHeight(options: TranscriptViewportOptions, width: number): number {
  const total = blockCount(options);
  if (width <= 0 || total === 0) return 0;
  let height = 0;
  for (let index = 0; index < total; index++) {
    height += linesForBlock(options, width, index).length;
    if (index > 0) height += 1;
  }
  return height;
}

export class TranscriptViewport {
  private readonly options: TranscriptViewportOptions;
  lastStats: TranscriptRenderStats | undefined;

  constructor(options: TranscriptViewportOptions) {
    this.options = options;
  }

  desiredHeight(width: number): number {
    return transcriptHeight(this.options, width);
  }

  render(area: Rect, frame: CellBuffer): number {
    const stats = renderTranscript(area, frame, this.options);
    this.lastStats = stats;
    return stats.rows;
  }
}