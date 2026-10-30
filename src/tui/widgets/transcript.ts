import { isExploration } from '../state/exploration.js';
import type { CellBuffer, Style } from '../terminal/buffer.js';
import { ATTR_BOLD, ATTR_DIM } from '../terminal/buffer.js';
import type { Rect } from '../layout/index.js';
import { displayWidth, truncateToWidth, wrapText } from '../text/index.js';
import type {
  ActiveAssistantCell,
  AssistantCell,
  ExecCell,
  LocalCommandCell,
  NoticeCell,
  PlanCell,
  TranscriptCell,
  TurnSummaryCell,
  UserCell,
} from '../state/types.js';
import { TUI_COLORS, TRANSCRIPT_COLORS } from '../state/types.js';
import type { StyledTextLine, WelcomeCardOptions } from './welcome.js';
import { drawStyledLine, welcomeCardStyledLines } from './welcome.js';
import { renderMarkdown } from './markdown.js';
import { formatElapsed, formatTokenCount } from './status.js';

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

export const EXEC_OUTPUT_LINES = 3;

const ACCENT: Style = { fg: TUI_COLORS.accent };
const MUTED: Style = { attrs: ATTR_DIM };
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
      { text: index === 0 ? firstPrefix : continuationPrefix, style: { attrs: ATTR_BOLD | ATTR_DIM } },
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
      { text: index === 0 ? '• ' : '  ', style: MUTED },
      ...line.segments,
    ],
    ...(line.background === undefined ? {} : { background: line.background }),
  }));
}

export function buildAssistantCellLines(cell: AssistantCell, width: number): StyledTextLine[] {
  return buildAssistantTextLines(cell.text, width);
}

/**
 * Consecutive calls of the same tool on the same target share one header:
 *
 *   • Ran ReadFile src/a.ts ×2 · 1s
 *     │ first preview
 *     │ second preview
 *
 * Identical repeated outputs are shown once; the `×N` count still reports how
 * many calls ran.
 */
export function buildExecGroupLines(cells: readonly ExecCell[], width: number): StyledTextLine[] {
  const first = cells[0];
  if (first === undefined) return [];
  if (isExploration(first.name)) return buildExploredLines(cells, width);
  const countLabel = cells.length > 1 ? ' ×' + cells.length : '';
  const totalMs = cells.reduce((sum, cell) => sum + (cell.durationMs ?? 0), 0);
  const hasDuration = cells.some((cell) => cell.durationMs !== undefined);
  const duration = hasDuration ? ' · ' + formatElapsed(totalMs) : '';
  const commandWidth = Math.max(
    1,
    width - displayWidth('• Ran ') - displayWidth(countLabel) - displayWidth(duration),
  );
  const command = truncateToWidth(first.command, commandWidth);
  const commandHead = /^\S+/u.exec(command)?.[0] ?? '';
  const marker: Style = cells.some((cell) => cell.running) ? MUTED
    : cells.some((cell) => cell.isError) ? ERROR : { fg: TRANSCRIPT_COLORS.success };
  const lines: StyledTextLine[] = [
    {
      segments: [
        { text: '• ', style: marker },
        { text: 'Ran ', style: { attrs: ATTR_BOLD } },
        { text: commandHead, style: { fg: TRANSCRIPT_COLORS.command } },
        { text: command.slice(commandHead.length), style: PLAIN },
        ...(countLabel.length > 0 ? [{ text: countLabel, style: MUTED }] : []),
        ...(duration.length > 0 ? [{ text: duration, style: MUTED }] : []),
      ],
    },
  ];

  const previews: ExecCell[] = [];
  for (const cell of cells) {
    const previous = previews[previews.length - 1];
    if (previous !== undefined && previous.output === cell.output && previous.isError === cell.isError) continue;
    previews.push(cell);
  }
  const outputLines: StyledTextLine[] = [];
  for (let index = 0; index < previews.length; index++) {
    const cell = previews[index];
    if (cell === undefined) continue;
    outputLines.push(...execOutputLines(cell, width, index === previews.length - 1));
  }
  lines.push(...limitOutput(outputLines, cells.some((cell) => cell.expanded) ? undefined : EXEC_OUTPUT_LINES));
  return lines;
}

