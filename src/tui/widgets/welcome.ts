import type { Style } from '../terminal/buffer.js';
import type { CellBuffer } from '../terminal/buffer.js';
import { displayWidth, sliceByWidth, tildifyPath, truncateToWidth } from '../text/index.js';
import type { Color } from '../terminal/buffer.js';
import type { Rect } from '../layout/index.js';
import { TUI_COLORS } from '../state/types.js';

/** One styled run of text. Segments never contain newlines. */
export interface StyledTextSegment {
  readonly text: string;
  readonly style: Style;
}

/** One rendered terminal line, optionally with a full-width background. */
export interface StyledTextLine {
  readonly segments: readonly StyledTextSegment[];
  readonly background?: Color;
}

export interface WelcomeCardOptions {
  readonly version: string;
  readonly model: string;
  readonly cwd: string;
  readonly home?: string;
  readonly sessionId?: string;
  readonly title?: string;
}

export const WELCOME_MAX_WIDTH = 60;
export const WELCOME_MIN_WIDTH = 44;
export const WELCOME_HEIGHT = 7;

const BORDER_STYLE: Style = { fg: TUI_COLORS.border };
const MUTED_STYLE: Style = { fg: TUI_COLORS.muted };
const ACCENT_STYLE: Style = { fg: TUI_COLORS.accent };
const PLAIN_STYLE: Style = {};

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function versionLabel(version: string): string {
  const clean = oneLine(version);
  if (clean.length === 0) return '';
  return clean.startsWith('v') ? clean : 'v' + clean;
}

function padTo(text: string, width: number): string {
  const clipped = truncateToWidth(oneLine(text), width);
  const gap = Math.max(0, width - displayWidth(clipped));
  return clipped + ' '.repeat(gap);
}

function contentLines(options: WelcomeCardOptions): string[] {
  const title = oneLine(options.title ?? 'codingx') || 'codingx';
  const label = versionLabel(options.version);
  return [
    '>_ ' + title + (label.length > 0 ? ' (' + label + ')' : ''),
    '',
    'model:     ' + oneLine(options.model),
    'directory: ' + oneLine(tildifyPath(options.cwd, options.home)),
    'session:   ' + oneLine(options.sessionId ?? 'unknown'),
  ];
}

/**
 * Plain card lines, including the rounded border. The card is capped at
 * WELCOME_MAX_WIDTH and shrinks with the viewport; below four columns it
 * degrades to a single heading line.
 */
export function welcomeCardLines(options: WelcomeCardOptions, width: number): string[] {
  const available = Math.max(0, Math.floor(width));
  if (available === 0) return [];
  const lines = contentLines(options);
  const heading = lines[0] ?? '';
  const contentWidth = Math.max(...lines.map((line) => displayWidth(line)), 0);
  const wanted = Math.max(WELCOME_MIN_WIDTH, contentWidth + 4);
  const cardWidth = Math.min(available, WELCOME_MAX_WIDTH, wanted);
  if (cardWidth < 4) return [truncateToWidth(heading, available)];

  const innerWidth = cardWidth - 2;
  const bodyWidth = Math.max(0, innerWidth - 2);
  const top = '╭' + '─'.repeat(innerWidth) + '╮';
  const bottom = '╰' + '─'.repeat(innerWidth) + '╯';
  const body = lines.map((line) => '│ ' + padTo(line, bodyWidth) + ' │');
  return [top, ...body, bottom];
}

/** Styled version of the card used by TranscriptViewport. */
export function welcomeCardStyledLines(options: WelcomeCardOptions, width: number): StyledTextLine[] {
  const lines = welcomeCardLines(options, width);
  return lines.map((line, index) => {
    const isBorder = index === 0 || index === lines.length - 1;
    if (isBorder || line.length < 2) {
      return { segments: [{ text: line, style: BORDER_STYLE }] };
    }
    const inner = line.slice(1, -1);
    const style = index === 1 ? ACCENT_STYLE : PLAIN_STYLE;
    return {
      segments: [
        { text: line.slice(0, 1), style: BORDER_STYLE },
        { text: inner, style },
        { text: line.slice(-1), style: BORDER_STYLE },
      ],
    };
  });
}

/**
 * Draw one styled line clipped to the area. Wide graphemes are never split:
 * the segment is sliced by display width before it reaches the CellBuffer.
 */
export function drawStyledLine(frame: CellBuffer, area: Rect, y: number, line: StyledTextLine): void {
  if (area.width <= 0 || y < area.y || y >= area.y + area.height) return;
  if (line.background !== undefined) {
    frame.fill({ bg: line.background }, area.x, y, area.width, 1);
  }
  const right = area.x + area.width;
  let x = area.x;
  for (const segment of line.segments) {
    if (x >= right) break;
    const clipped = sliceByWidth(segment.text, right - x);
    if (clipped.length === 0) {
      if (segment.text.length > 0) break;
      continue;
    }
    const style = line.background === undefined || segment.style.bg !== undefined
      ? segment.style
      : { ...segment.style, bg: line.background };
    frame.setString(x, y, clipped, style);
    x += displayWidth(clipped);
  }
}

export function renderWelcomeCard(area: Rect, frame: CellBuffer, options: WelcomeCardOptions): number {
  if (area.width <= 0 || area.height <= 0) return 0;
  const lines = welcomeCardStyledLines(options, area.width);
  let row = area.y;
  const bottom = area.y + area.height;
  let rendered = 0;
  for (const line of lines) {
    if (row >= bottom) break;
    drawStyledLine(frame, area, row, line);
    row++;
    rendered++;
  }
  return rendered;
}

/** Widget wrapper matching the desiredHeight(width)/render(area, frame) contract. */
export class WelcomeCard {
  private readonly options: WelcomeCardOptions;

  constructor(options: WelcomeCardOptions) {
    this.options = options;
  }

  desiredHeight(width: number): number {
    return welcomeCardLines(this.options, width).length;
  }

  render(area: Rect, frame: CellBuffer): number {
    return renderWelcomeCard(area, frame, this.options);
  }
}