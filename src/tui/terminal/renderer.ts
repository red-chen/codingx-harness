import {
  ATTR_BOLD,
  ATTR_DIM,
  ATTR_ITALIC,
  ATTR_REVERSE,
  ATTR_UNDERLINE,
  CellBuffer,
  DEFAULT_COLOR,
  cellsEqual,
} from './buffer.js';
import type { Cell, Color } from './buffer.js';

/** Terminal color capability. none corresponds to NO_COLOR. */
export type ColorMode = 'truecolor' | '256' | '16' | 'none';

export interface CursorPosition {
  x: number;
  y: number;
}

export interface RenderOptions {
  colorMode?: ColorMode;
  /** Wrap the frame in synchronized-output markers (default true). */
  synchronized?: boolean;
  /** Absolute cursor position at frame end. */
  cursor?: CursorPosition | null;
  /** Emit cursor show/hide when explicitly set. */
  cursorVisible?: boolean;
}

export interface RendererOptions {
  write?: (text: string) => unknown;
  colorMode?: ColorMode;
  synchronized?: boolean;
}

export const SYNC_START = '\x1b[?2026h';
export const SYNC_END = '\x1b[?2026l';
export const HIDE_CURSOR = '\x1b[?25l';
export const SHOW_CURSOR = '\x1b[?25h';

const ATTR_MASK = ATTR_BOLD | ATTR_DIM | ATTR_ITALIC | ATTR_UNDERLINE | ATTR_REVERSE;

