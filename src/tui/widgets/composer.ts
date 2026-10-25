import type { CellBuffer } from '../terminal/buffer.js';
import { ATTR_REVERSE } from '../terminal/buffer.js';
import type { Rect } from '../layout/index.js';
import { displayWidth, graphemeSegments, truncateToWidth } from '../text/index.js';
import type { ComposerState, QueueItem } from '../state/types.js';
import { TUI_COLORS } from '../state/types.js';

/**
 * Multi-line composer: text/cursor state, grapheme-aware editing helpers and
 * the 1..8 line renderer. No IO, no timers; the app owns KeyEvent routing.
 */

export const COMPOSER_PROMPT = '› ';
export const COMPOSER_MAX_LINES = 8;
export const COMPOSER_MIN_LINES = 3;
/** One blank row above and below the visible content. */
const COMPOSER_VERTICAL_PADDING = 1;
const COMPOSER_MAX_CONTENT_LINES = COMPOSER_MAX_LINES - COMPOSER_VERTICAL_PADDING * 2;
export const COMPOSER_PLACEHOLDER = 'Ask codingx to do anything';
export const QUEUE_PREVIEW_MAX = 3;

const COMPOSER_BG = { bg: TUI_COLORS.composerBg };
const ACCENT_STYLE = { fg: TUI_COLORS.accent, bg: TUI_COLORS.composerBg };
const MUTED_STYLE = { fg: TUI_COLORS.muted, bg: TUI_COLORS.composerBg };

