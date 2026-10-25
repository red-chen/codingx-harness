import type { Color, Style } from '../terminal/buffer.js';
import { ATTR_BOLD, ATTR_ITALIC, ATTR_UNDERLINE } from '../terminal/buffer.js';
import { displayWidth, graphemeSegments, wrapText } from '../text/index.js';
import { TUI_COLORS } from '../state/types.js';
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
const HEADING: Style = { fg: TUI_COLORS.accent, attrs: ATTR_BOLD };
const MUTED: Style = { fg: TUI_COLORS.muted };
const CODE: Style = { fg: TUI_COLORS.accent };
const CODE_BG = TUI_COLORS.planBg;
const LINK: Style = { fg: TUI_COLORS.accent, attrs: ATTR_UNDERLINE };
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
  return CODE;
}

/** Render a markdown string into display lines. */
export function renderMarkdown(text: string, width: number): StyledTextLine[] {
  const available = Math.max(1, Math.floor(width));
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const output: StyledTextLine[] = [];
  let fence: string | null = null;

  for (const raw of lines) {
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

    const heading = /^(#{1,6})\s+(.*)$/u.exec(raw);
    if (heading) {
      output.push(...wrapAndStyle([{ text: heading[2] ?? '', style: HEADING }], available));
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/u.exec(raw);
    if (bullet) {
      const indent = ' '.repeat(Math.min(8, bullet[1]?.length ?? 0));
      output.push(...wrapAndStyle(
        [{ text: indent + '• ', style: MUTED }, ...parseInlineMarkdown(bullet[2] ?? '')],
        available,
      ));
      continue;
    }

    const numbered = /^(\s*)(\d+)\.\s+(.*)$/u.exec(raw);
    if (numbered) {
      const indent = ' '.repeat(Math.min(8, numbered[1]?.length ?? 0));
      output.push(...wrapAndStyle(
        [{ text: indent + (numbered[2] ?? '') + '. ', style: MUTED }, ...parseInlineMarkdown(numbered[3] ?? '')],
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

    if (raw.trimStart().startsWith('|')) {
      output.push(...wrapAndStyle([{ text: raw, style: MUTED }], available));
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