const ANSI_16_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [128, 0, 0],
  [0, 128, 0],
  [128, 128, 0],
  [0, 0, 128],
  [128, 0, 128],
  [0, 128, 128],
  [192, 192, 192],
  [128, 128, 128],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [0, 0, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

const CUBE_LEVELS: readonly number[] = [0, 95, 135, 175, 215, 255];

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

function distanceSquared(r: number, g: number, b: number, target: readonly [number, number, number]): number {
  const dr = r - target[0];
  const dg = g - target[1];
  const db = b - target[2];
  return dr * dr + dg * dg + db * db;
}

/** Nearest of the 16 standard ANSI colors. Ties choose the lower index. */
export function nearestAnsi16(r: number, g: number, b: number): number {
  const red = clampByte(r);
  const green = clampByte(g);
  const blue = clampByte(b);
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ANSI_16_RGB.length; index++) {
    const distance = distanceSquared(red, green, blue, ANSI_16_RGB[index]!);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/** Convert an xterm-256 index to RGB. */
export function ansi256ToRgb(index: number): { r: number; g: number; b: number } {
  const value = Math.min(255, Math.max(0, Math.trunc(Number.isFinite(index) ? index : 0)));
  if (value < 16) {
    const rgb = ANSI_16_RGB[value]!;
    return { r: rgb[0], g: rgb[1], b: rgb[2] };
  }
  if (value < 232) {
    const cube = value - 16;
    return {
      r: CUBE_LEVELS[Math.floor(cube / 36)]!,
      g: CUBE_LEVELS[Math.floor((cube % 36) / 6)]!,
      b: CUBE_LEVELS[cube % 6]!,
    };
  }
  const level = 8 + (value - 232) * 10;
  return { r: level, g: level, b: level };
}

/** Nearest xterm-256 index (16..255) for RGB, using the color cube + grayscale ramp. */
export function nearestAnsi256(r: number, g: number, b: number): number {
  const red = clampByte(r);
  const green = clampByte(g);
  const blue = clampByte(b);
  let best = 16;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 16; index < 256; index++) {
    const rgb = ansi256ToRgb(index);
    const dr = red - rgb.r;
    const dg = green - rgb.g;
    const db = blue - rgb.b;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/** Downgrade a color to what the given mode can display. null means omit. */
export function downgradeColor(color: Color, mode: ColorMode): Color | null {
  if (mode === 'none') return null;
  if (color.type === 'default') return DEFAULT_COLOR;
  if (mode === 'truecolor') return color;
  if (mode === '256') {
    if (color.type === 'rgb') return { type: 'ansi256', value: nearestAnsi256(color.r, color.g, color.b) };
    return color;
  }
  // 16-color mode.
  if (color.type === 'ansi') return color;
  if (color.type === 'ansi256') {
    const rgb = ansi256ToRgb(color.value);
    return { type: 'ansi', value: nearestAnsi16(rgb.r, rgb.g, rgb.b) };
  }
  return { type: 'ansi', value: nearestAnsi16(color.r, color.g, color.b) };
}

function ansi16Code(value: number, background: boolean): string {
  const index = Math.min(15, Math.max(0, Math.trunc(value)));
  if (background) return String((index < 8 ? 40 : 100) + (index % 8));
  return String((index < 8 ? 30 : 90) + (index % 8));
}

function colorCodes(color: Color | null, background: boolean, mode: ColorMode): string {
  if (color === null || color.type === 'default' || mode === 'none') return '';
  const layer = background ? 48 : 38;
  switch (color.type) {
    case 'ansi':
      return ansi16Code(color.value, background);
    case 'ansi256':
      return layer + ';5;' + color.value;
    case 'rgb':
      if (mode === 'truecolor') return layer + ';2;' + clampByte(color.r) + ';' + clampByte(color.g) + ';' + clampByte(color.b);
      return layer + ';5;' + nearestAnsi256(color.r, color.g, color.b);
  }
}

interface ResolvedStyle {
  attrs: number;
  fg: string;
  bg: string;
  key: string;
}

function resolveStyle(cell: Cell, mode: ColorMode): ResolvedStyle {
  const attrs = cell.attrs & ATTR_MASK;
  const fgColor = downgradeColor(cell.fg, mode);
  const bgColor = downgradeColor(cell.bg, mode);
  const fg = colorCodes(fgColor, false, mode);
  const bg = colorCodes(bgColor, true, mode);
  return { attrs, fg, bg, key: attrs + '|' + fg + '|' + bg };
}

const EMPTY_STYLE: ResolvedStyle = { attrs: 0, fg: '', bg: '', key: '0||' };

function sgrFor(style: ResolvedStyle): string {
  const codes: string[] = [];
  if (style.attrs & ATTR_BOLD) codes.push('1');
  if (style.attrs & ATTR_DIM) codes.push('2');
  if (style.attrs & ATTR_ITALIC) codes.push('3');
  if (style.attrs & ATTR_UNDERLINE) codes.push('4');
  if (style.attrs & ATTR_REVERSE) codes.push('7');
  if (style.fg !== '') codes.push(style.fg);
  if (style.bg !== '') codes.push(style.bg);
  if (codes.length === 0) return '';
  return '\x1b[' + codes.join(';') + 'm';
}

function cursorMove(x: number, y: number): string {
  return '\x1b[' + (y + 1) + ';' + (x + 1) + 'H';
}

function clampCoordinate(value: number, limit: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.trunc(value)), Math.max(0, limit - 1));
}

/**
 * Diff front (current screen) against back (next frame) and return the ANSI
 * string for the changed runs. The renderer assumes the terminal starts and
 * ends each frame in the default SGR state, so unchanged frames emit only the
 * synchronized-output markers.
 *
 * If dimensions differ the screen is cleared and the whole back buffer is
 * repainted. Cursor movement is absolute CUP, emitted once per changed run.
 */
export function renderDiff(front: CellBuffer, back: CellBuffer, options: RenderOptions = {}): string {
  const mode = options.colorMode ?? detectColorMode();
  const synchronized = options.synchronized ?? true;
  const parts: string[] = [];
  if (synchronized) parts.push(SYNC_START);

  const sameSize = front.width === back.width && front.height === back.height;
  if (!sameSize) parts.push('\x1b[2J');

  let current: ResolvedStyle = EMPTY_STYLE;

  for (let y = 0; y < back.height; y++) {
    let x = 0;
    while (x < back.width) {
      const backCell = back.get(x, y);
      if (backCell === undefined) break;
      if (backCell.width === 0) {
        x++;
        continue;
      }

      const frontCell = sameSize ? front.get(x, y) : undefined;
      if (frontCell !== undefined && cellsEqual(frontCell, backCell)) {
        x += backCell.width === 2 ? 2 : 1;
        continue;
      }

      parts.push(cursorMove(x, y));
      let runX = x;
      while (runX < back.width) {
        const cell = back.get(runX, y);
        if (cell === undefined) break;
        if (cell.width === 0) {
          runX++;
          continue;
        }
        if (sameSize) {
          const previous = front.get(runX, y);
          if (previous !== undefined && cellsEqual(previous, cell)) break;
        }

        const style = resolveStyle(cell, mode);
        if (style.key !== current.key) {
          if (current.key !== EMPTY_STYLE.key) {
            parts.push('\x1b[0m');
            current = EMPTY_STYLE;
          }
          if (style.key !== EMPTY_STYLE.key) {
            parts.push(sgrFor(style));
            current = style;
          }
        }

        parts.push(cell.symbol);
        runX += cell.width === 2 ? 2 : 1;
      }
      x = runX;
    }
  }

  if (current.key !== EMPTY_STYLE.key) {
    parts.push('\x1b[0m');
    current = EMPTY_STYLE;
  }

  if (options.cursorVisible !== undefined) {
    parts.push(options.cursorVisible ? SHOW_CURSOR : HIDE_CURSOR);
  }
  if (options.cursor !== undefined && options.cursor !== null) {
    parts.push(cursorMove(clampCoordinate(options.cursor.x, back.width), clampCoordinate(options.cursor.y, back.height)));
  }

  if (synchronized) parts.push(SYNC_END);
  return parts.join('');
}

/** Alias with frame-oriented naming. */
export const renderFrame = renderDiff;

/** Determine color support from a process-like environment. */
export function detectColorMode(env: NodeJS.ProcessEnv = process.env): ColorMode {
  if (env.NO_COLOR !== undefined) return 'none';

  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === '0' || force === 'false') return 'none';
    if (force === '3') return 'truecolor';
    if (force === '2') return '256';
    if (force === '1' || force === 'true' || force === '') return '16';
  }

  const term = (env.TERM ?? '').toLowerCase();
  if (term === 'dumb') return 'none';

  const colorTerm = (env.COLORTERM ?? '').toLowerCase();
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return 'truecolor';
  if (term.includes('256color')) return '256';
  return '16';
}

/**
 * Small stateful wrapper around renderDiff. The renderer itself is stateless;
 * callers own the front/back CellBuffers (or use DoubleBuffer).
 */
export class Renderer {
  readonly colorMode: ColorMode;
  readonly synchronized: boolean;
  private readonly writeFn: ((text: string) => unknown) | undefined;

  constructor(options: RendererOptions = {}) {
    this.colorMode = options.colorMode ?? detectColorMode();
    this.synchronized = options.synchronized ?? true;
    this.writeFn = options.write;
  }

  render(front: CellBuffer, back: CellBuffer, options: Omit<RenderOptions, 'colorMode' | 'synchronized'> = {}): string {
    const output = renderDiff(front, back, {
      ...options,
      colorMode: this.colorMode,
      synchronized: this.synchronized,
    });
    if (this.writeFn !== undefined) this.writeFn(output);
    return output;
  }

  renderFrame(front: CellBuffer, back: CellBuffer, options: Omit<RenderOptions, 'colorMode' | 'synchronized'> = {}): string {
    return this.render(front, back, options);
  }
}

/** Alias for discoverability. */
export const TerminalRenderer = Renderer;