/** Normalize pasted/inserted text: CRLF to LF, tabs to spaces, drop C0. */
export function normalizeComposerText(text: string): string {
  return text
    .replace(/\r\n?/gu, '\n')
    .replace(/\t/gu, '  ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
}

export function createComposerState(text = '', history: readonly string[] = []): ComposerState {
  const clean = normalizeComposerText(text);
  return {
    text: clean,
    cursor: clean.length,
    history: [...history],
    historyIndex: -1,
    draft: '',
  };
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.min(text.length, Math.max(0, Math.trunc(cursor)));
}

/** Start offset of the grapheme immediately before index (never splits one). */
export function previousGraphemeIndex(text: string, index: number): number {
  const safe = clampCursor(text, index);
  if (safe === 0) return 0;
  let offset = 0;
  for (const grapheme of graphemeSegments(text)) {
    const next = offset + grapheme.length;
    if (next >= safe) return offset;
    offset = next;
  }
  return text.length;
}

/** End offset of the grapheme immediately after index (never splits one). */
export function nextGraphemeIndex(text: string, index: number): number {
  const safe = clampCursor(text, index);
  if (safe >= text.length) return text.length;
  let offset = 0;
  for (const grapheme of graphemeSegments(text)) {
    offset += grapheme.length;
    if (offset > safe) return offset;
  }
  return text.length;
}

export function lineStartIndex(text: string, cursor: number): number {
  const safe = clampCursor(text, cursor);
  const newline = text.lastIndexOf('\n', Math.max(0, safe - 1));
  return newline < 0 ? 0 : newline + 1;
}

export function lineEndIndex(text: string, cursor: number): number {
  const safe = clampCursor(text, cursor);
  const newline = text.indexOf('\n', safe);
  return newline < 0 ? text.length : newline;
}

function withText(state: ComposerState, text: string, cursor: number): ComposerState {
  return { ...state, text, cursor: clampCursor(text, cursor) };
}

function columnInLine(text: string, cursor: number): number {
  return displayWidth(text.slice(lineStartIndex(text, cursor), cursor));
}

function indexAtColumn(text: string, start: number, end: number, column: number): number {
  let width = 0;
  let index = start;
  for (const grapheme of graphemeSegments(text.slice(start, end))) {
    const size = displayWidth(grapheme);
    if (width + size > column) break;
    width += size;
    index += grapheme.length;
  }
  return index;
}

function moveVertical(state: ComposerState, direction: -1 | 1): ComposerState {
  const { text } = state;
  const cursor = clampCursor(text, state.cursor);
  if (direction < 0) {
    const start = lineStartIndex(text, cursor);
    if (start === 0) return withText(state, text, 0);
    const previousEnd = start - 1;
    const previousStart = lineStartIndex(text, previousEnd);
    return withText(state, text, indexAtColumn(text, previousStart, previousEnd, columnInLine(text, cursor)));
  }
  const end = lineEndIndex(text, cursor);
  if (end >= text.length) return withText(state, text, text.length);
  const nextStart = end + 1;
  const nextEnd = lineEndIndex(text, nextStart);
  return withText(state, text, indexAtColumn(text, nextStart, nextEnd, columnInLine(text, cursor)));
}

export type CursorDirection = 'left' | 'right' | 'up' | 'down' | 'home' | 'end';

export function moveComposerCursor(state: ComposerState, direction: CursorDirection): ComposerState {
  const { text } = state;
  const cursor = clampCursor(text, state.cursor);
  switch (direction) {
    case 'left':
      return withText(state, text, previousGraphemeIndex(text, cursor));
    case 'right':
      return withText(state, text, nextGraphemeIndex(text, cursor));
    case 'home':
      return withText(state, text, lineStartIndex(text, cursor));
    case 'end':
      return withText(state, text, lineEndIndex(text, cursor));
    case 'up':
      return moveVertical(state, -1);
    case 'down':
      return moveVertical(state, 1);
  }
}

export function insertComposerText(state: ComposerState, input: string): ComposerState {
  const text = normalizeComposerText(input);
  if (text.length === 0) return state;
  const cursor = clampCursor(state.text, state.cursor);
  const next = state.text.slice(0, cursor) + text + state.text.slice(cursor);
  return withText(state, next, cursor + text.length);
}

export function insertComposerNewline(state: ComposerState): ComposerState {
  return insertComposerText(state, '\n');
}

export function deleteComposerBackward(state: ComposerState): ComposerState {
  const cursor = clampCursor(state.text, state.cursor);
  if (cursor === 0) return state;
  const start = previousGraphemeIndex(state.text, cursor);
  return withText(state, state.text.slice(0, start) + state.text.slice(cursor), start);
}

export function deleteComposerForward(state: ComposerState): ComposerState {
  const cursor = clampCursor(state.text, state.cursor);
  if (cursor >= state.text.length) return state;
  const end = nextGraphemeIndex(state.text, cursor);
  return withText(state, state.text.slice(0, cursor) + state.text.slice(end), cursor);
}

export function deleteComposerWordBackward(state: ComposerState): ComposerState {
  const cursor = clampCursor(state.text, state.cursor);
  const before = state.text.slice(0, cursor);
  const word = /[^ \t\n]+$/u.exec(before);
  if (word !== null) {
    const start = cursor - word[0].length;
    return withText(state, state.text.slice(0, start) + state.text.slice(cursor), start);
  }
  const spaces = /[ \t]+$/u.exec(before);
  if (spaces !== null) {
    const start = cursor - spaces[0].length;
    return withText(state, state.text.slice(0, start) + state.text.slice(cursor), start);
  }
  return state;
}

export function deleteComposerToLineStart(state: ComposerState): ComposerState {
  const cursor = clampCursor(state.text, state.cursor);
  const start = lineStartIndex(state.text, cursor);
  if (start === cursor) return state;
  return withText(state, state.text.slice(0, start) + state.text.slice(cursor), start);
}

export function deleteComposerToLineEnd(state: ComposerState): ComposerState {
  const cursor = clampCursor(state.text, state.cursor);
  const end = lineEndIndex(state.text, cursor);
  if (end === cursor) return state;
  return withText(state, state.text.slice(0, cursor) + state.text.slice(end), cursor);
}

/** Recall an older submitted line. The first Up saves the current draft. */
export function historyPrevious(state: ComposerState): ComposerState {
  if (state.history.length === 0) return state;
  if (state.historyIndex === -1) {
    const index = state.history.length - 1;
    const text = state.history[index] ?? '';
    return { ...state, draft: state.text, historyIndex: index, text, cursor: text.length };
  }
  if (state.historyIndex > 0) {
    const index = state.historyIndex - 1;
    const text = state.history[index] ?? '';
    return { ...state, historyIndex: index, text, cursor: text.length };
  }
  return state;
}

/** Move forward in history, restoring the draft after the newest entry. */
export function historyNext(state: ComposerState): ComposerState {
  if (state.historyIndex === -1) return state;
  if (state.historyIndex < state.history.length - 1) {
    const index = state.historyIndex + 1;
    const text = state.history[index] ?? '';
    return { ...state, historyIndex: index, text, cursor: text.length };
  }
  return { ...state, historyIndex: -1, text: state.draft, cursor: state.draft.length, draft: '' };
}

export function clearComposer(state: ComposerState): ComposerState {
  return { ...state, text: '', cursor: 0, historyIndex: -1, draft: '' };
}

export interface ComposerRow {
  readonly text: string;
  /** Source offset of the first displayed grapheme. */
  readonly start: number;
  /** Source offset just past the last displayed grapheme. */
  readonly end: number;
}

export interface ComposerLayout {
  readonly rows: readonly ComposerRow[];
  readonly visibleRows: readonly ComposerRow[];
  readonly startRow: number;
  readonly cursorRow: number;
  readonly cursorColumn: number;
  readonly height: number;
}

function layoutLine(line: string, lineStart: number, width: number): ComposerRow[] {
  const limit = Math.max(1, Math.floor(width));
  if (line.length === 0) return [{ text: '', start: lineStart, end: lineStart }];

  const graphemes = graphemeSegments(line);
  const offsets = new Array<number>(graphemes.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < graphemes.length; index++) {
    offsets[index + 1] = (offsets[index] ?? 0) + (graphemes[index] ?? '').length;
  }

  const rows: ComposerRow[] = [];
  let start = 0;
  while (start < graphemes.length) {
    if (rows.length > 0) {
      while (start < graphemes.length && graphemes[start] === ' ') start++;
      if (start >= graphemes.length) break;
    }

    let end = start;
    let rowWidth = 0;
    let lastSpace = -1;
    while (end < graphemes.length) {
      const grapheme = graphemes[end] ?? '';
      const size = displayWidth(grapheme);
      if (rowWidth + size > limit && end > start) break;
      if (grapheme === ' ') lastSpace = end;
      rowWidth += size;
      end++;
    }

    if (end >= graphemes.length) {
      rows.push({
        text: graphemes.slice(start).join(''),
        start: lineStart + (offsets[start] ?? 0),
        end: lineStart + (offsets[graphemes.length] ?? 0),
      });
      break;
    }

    if (lastSpace > start) {
      rows.push({
        text: graphemes.slice(start, lastSpace).join(''),
        start: lineStart + (offsets[start] ?? 0),
        end: lineStart + (offsets[lastSpace] ?? 0),
      });
      start = lastSpace + 1;
      continue;
    }

    const hardEnd = end > start ? end : start + 1;
    rows.push({
      text: graphemes.slice(start, hardEnd).join(''),
      start: lineStart + (offsets[start] ?? 0),
      end: lineStart + (offsets[hardEnd] ?? 0),
    });
    start = hardEnd;
  }

  if (rows.length === 0) rows.push({ text: '', start: lineStart, end: lineStart });
  return rows;
}

function cursorLocation(rows: readonly ComposerRow[], text: string, cursor: number): { row: number; column: number } {
  const safe = clampCursor(text, cursor);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row === undefined) continue;
    if (safe >= row.start && safe <= row.end) {
      return { row: index, column: displayWidth(text.slice(row.start, safe)) };
    }
  }
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row !== undefined && safe < row.start) return { row: index, column: 0 };
  }
  const last = rows.length - 1;
  const row = rows[last];
  return { row: Math.max(0, last), column: row === undefined ? 0 : displayWidth(row.text) };
}

