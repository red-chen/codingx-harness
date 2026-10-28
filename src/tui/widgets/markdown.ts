import type { Color, Style } from '../terminal/buffer.js';
import { ATTR_BOLD, ATTR_DIM, ATTR_ITALIC, ATTR_UNDERLINE } from '../terminal/buffer.js';
import { displayWidth, graphemeSegments, wrapText } from '../text/index.js';
import { TUI_COLORS, TRANSCRIPT_COLORS } from '../state/types.js';
import type { StyledTextLine, StyledTextSegment } from './welcome.js';

/**
 * Small, dependency-free markdown renderer for transcript cells. It covers the
 * constructs models commonly stream (headings, bullets, quotes, fenced code,
 * inline emphasis/code/links, diff fences) and degrades gracefully while a
 * fence is still incomplete.
 */

const PLAIN: Style = {};
const BOLD: Style = { attrs: ATTR_BOLD };
const ITALIC: Style = { attrs: ATTR_ITALIC };
const HEADING: Style = { attrs: ATTR_BOLD };
const MUTED: Style = { attrs: ATTR_DIM };
const CODE: Style = { fg: TRANSCRIPT_COLORS.code };
const CODE_BG = TUI_COLORS.planBg;
const LINK: Style = { fg: TRANSCRIPT_COLORS.code, attrs: ATTR_UNDERLINE };
const DIFF_ADD: Style = { fg: TUI_COLORS.success };
const DIFF_DEL: Style = { fg: TUI_COLORS.error };
const DIFF_META: Style = { fg: TUI_COLORS.accent, attrs: ATTR_BOLD };

function pushText(segments: StyledTextSegment[], text: string, style: Style): void {
  if (text.length === 0) return;
  const previous = segments[segments.length - 1];
  if (previous && previous.style === style) {
    segments[segments.length - 1] = { text: previous.text + text, style };
    return;
  }
  segments.push({ text, style });
}

/** Parse inline markdown into styled segments (no line breaks). */
export function parseInlineMarkdown(text: string): StyledTextSegment[] {
  const segments: StyledTextSegment[] = [];
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]*\))/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) pushText(segments, text.slice(last, index), PLAIN);
    const token = match[0];
    if (token.startsWith('**') || token.startsWith('__')) {
      pushText(segments, token.slice(2, -2), BOLD);
    } else if (token.startsWith('`')) {
      pushText(segments, token.slice(1, -1), CODE);
    } else if (token.startsWith('[')) {
      const label = /^\[([^\]]+)\]/u.exec(token)?.[1] ?? token;
      pushText(segments, label, LINK);
    } else {
      pushText(segments, token.slice(1, -1), ITALIC);
    }
    last = index + token.length;
  }
  if (last < text.length) pushText(segments, text.slice(last), PLAIN);
  return segments;
}

function segmentWidths(segments: readonly StyledTextSegment[]): number {
  let width = 0;
  for (const segment of segments) width += displayWidth(segment.text);
  return width;
}

/** Hard-wrap styled segments at a display width, preserving all styles. */
export function wrapStyledSegments(
  segments: readonly StyledTextSegment[],
  width: number,
): StyledTextSegment[][] {
  const max = Math.max(1, Math.floor(width));
  const lines: StyledTextSegment[][] = [];
  let current: StyledTextSegment[] = [];
  let currentWidth = 0;
  for (const segment of segments) {
    for (const grapheme of graphemeSegments(segment.text)) {
      if (grapheme === '\n') {
        lines.push(current);
        current = [];
        currentWidth = 0;
        continue;
      }
      const size = displayWidth(grapheme);
      if (currentWidth + size > max && current.length > 0) {
        lines.push(current);
        current = [];
        currentWidth = 0;
      }
      pushText(current, grapheme, segment.style);
      currentWidth += size;
    }
  }
  if (current.length > 0 || lines.length === 0) lines.push(current);
  return lines;
}

function styledLine(
  segments: readonly StyledTextSegment[],
  background?: Color,
): StyledTextLine {
  return { segments, ...(background === undefined ? {} : { background }) };
}

function wrapAndStyle(
  segments: readonly StyledTextSegment[],
  width: number,
  background?: Color,
): StyledTextLine[] {
  return wrapStyledSegments(segments, width).map((line) => styledLine(line, background));
}