export function buildExploredLines(cells: readonly ExecCell[], width: number): StyledTextLine[] {
  const expanded = cells.some((cell) => cell.expanded);
  const lines: StyledTextLine[] = [{ segments: [
    { text: '• ', style: MUTED },
    { text: cells.some((cell) => cell.running) ? 'Exploring' : 'Explored', style: { attrs: ATTR_BOLD } },
  ] }];
  const shown = expanded ? cells : cells.slice(-3);
  const hidden = cells.length - shown.length;
  const failures = cells.filter((cell) => cell.isError).length;
  shown.forEach((cell, index) => {
    const label = cell.exploration ?? cell.command.replace(/^(ReadFile|Grep|Glob|ListDir)\b/u,
      cell.name === 'ReadFile' ? 'Read' : cell.name === 'ListDir' ? 'List' : 'Search');
    const verb = label.split(' ')[0] ?? '';
    lines.push({ segments: [
      { text: index === 0 ? '  └ ' : '    ', style: MUTED },
      { text: verb, style: { fg: TRANSCRIPT_COLORS.command } },
      { text: truncateToWidth(label.slice(verb.length), Math.max(1, width - 4 - verb.length)), style: PLAIN },
      ...(cell.isError ? [{ text: ' (failed)', style: ERROR }] : []),
    ] });
    if (expanded) {
      lines.push(...buildOutputLines(cell.output, width, cell.isError, {
        ...(expanded ? {} : { maxLines: EXEC_OUTPUT_LINES }), terminal: true,
      }));
    }
  });
  lines.push({ segments: [{ text: expanded ? '    − Hide details (Ctrl+O)' : '    + Show details (Ctrl+O)' + (hidden ? ' · ' + hidden + ' more' : '') + (failures ? ' · ' + failures + ' failed' : ''), style: MUTED }] });
  return lines;
}

export function buildExecCellLines(cell: ExecCell, width: number): StyledTextLine[] {
  return buildExecGroupLines([cell], width);
}