function contentWidthFor(width: number): number {
  return Math.max(1, Math.floor(width) - displayWidth(COMPOSER_PROMPT));
}

/** Build wrapped visual rows and locate the cursor in them. */
export function layoutComposer(state: ComposerState, width: number): ComposerLayout {
  const contentWidth = contentWidthFor(width);
  const text = state.text;
  const rows: ComposerRow[] = [];
  let lineStart = 0;
  for (const line of text.split('\n')) {
    for (const row of layoutLine(line, lineStart, contentWidth)) rows.push(row);
    lineStart += line.length + 1;
  }
  if (rows.length === 0) rows.push({ text: '', start: 0, end: 0 });

  const location = cursorLocation(rows, text, state.cursor);
  const startRow = rows.length > COMPOSER_MAX_CONTENT_LINES
    ? Math.min(
        Math.max(location.row - (COMPOSER_MAX_CONTENT_LINES - 1), 0),
        rows.length - COMPOSER_MAX_CONTENT_LINES,
      )
    : 0;
  const visibleRows = rows.slice(startRow, startRow + COMPOSER_MAX_CONTENT_LINES);
  const height = Math.min(
    COMPOSER_MAX_LINES,
    Math.max(COMPOSER_MIN_LINES, visibleRows.length + COMPOSER_VERTICAL_PADDING * 2),
  );
  return {
    rows,
    visibleRows,
    startRow,
    cursorRow: location.row,
    cursorColumn: location.column,
    height,
  };
}

export function composerHeight(state: ComposerState, width: number): number {
  return layoutComposer(state, width).height;
}

