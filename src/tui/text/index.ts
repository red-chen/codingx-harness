import stringWidth from 'string-width';

/**
 * Text measurement and layout helpers for the terminal kernel.
 *
 * All high-level helpers operate on *rendered* text: C0/C1 control characters,
 * CSI/OSC/DCS and related escape sequences are stripped first. Only newline and
 * tab survive stripping. This is the security boundary between untrusted model
 * output and the terminal; callers that need the raw bytes should not use these
 * helpers.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const ESC = 0x1b;
const BEL = 0x07;
const ST = 0x9c;

/** Split text into Unicode grapheme clusters using Intl.Segmenter. */
export function graphemeSegments(text: string): string[] {
  if (text.length === 0) return [];
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/**
 * Display width of one grapheme cluster. string-width is used so CJK,
 * emoji and combining sequences agree with what a terminal renders.
 * The result is never negative.
 */
export function graphemeWidth(grapheme: string): number {
  return Math.max(0, stringWidth(grapheme, { ambiguousIsNarrow: true }));
}

/**
 * Display width of a string. Control sequences are stripped, then every
 * grapheme cluster is measured independently. Newline and tab have width 0.
 */
export function displayWidth(text: string): number {
  const clean = stripControlSequences(text);
  let width = 0;
  for (const grapheme of graphemeSegments(clean)) {
    width += graphemeWidth(grapheme);
  }
  return width;
}

function skipCsi(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return i + 1; // final byte
    if (code < 0x20 || code === 0x7f) return i; // malformed: stop before control
    i++;
  }
  return text.length;
}

function skipOsc(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === BEL || code === ST) return i + 1;
    if (code === ESC && text.charCodeAt(i + 1) === 0x5c) return i + 2; // ST
    const cp = text.codePointAt(i);
    i += cp !== undefined && cp > 0xffff ? 2 : 1;
  }
  return text.length;
}

function skipControlString(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === ST) return i + 1;
    if (code === ESC && text.charCodeAt(i + 1) === 0x5c) return i + 2; // ST
    const cp = text.codePointAt(i);
    i += cp !== undefined && cp > 0xffff ? 2 : 1;
  }
  return text.length;
}

function skipEscape(text: string, index: number): number {
  const nextIndex = index + 1;
  if (nextIndex >= text.length) return text.length;
  const code = text.charCodeAt(nextIndex);

  if (code === 0x5b) return skipCsi(text, nextIndex + 1); // CSI: ESC [
  if (code === 0x5d) return skipOsc(text, nextIndex + 1); // OSC: ESC ]
  if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
    // DCS, SOS, PM, APC
    return skipControlString(text, nextIndex + 1);
  }

  // Charset designation and other two-byte escapes such as ESC ( B, ESC # 8.
  if (code === 0x28 || code === 0x29 || code === 0x2a || code === 0x2b || code === 0x2d || code === 0x2e || code === 0x2f || code === 0x23 || code === 0x25) {
    return Math.min(text.length, nextIndex + 2);
  }

  // Save/restore cursor and other single-character escapes.
  const cp = text.codePointAt(nextIndex);
  return Math.min(text.length, nextIndex + (cp !== undefined && cp > 0xffff ? 2 : 1));
}

/**
 * Strip terminal control sequences from untrusted text.
 *
 * Removes:
 * - CSI sequences (ESC [ ... final, and C1 0x9B)
 * - OSC sequences (ESC ] ... BEL/ST, and C1 0x9D)
 * - DCS/SOS/PM/APC strings (ESC P/X/^/_ ... ST; C1 0x90/0x98/0x9E/0x9F)
 * - all C0 controls except newline and tab
 * - DEL and all other C1 controls
 *
 * Unterminated escape sequences are dropped to the end of the string. This is
 * deliberately lossy: a parser must never let a partial sequence leak through
 * to the terminal.
 */