function buildOutputLines(
  output: string,
  width: number,
  isError: boolean,
  options: { maxLines?: number; terminal: boolean },
): StyledTextLine[] {
  const lines: StyledTextLine[] = [];
  const text = output.replace(/\r\n?/gu, '\n');
  const rawLines = text.split('\n');
  while (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const shown = rawLines;
  const omitted = 0;
  const gutterWidth = displayWidth('  │ ');

  for (let index = 0; index < shown.length; index++) {
    const isLast = options.terminal && index === shown.length - 1 && omitted === 0;
    const gutter = isLast ? '  └ ' : '  │ ';
    const raw = shown[index] ?? '';
    const outputStyle = isError
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

  return limitOutput(lines, options.maxLines);
}

function limitOutput(lines: StyledTextLine[], max?: number): StyledTextLine[] {
  if (max === undefined || lines.length <= max) return lines;
  return [...lines.slice(0, max), { segments: [{
    text: '    … +' + (lines.length - max) + ' lines (Ctrl+O)', style: MUTED,
  }] }];
}

/** Strip only the known Shell result envelope in collapsed previews. */
function shellPreview(output: string, failed: boolean): string {
  const normalized = output.replace(/\r\n?/gu, '\n');
  if (!/^(?:Command timed out[^\n]*\n\n)?exit_code: (?:none|-?\d+)\n\nduration_ms: \d+/u.test(normalized)) return output;
  const start = normalized.indexOf('\n\nstdout:\n');
  if (start < 0) return output;
  const body = normalized.slice(start + '\n\nstdout:\n'.length)
    .replace(/^\(empty\)\n\n/u, '')
    .replace(/\n\nstderr:\n\(empty\)(?=\n|$)/u, '')
    .replace(/^stderr:\n\(empty\)$/u, '')
    .replace(/^(?:stderr:\n)/u, '')
    .replace(/\n\nstderr:\n/u, '\n');
  const timeout = normalized.startsWith('Command timed out') ? normalized.split('\n')[0] + '\n' : '';
  return timeout + (body.trim() || (failed ? normalized.split('\n')[0] : '(no output)'));
}

function execOutputLines(cell: ExecCell, width: number, terminal: boolean): StyledTextLine[] {
  const output = cell.name === 'Shell' && !cell.expanded ? shellPreview(cell.output, cell.isError) : cell.output;
  return buildOutputLines(output, width, cell.isError, { terminal });
}

/**
 * Local '!command' cells show the input line and the complete output. The
 * output is already bounded by the exec layer (max_output_chars); unlike model
 * tool calls there is no 3-line preview.
 */
export function buildLocalCommandLines(cell: LocalCommandCell, width: number): StyledTextLine[] {
  return [
    ...prefixLines(cell.command, width, '› ! ', '    ', PLAIN, TUI_COLORS.userBg),
    ...buildOutputLines(cell.output, width, cell.isError, { terminal: true }),
  ];
}

interface ExecGroupCacheEntry {
  readonly width: number;
  readonly cells: readonly ExecCell[];
  readonly lines: readonly StyledTextLine[];
}

const execGroupCache = new WeakMap<ExecCell, ExecGroupCacheEntry>();

function execGroupLines(cells: readonly ExecCell[], width: number): readonly StyledTextLine[] {
  const last = cells[cells.length - 1];
  if (last === undefined) return [];
  const hit = execGroupCache.get(last);
  if (
    hit !== undefined &&
    hit.width === width &&
    hit.cells.length === cells.length &&
    hit.cells.every((cell, index) => cell === cells[index])
  ) {
    return hit.lines;
  }
  const lines = buildExecGroupLines(cells, width);
  execGroupCache.set(last, { width, cells: [...cells], lines });
  return lines;
}

function clockTime(timestamp: number): string {
  const date = new Date(Number.isFinite(timestamp) ? timestamp : 0);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

/** Average output throughput over LLM request time, including time to first token. */
function outputTokenRate(cell: TurnSummaryCell): string {
  const tokens = cell.usage.outputTokens;
  const seconds = cell.llmDurationMs / 1000;
  const rate = tokens / seconds;
  if (cell.outcome !== 'done' || !Number.isFinite(tokens) || tokens < 0 ||
    !Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(rate)) return '-- tok/s';
  return rate.toFixed(1) + ' tok/s';
}

export function buildTurnSummaryLines(cell: TurnSummaryCell, width: number): StyledTextLine[] {
  const icon = cell.outcome === 'done' ? '✓' : cell.outcome === 'aborted' ? '!' : '✗';
  const style = cell.outcome === 'done' ? SUCCESS : cell.outcome === 'aborted' ? WARNING : ERROR;
  const summary = clockTime(cell.completedAt) + ' · ' + formatElapsed(cell.durationMs)
    + ' (L' + formatElapsed(cell.llmDurationMs) + '/T' + formatElapsed(cell.toolDurationMs) + ')'
    + ' · ↑' + formatTokenCount(cell.usage.inputTokens)
    + ' ↓' + formatTokenCount(cell.usage.outputTokens)
    + ' C' + formatTokenCount(cell.usage.cacheReadTokens + cell.usage.cacheCreationTokens)
    + ' · ' + outputTokenRate(cell);
  return wrapText(summary, Math.max(1, width - 4)).map((text, index) => ({
    segments: [
      { text: '  ', style: MUTED },
      { text: index === 0 ? icon + ' ' : '  ', style },
      { text, style: MUTED },
    ],
  }));
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
        { text: '• ', style: MUTED },
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
      case 'local':
        return buildLocalCommandLines(cell, width);
      case 'plan':
        return buildPlanCellLines(cell, width);
      case 'notice':
        return buildNoticeCellLines(cell, width);
    }
  });
}

function hasActiveAssistant(options: TranscriptViewportOptions): boolean {
  return options.active !== null && options.active !== undefined && options.active.text.length > 0;
}