/** Absolute screen position of the text insertion point for hardware cursor/IME. */
export function composerCursorPosition(
  state: ComposerState,
  area: Rect,
): { x: number; y: number } | null {
  if (area.width <= 0 || area.height <= 0) return null;
  const layout = layoutComposer(state, area.width);
  const height = Math.min(area.height, layout.height);
  const topPadding = Math.max(0, Math.floor((height - layout.visibleRows.length) / 2));
  const visibleCursorRow = layout.cursorRow - layout.startRow;
  if (visibleCursorRow < 0 || visibleCursorRow >= layout.visibleRows.length) return null;
  return {
    x: Math.min(area.x + area.width - 1, area.x + displayWidth(COMPOSER_PROMPT) + layout.cursorColumn),
    y: area.y + topPadding + visibleCursorRow,
  };
}

export function renderComposer(area: Rect, frame: CellBuffer, state: ComposerState): number {
  if (area.width <= 0 || area.height <= 0) return 0;
  const layout = layoutComposer(state, area.width);
  const height = Math.min(area.height, layout.height);
  const contentWidth = contentWidthFor(area.width);
  const empty = state.text.length === 0;
  const topPadding = Math.max(0, Math.floor((height - layout.visibleRows.length) / 2));

  // The composer is its own surface, visually distinct from transcript cells.
  frame.fill(COMPOSER_BG, area.x, area.y, area.width, area.height);

  for (let offset = 0; offset < layout.visibleRows.length; offset++) {
    const row = layout.visibleRows[offset];
    if (row === undefined) break;
    const y = area.y + topPadding + offset;
    if (y >= area.y + height) break;
    const prefix = offset === 0 ? COMPOSER_PROMPT : '  ';
    frame.setString(area.x, y, prefix, ACCENT_STYLE);
    const body = empty ? COMPOSER_PLACEHOLDER : row.text;
    const clipped = truncateToWidth(body, contentWidth);
    frame.setString(
      area.x + displayWidth(COMPOSER_PROMPT),
      y,
      clipped,
      empty ? MUTED_STYLE : COMPOSER_BG,
    );
  }

  const visibleCursorRow = layout.cursorRow - layout.startRow;
  if (visibleCursorRow >= 0 && visibleCursorRow < layout.visibleRows.length) {
    const y = area.y + topPadding + visibleCursorRow;
    const x = Math.min(area.x + area.width - 1, area.x + displayWidth(COMPOSER_PROMPT) + layout.cursorColumn);
    const cell = frame.get(x, y);
    if (cell !== undefined) {
      frame.set(x, y, { ...cell, attrs: cell.attrs | ATTR_REVERSE });
    }
  }

  return height;
}

export function queuePreviewHeight(queue: readonly QueueItem[]): number {
  if (queue.length === 0) return 0;
  return Math.min(queue.length, QUEUE_PREVIEW_MAX) + (queue.length > QUEUE_PREVIEW_MAX ? 1 : 0);
}

/** Queue preview lines shown directly above the composer. */
export function renderQueuePreview(area: Rect, frame: CellBuffer, queue: readonly QueueItem[]): number {
  if (area.width <= 0 || area.height <= 0 || queue.length === 0) return 0;
  const prefix = '  ↳ ';
  const prefixWidth = displayWidth(prefix);
  let row = 0;
  for (const item of queue.slice(0, QUEUE_PREVIEW_MAX)) {
    if (row >= area.height) break;
    const y = area.y + row;
    frame.setString(area.x, y, prefix, MUTED_STYLE);
    frame.setString(area.x + prefixWidth, y, truncateToWidth(item.text.replace(/\s+/gu, ' '), Math.max(0, area.width - prefixWidth)), MUTED_STYLE);
    row++;
  }
  if (queue.length > QUEUE_PREVIEW_MAX && row < area.height) {
    frame.setString(area.x, area.y + row, '  … +' + (queue.length - QUEUE_PREVIEW_MAX) + ' queued', MUTED_STYLE);
    row++;
  }
  return row;
}

/** Widget wrapper matching the desiredHeight(width)/render(area, frame) contract. */
export class Composer {
  private readonly state: ComposerState;
  private readonly width: number;

  constructor(state: ComposerState, width = 80) {
    this.state = state;
    this.width = width;
  }

  desiredHeight(width?: number): number {
    const measured = width !== undefined && Number.isFinite(width) && width > 0 ? Math.floor(width) : this.width;
    return composerHeight(this.state, measured);
  }

  render(area: Rect, frame: CellBuffer): number {
    return renderComposer(area, frame, this.state);
  }
}