export function stripControlSequences(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);

    if (code === ESC) {
      i = skipEscape(text, i);
      continue;
    }

    if (code === 0x9b) {
      i = skipCsi(text, i + 1);
      continue;
    }
    if (code === 0x9d) {
      i = skipOsc(text, i + 1);
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      i = skipControlString(text, i + 1);
      continue;
    }
    if (code >= 0x80 && code <= 0x9f) {
      i++; // other C1 controls
      continue;
    }

    if (code === 0x0a || code === 0x09) {
      result += text[i];
      i++;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      i++;
      continue;
    }

    const cp = text.codePointAt(i);
    if (cp === undefined) {
      i++;
      continue;
    }
    const length = cp > 0xffff ? 2 : 1;
    result += text.slice(i, i + length);
    i += length;
  }
  return result;
}

/** Return the prefix of text whose display width does not exceed maxWidth. */
export function sliceByWidth(text: string, maxWidth: number): string {
  const limit = Number.isFinite(maxWidth) ? Math.max(0, Math.floor(maxWidth)) : 0;
  if (limit === 0) return '';

  const clean = stripControlSequences(text);
  let result = '';
  let width = 0;
  for (const grapheme of graphemeSegments(clean)) {
    const graphemeSize = graphemeWidth(grapheme);
    if (width + graphemeSize > limit) break;
    result += grapheme;
    width += graphemeSize;
  }
  return result;
}

/**
 * Truncate text to maxWidth display columns, appending an ellipsis when it
 * does not fit. Grapheme clusters are never split; wide characters count 2.
 */
export function truncateToWidth(text: string, maxWidth: number, ellipsis = '…'): string {
  const limit = Number.isFinite(maxWidth) ? Math.max(0, Math.floor(maxWidth)) : 0;
  if (limit === 0) return '';

  const clean = stripControlSequences(text);
  if (displayWidth(clean) <= limit) return clean;

  const marker = stripControlSequences(ellipsis);
  const markerWidth = displayWidth(marker);
  if (markerWidth === 0) return sliceByWidth(clean, limit);
  if (markerWidth >= limit) return sliceByWidth(marker, limit);
  return sliceByWidth(clean, limit - markerWidth) + marker;
}

function wrapLine(line: string, width: number): string[] {
  const graphemes = graphemeSegments(line);
  const lines: string[] = [];
  let start = 0;

  while (start < graphemes.length) {
    // Wrapped continuation lines do not start with the spaces consumed at the
    // previous break. Indentation on the original first line is preserved.
    if (lines.length > 0) {
      while (start < graphemes.length && graphemes[start] === ' ') start++;
      if (start >= graphemes.length) break;
    }

    let end = start;
    let lineWidth = 0;
    let lastSpace = -1;
    while (end < graphemes.length) {
      const grapheme = graphemes[end]!;
      const size = graphemeWidth(grapheme);
      if (lineWidth + size > width && end > start) break;
      if (grapheme === ' ') lastSpace = end;
      lineWidth += size;
      end++;
    }

    if (end >= graphemes.length) {
      const tail = graphemes.slice(start).join('');
      if (tail !== '') lines.push(tail);
      break;
    }

    if (lastSpace > start) {
      const chunk = graphemes.slice(start, lastSpace).join('').replace(/ +$/u, '');
      if (chunk !== '') lines.push(chunk);
      start = lastSpace + 1;
      continue;
    }

    // No usable whitespace boundary: hard-wrap, even if a single wide
    // grapheme is wider than the requested width. Losing the character would
    // be worse than emitting a line that is one column too wide.
    const hardEnd = end > start ? end : start + 1;
    const chunk = graphemes.slice(start, hardEnd).join('');
    if (chunk !== '') lines.push(chunk);
    start = hardEnd;
  }

  if (lines.length === 0) lines.push('');
  return lines;
}

/**
 * Wrap text to a display width. Existing newlines are preserved (including a
 * trailing empty line); long words are hard-wrapped; wide graphemes are never
 * split. A non-positive width is treated as 1 so wrapping always progresses.
 */
export function wrapText(text: string, width: number): string[] {
  const limit = Number.isFinite(width) && width >= 1 ? Math.floor(width) : 1;
  const clean = stripControlSequences(text);
  const result: string[] = [];
  for (const line of clean.split('\n')) {
    if (displayWidth(line) <= limit) {
      result.push(line);
    } else {
      result.push(...wrapLine(line, limit));
    }
  }
  return result;
}
export { tildifyPath } from './path.js';