function codeStyle(line: string, language: string): Style {
  if (language === 'diff' || language === 'patch') {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return DIFF_META;
    if (line.startsWith('+')) return DIFF_ADD;
    if (line.startsWith('-')) return DIFF_DEL;
  }
  return PLAIN;
}

/** Split table cells without treating escaped or inline-code pipes as separators. */
function tableCells(raw: string): string[] {
  let text = raw.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let codeTicks = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && text[i + 1] === '|') { cell += '|'; i++; continue; }
    if (char === '`') {
      let count = 1;
      while (text[i + count] === '`') count++;
      if (codeTicks === 0) codeTicks = count;
      else if (codeTicks === count) codeTicks = 0;
      cell += '`'.repeat(count);
      i += count - 1;
    } else if (char === '|' && codeTicks === 0) {
      cells.push(cell.trim()); cell = '';
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function tableDelimiter(raw: string): boolean {
  return raw.includes('|') && tableCells(raw).every((cell) => /^:?-{3,}:?$/u.test(cell));
}

const tableWords = new Intl.Segmenter(undefined, { granularity: 'word' });

/** Prefer word boundaries in cells; split only tokens wider than the column. */
function wrapTableCell(segments: readonly StyledTextSegment[], width: number): StyledTextSegment[][] {
  const lines: StyledTextSegment[][] = [];
  let line: StyledTextSegment[] = [];
  let used = 0;
  const flush = (): void => { lines.push(line); line = []; used = 0; };
  for (const segment of segments) {
    for (const word of tableWords.segment(segment.text)) {
      const text = word.segment;
      const size = displayWidth(text);
      if (used > 0 && used + size > width) flush();
      if (used === 0 && /^\s+$/u.test(text)) continue;
      if (size <= width) {
        pushText(line, text, segment.style);
        used += size;
      } else {
        for (const grapheme of graphemeSegments(text)) {
          const columns = displayWidth(grapheme);
          if (used > 0 && used + columns > width) flush();
          pushText(line, grapheme, segment.style);
          used += columns;
        }
      }
    }
  }
  if (line.length || !lines.length) lines.push(line);
  return lines;
}

function renderTable(rows: string[][], delimiters: string[], width: number): StyledTextLine[] {
  const count = delimiters.length;
  const parsed = rows.map((row, rowIndex) => Array.from({ length: count }, (_, column) =>
    parseInlineMarkdown(row[column] ?? '').map((segment) => rowIndex === 0
      ? { ...segment, style: { ...segment.style, attrs: (segment.style.attrs ?? 0) | ATTR_BOLD } }
      : segment)));
  // A grid cannot fit at tiny widths; preserve content as labelled fields.
  if (width < count * 5 + 1) {
    return rows.slice(1).flatMap((row) => row.flatMap((cell, column) =>
      wrapAndStyle([...parseInlineMarkdown(rows[0]?.[column] ?? ''), { text: ': ', style: MUTED },
        ...parseInlineMarkdown(cell)], width)));
  }
  const widths = Array.from({ length: count }, (_, column) => Math.max(2,
    ...parsed.map((row) => segmentWidths(row[column] ?? []))));
  const budget = width - count * 3 - 1;
  let total = widths.reduce((sum, value) => sum + value, 0);
  while (total > budget) {
    const largest = widths.indexOf(Math.max(...widths));
    widths[largest] = (widths[largest] ?? 2) - 1;
    total--;
  }
  const rule = (left: string, join: string, right: string): StyledTextLine => styledLine([{
    text: left + widths.map((value) => '─'.repeat(value + 2)).join(join) + right, style: MUTED,
  }]);
  const result = [rule('┌', '┬', '┐')];
  parsed.forEach((row, rowIndex) => {
    const wrapped = row.map((segments, column) => wrapTableCell(segments, widths[column] ?? 2));
    const height = Math.max(...wrapped.map((lines) => lines.length));
    for (let line = 0; line < height; line++) {
      const segments: StyledTextSegment[] = [{ text: '│', style: MUTED }];
      wrapped.forEach((lines, column) => {
        const content = lines[line] ?? [];
        const padding = Math.max(0, (widths[column] ?? 2) - segmentWidths(content));
        const delimiter = delimiters[column] ?? '';
        const left = delimiter.endsWith(':') ? (delimiter.startsWith(':') ? Math.floor(padding / 2) : padding) : 0;
        segments.push({ text: ' ' + ' '.repeat(left), style: PLAIN }, ...content,
          { text: ' '.repeat(padding - left) + ' ', style: PLAIN }, { text: '│', style: MUTED });
      });
      result.push(styledLine(segments));
    }
    if (rowIndex < parsed.length - 1) result.push(rule('├', '┼', '┤'));
  });
  result.push(rule('└', '┴', '┘'));
  return result;
}

/** Render a markdown string into display lines. */
export function renderMarkdown(text: string, width: number): StyledTextLine[] {
  const available = Math.max(1, Math.floor(width));
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const output: StyledTextLine[] = [];
  let fence: string | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex] ?? '';
    const fenceMatch = /^\s*```(.*)$/u.exec(raw);
    if (fenceMatch) {
      if (fence === null) {
        fence = fenceMatch[1]?.trim().split(/\s+/u)[0] ?? '';
        output.push(styledLine([{ text: '┌ ' + (fence || 'code'), style: MUTED }]));
      } else {
        output.push(styledLine([{ text: '└─', style: MUTED }]));
        fence = null;
      }
      continue;
    }

    if (fence !== null) {
      const content = raw.length === 0 ? ' ' : raw;
      output.push(...wrapAndStyle([{ text: content, style: codeStyle(raw, fence) }], available, CODE_BG));
      continue;
    }

    if (raw.trim().length === 0) {
      output.push(styledLine([]));
      continue;
    }

    if (raw.includes('|') && tableDelimiter(lines[lineIndex + 1] ?? '')) {
      const delimiters = tableCells(lines[lineIndex + 1] ?? '');
      const header = tableCells(raw);
      if (header.length === delimiters.length) {
        const rows = [header];
        lineIndex += 1;
        while (lineIndex + 1 < lines.length && (lines[lineIndex + 1] ?? '').includes('|')
          && !(lines[lineIndex + 1] ?? '').trimStart().startsWith('```')) {
          rows.push(tableCells(lines[++lineIndex] ?? ''));
        }
        output.push(...renderTable(rows, delimiters, available));
        continue;
      }
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(raw);
    if (heading) {
      output.push(...wrapAndStyle([{ text: heading[2] ?? '', style: HEADING }], available));
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/u.exec(raw);
    if (bullet) {
      const indent = ' '.repeat(Math.min(8, bullet[1]?.length ?? 0));
      output.push(...wrapAndStyle(
        [{ text: indent + '• ', style: { fg: TRANSCRIPT_COLORS.bullet } }, ...parseInlineMarkdown(bullet[2] ?? '')],
        available,
      ));
      continue;
    }

    const numbered = /^(\s*)(\d+)\.\s+(.*)$/u.exec(raw);
    if (numbered) {
      const indent = ' '.repeat(Math.min(8, numbered[1]?.length ?? 0));
      output.push(...wrapAndStyle(
        [{ text: indent + (numbered[2] ?? '') + '. ', style: { fg: TRANSCRIPT_COLORS.bullet } }, ...parseInlineMarkdown(numbered[3] ?? '')],
        available,
      ));
      continue;
    }

    const quote = /^\s*>\s?(.*)$/u.exec(raw);
    if (quote) {
      output.push(...wrapAndStyle(
        [{ text: '│ ', style: MUTED }, ...parseInlineMarkdown(quote[1] ?? '')],
        available,
      ));
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/u.test(raw)) {
      output.push(styledLine([{ text: '─'.repeat(Math.min(available, 24)), style: MUTED }]));
      continue;
    }

    output.push(...wrapAndStyle(parseInlineMarkdown(raw), available));
  }

  return output;
}

/** Wrap plain markdown text without styling (used by tests/fallbacks). */
export function markdownPlainText(text: string, width: number): string[] {
  return renderMarkdown(text, width).map((line) => line.segments.map((segment) => segment.text).join(''));
}

export { wrapText };
