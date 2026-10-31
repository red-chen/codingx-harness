import type { StatusBarSegment } from '../../plugins/types.js';
import { ATTR_BOLD, ATTR_DIM, ATTR_ITALIC, ATTR_UNDERLINE, rgbColor, type Style } from '../terminal/buffer.js';
import { displayWidth, graphemeSegments, graphemeWidth } from '../text/index.js';
import type { StyledTextLine, StyledTextSegment } from './welcome.js';

function segmentStyle(segment: StatusBarSegment): Style {
  const color = (hex: string) => rgbColor(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
  return { attrs: (segment.bold ? ATTR_BOLD : 0) | (segment.dim ? ATTR_DIM : 0) |
    (segment.italic ? ATTR_ITALIC : 0) | (segment.underline ? ATTR_UNDERLINE : 0),
    ...(segment.fg ? { fg: color(segment.fg) } : {}), ...(segment.bg ? { bg: color(segment.bg) } : {}),
  };
}

/** Append styled plugin text, preserving grapheme boundaries and every fee component on wrapping. */
export function appendPluginText(base: readonly StyledTextLine[], segments: readonly StatusBarSegment[], width: number): StyledTextLine[] {
  const lines = base.map((line) => ({ ...line, segments: [...line.segments] }));
  const indent = ' '.repeat(Math.min(4, Math.max(0, width - 1)));
  const blank = (): { segments: StyledTextSegment[] } => ({ segments: [{ text: indent, style: { attrs: ATTR_DIM } }] });
  if (lines.length === 0) lines.push(blank());
  let line = lines[lines.length - 1]!;
  let used = displayWidth(line.segments.map((segment) => segment.text).join(''));
  for (const segment of segments) {
    const style = segmentStyle(segment);
    for (const glyph of graphemeSegments(segment.text)) {
      const size = graphemeWidth(glyph);
      if (size > Math.max(0, width - indent.length)) continue;
      if (used + size > width) { line = blank(); lines.push(line); used = indent.length; }
      const last = line.segments.at(-1);
      if (last?.style === style) line.segments[line.segments.length - 1] = { text: last.text + glyph, style };
      else line.segments.push({ text: glyph, style });
      used += size;
    }
  }
  return lines;
}