function activeLines(options: TranscriptViewportOptions, width: number): readonly StyledTextLine[] {
  const active = options.active;
  if (active === null || active === undefined) return [];
  return cachedLines(active, width, () => buildAssistantTextLines(active.text, width));
}

/** Adjacent exec cells merge into one block when tool and rendered target match. */
function sameExecGroup(previous: TranscriptCell | undefined, cell: TranscriptCell): boolean {
  return (
    previous !== undefined &&
    previous.type === 'exec' &&
    cell.type === 'exec' &&
    ((isExploration(previous.name) && isExploration(cell.name)) ||
      (previous.name === cell.name && previous.command === cell.command))
  );
}

function groupStart(cells: readonly TranscriptCell[], end: number): number {
  const last = cells[end];
  if (last?.type !== 'exec') return end;
  let start = end;
  while (start > 0 && sameExecGroup(cells[start - 1], last)) start--;
  return start;
}

function groupEnd(cells: readonly TranscriptCell[], start: number): number {
  const first = cells[start];
  if (first?.type !== 'exec') return start;
  let end = start;
  while (end + 1 < cells.length && sameExecGroup(first, cells[end + 1] as TranscriptCell)) end++;
  return end;
}

function blockLines(
  options: TranscriptViewportOptions,
  width: number,
  start: number,
  end: number,
): readonly StyledTextLine[] {
  const cell = options.cells[end];
  if (cell === undefined) return [];
  if (start === end) return buildTranscriptCellLines(cell, width);
  return execGroupLines(options.cells.slice(start, end + 1) as ExecCell[], width);
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
  const cells = options.cells;
  const welcome = options.welcome ?? null;
  const requestedOffset = Math.max(0, Math.floor(options.scrollOffset ?? 0));
  const hasActive = hasActiveAssistant(options);
  if (width <= 0 || height <= 0 || (welcome === null && cells.length === 0 && !hasActive)) {
    return { lines: [], stats: emptyStats(requestedOffset) };
  }

  const chunks: StyledTextLine[][] = [];
  let remaining = height;
  let skip = requestedOffset;
  let cellsVisited = 0;
  let cellsRendered = 0;
  let topBlock = -1;

  const emit = (lines: readonly StyledTextLine[], lead: number, block: number): void => {
    cellsVisited++;
    const blockRows: readonly StyledTextLine[] = lead === 1 ? [EMPTY_LINE, ...lines] : lines;
    if (blockRows.length === 0) return;
    if (skip >= blockRows.length) {
      skip -= blockRows.length;
      return;
    }

    const end = blockRows.length - skip;
    const start = Math.max(0, end - remaining);
    const slice = blockRows.slice(start, end);
    if (slice.length > 0) {
      chunks.unshift([...slice]);
      cellsRendered++;
      topBlock = block;
      remaining -= slice.length;
    }
    skip = 0;
  };

  if (hasActive) {
    emit(activeLines(options, width), welcome !== null || cells.length > 0 ? 1 : 0, cells.length);
  }
  for (let end = cells.length - 1; end >= 0 && remaining > 0;) {
    const start = groupStart(cells, end);
    emit(blockLines(options, width, start, end), welcome !== null || start > 0 ? 1 : 0, start);
    end = start - 1;
  }
  if (welcome !== null && remaining > 0) {
    emit(welcomeCardStyledLines(welcome, width), 0, -1);
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
  const cells = options.cells;
  const welcome = options.welcome ?? null;
  if (width <= 0 || (welcome === null && cells.length === 0 && !hasActiveAssistant(options))) return 0;
  let height = welcome === null ? 0 : welcomeCardStyledLines(welcome, width).length;
  for (let start = 0; start < cells.length;) {
    const end = groupEnd(cells, start);
    height += (welcome !== null || start > 0 ? 1 : 0) + blockLines(options, width, start, end).length;
    start = end + 1;
  }
  if (hasActiveAssistant(options)) {
    height += (welcome !== null || cells.length > 0 ? 1 : 0) + activeLines(options, width).length;
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
