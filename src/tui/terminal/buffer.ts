import { graphemeSegments, graphemeWidth, stripControlSequences } from './width.js';

/** Attribute bit flags stored on a Cell. */
export const ATTR_NONE = 0;
export const ATTR_BOLD = 1 << 0;
export const ATTR_DIM = 1 << 1;
export const ATTR_ITALIC = 1 << 2;
export const ATTR_UNDERLINE = 1 << 3;
export const ATTR_REVERSE = 1 << 4;

export const Attr = {
  None: ATTR_NONE,
  Bold: ATTR_BOLD,
  Dim: ATTR_DIM,
  Italic: ATTR_ITALIC,
  Underline: ATTR_UNDERLINE,
  Reverse: ATTR_REVERSE,
} as const;

/** Colors understood by the renderer. 16-color values are 0..15. */
export type Color =
  | { readonly type: 'default' }
  | { readonly type: 'ansi'; readonly value: number }
  | { readonly type: 'ansi256'; readonly value: number }
  | { readonly type: 'rgb'; readonly r: number; readonly g: number; readonly b: number };

export interface Style {
  fg?: Color;
  bg?: Color;
  attrs?: number;
}

/** One terminal cell. Width 0 marks the continuation column of a wide glyph. */
export interface Cell {
  symbol: string;
  fg: Color;
  bg: Color;
  attrs: number;
  width: 0 | 1 | 2;
}

export const DEFAULT_COLOR: Color = Object.freeze({ type: 'default' });
export const DEFAULT_STYLE: Readonly<Style> = Object.freeze({});

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function ansiColor(value: number): Color {
  return { type: 'ansi', value: clampInteger(value, 0, 15) };
}

export function color256(value: number): Color {
  return { type: 'ansi256', value: clampInteger(value, 0, 255) };
}

export function rgbColor(r: number, g: number, b: number): Color {
  return {
    type: 'rgb',
    r: clampInteger(r, 0, 255),
    g: clampInteger(g, 0, 255),
    b: clampInteger(b, 0, 255),
  };
}

/** Alias for rgbColor, mirroring the truecolor capability name. */
export const trueColor = rgbColor;

export function defaultColor(): Color {
  return DEFAULT_COLOR;
}

export function colorsEqual(a: Color, b: Color): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'default':
      return true;
    case 'ansi':
    case 'ansi256':
      return a.value === (b as { value: number }).value;
    case 'rgb':
      return a.r === (b as { r: number }).r && a.g === (b as { g: number }).g && a.b === (b as { b: number }).b;
  }
}

export function cloneColor(color: Color): Color {
  switch (color.type) {
    case 'default':
      return DEFAULT_COLOR;
    case 'ansi':
      return { type: 'ansi', value: clampInteger(color.value, 0, 15) };
    case 'ansi256':
      return { type: 'ansi256', value: clampInteger(color.value, 0, 255) };
    case 'rgb':
      return {
        type: 'rgb',
        r: clampInteger(color.r, 0, 255),
        g: clampInteger(color.g, 0, 255),
        b: clampInteger(color.b, 0, 255),
      };
  }
}

export function colorKey(color: Color): string {
  switch (color.type) {
    case 'default':
      return 'default';
    case 'ansi':
      return 'ansi:' + color.value;
    case 'ansi256':
      return 'ansi256:' + color.value;
    case 'rgb':
      return 'rgb:' + color.r + ',' + color.g + ',' + color.b;
  }
}

export function styleKey(style: Style): string {
  return colorKey(style.fg ?? DEFAULT_COLOR) + '|' + colorKey(style.bg ?? DEFAULT_COLOR) + '|' + (style.attrs ?? 0);
}

function widthOfGrapheme(grapheme: string): 0 | 1 | 2 {
  const width = graphemeWidth(grapheme);
  if (width <= 0) return 0;
  if (width >= 2) return 2;
  return 1;
}

/**
 * Display width of a cell symbol, capped to the Cell model (0, 1 or 2).
 * Empty/control-only symbols are treated as a blank instead of an orphan
 * zero-width cell.
 */
export function symbolWidth(symbol: string): 1 | 2 {
  const clean = stripControlSequences(symbol);
  const segments = graphemeSegments(clean);
  const first = segments[0];
  if (first === undefined) return 1;
  const width = widthOfGrapheme(first);
  return width === 2 ? 2 : 1;
}

function normalizeSymbol(symbol: string): { symbol: string; width: 1 | 2 } {
  const clean = stripControlSequences(symbol);
  const segments = graphemeSegments(clean);
  const first = segments[0];
  if (first === undefined || first === '\n' || first === '\t') return { symbol: ' ', width: 1 };
  const width = widthOfGrapheme(first);
  if (width === 0) return { symbol: ' ', width: 1 };
  return { symbol: first, width };
}

export function defaultCell(): Cell {
  return { symbol: ' ', fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attrs: ATTR_NONE, width: 1 };
}

export function blankCell(style: Style = {}): Cell {
  return {
    symbol: ' ',
    fg: style.fg ?? DEFAULT_COLOR,
    bg: style.bg ?? DEFAULT_COLOR,
    attrs: style.attrs ?? ATTR_NONE,
    width: 1,
  };
}

export function createCell(symbol: string, style: Style = {}): Cell {
  const normalized = normalizeSymbol(symbol);
  return {
    symbol: normalized.symbol,
    fg: style.fg ?? DEFAULT_COLOR,
    bg: style.bg ?? DEFAULT_COLOR,
    attrs: style.attrs ?? ATTR_NONE,
    width: normalized.width,
  };
}

function cloneCell(cell: Cell): Cell {
  return {
    symbol: cell.symbol,
    fg: cloneColor(cell.fg),
    bg: cloneColor(cell.bg),
    attrs: cell.attrs,
    width: cell.width,
  };
}

export function cellsEqual(a: Cell, b: Cell): boolean {
  return (
    a.symbol === b.symbol &&
    a.width === b.width &&
    a.attrs === b.attrs &&
    colorsEqual(a.fg, b.fg) &&
    colorsEqual(a.bg, b.bg)
  );
}

function normalizeDimension(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('CellBuffer ' + name + ' must be a non-negative finite number');
  }
  return Math.floor(value);
}

function clampRegion(start: number, length: number, limit: number): { start: number; end: number } {
  if (!Number.isFinite(start) || !Number.isFinite(length)) return { start: 0, end: 0 };
  const from = Math.max(0, Math.min(limit, Math.floor(start)));
  const to = Math.max(from, Math.min(limit, Math.floor(start + Math.max(0, length))));
  return { start: from, end: to };
}

/**
 * A fixed-size grid of cells. The buffer owns its cells and keeps wide glyphs
 * and their continuation cells consistent: overwriting or clearing either
 * half repairs both, and resize drops a wide glyph that would be cut at the
 * new right edge.
 */
export class CellBuffer {
  width: number;
  height: number;
  private cells: Cell[];

  constructor(width: number, height: number) {
    this.width = normalizeDimension(width, 'width');
    this.height = normalizeDimension(height, 'height');
    this.cells = new Array<Cell>(this.width * this.height);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = defaultCell();
  }

  inBounds(x: number, y: number): boolean {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x: number, y: number): Cell | undefined {
    if (!this.inBounds(x, y)) return undefined;
    return this.cells[y * this.width + x];
  }

  private setRaw(x: number, y: number, cell: Cell): void {
    this.cells[y * this.width + x] = cell;
  }

  private cellAt(x: number, y: number): Cell | undefined {
    return this.cells[y * this.width + x];
  }

  /** Clear both halves of any wide glyph occupying x. */
  private repairAt(x: number, y: number): void {
    if (!this.inBounds(x, y)) return;
    const cell = this.cellAt(x, y);
    if (cell === undefined) return;
    if (cell.width === 2) {
      this.setRaw(x, y, defaultCell());
      if (this.inBounds(x + 1, y)) this.setRaw(x + 1, y, defaultCell());
    } else if (cell.width === 0) {
      if (x > 0 && this.cellAt(x - 1, y)?.width === 2) this.setRaw(x - 1, y, defaultCell());
      this.setRaw(x, y, defaultCell());
    }
  }

  private repairAll(): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const index = y * this.width + x;
        const cell = this.cells[index]!;
        if (cell.width === 2) {
          const next = x + 1 < this.width ? this.cells[index + 1] : undefined;
          if (next === undefined || next.width !== 0) {
            this.cells[index] = defaultCell();
            if (next !== undefined) this.cells[index + 1] = defaultCell();
          }
        } else if (cell.width === 0) {
          const previous = x > 0 ? this.cells[index - 1] : undefined;
          if (previous === undefined || previous.width !== 2) {
            this.cells[index] = defaultCell();
          }
        } else if (cell.width !== 1) {
          this.cells[index] = defaultCell();
        }
      }
    }
  }

  /**
   * Write one cell. A wide symbol needs two columns; at the right edge it is
   * replaced by a blank so no half glyph exists. Writing over either half of
   * an existing wide glyph clears both halves first.
   */
  set(x: number, y: number, cell: Cell): void {
    if (!this.inBounds(x, y)) return;
    const normalized = normalizeSymbol(cell.symbol);
    if (normalized.width === 1) {
      this.repairAt(x, y);
      this.setRaw(x, y, {
        symbol: normalized.symbol,
        fg: cloneColor(cell.fg),
        bg: cloneColor(cell.bg),
        attrs: cell.attrs,
        width: 1,
      });
      return;
    }

    if (x + 1 >= this.width) {
      this.repairAt(x, y);
      this.setRaw(x, y, {
        symbol: ' ',
        fg: cloneColor(cell.fg),
        bg: cloneColor(cell.bg),
        attrs: cell.attrs,
        width: 1,
      });
      return;
    }

    this.repairAt(x, y);
    this.repairAt(x + 1, y);
    const style = { fg: cloneColor(cell.fg), bg: cloneColor(cell.bg), attrs: cell.attrs };
    this.setRaw(x, y, { symbol: normalized.symbol, fg: style.fg, bg: style.bg, attrs: style.attrs, width: 2 });
    this.setRaw(x + 1, y, { symbol: '', fg: style.fg, bg: style.bg, attrs: style.attrs, width: 0 });
  }

  /**
   * Write text starting at (x, y), one line only. Control sequences are
   * stripped. Newlines and tabs are ignored. Returns the first free x position
   * (clamped to the buffer width).
   */
  setString(x: number, y: number, text: string, style: Style = {}): number {
    if (y < 0 || y >= this.height) return x;

    const fg = style.fg ?? DEFAULT_COLOR;
    const bg = style.bg ?? DEFAULT_COLOR;
    const attrs = style.attrs ?? ATTR_NONE;
    let cursor = Math.floor(x);

    for (const raw of graphemeSegments(stripControlSequences(text))) {
      if (raw === '\n' || raw === '\t') continue;
      if (cursor < 0) continue;
      if (cursor >= this.width) break;
      const width = widthOfGrapheme(raw);
      if (width === 0) continue;
      if (cursor + width > this.width) {
        // A wide glyph cannot be split at the right edge. Blank the last
        // column instead of emitting a half glyph.
        this.set(cursor, y, { symbol: ' ', fg, bg, attrs, width: 1 });
        cursor += width;
        break;
      }
      this.set(cursor, y, { symbol: raw, fg, bg, attrs, width });
      cursor += width;
    }

    return Math.min(cursor, this.width);
  }

  /** Clear the whole buffer, or a clipped rectangular region. */
  clear(x = 0, y = 0, width = this.width, height = this.height): void {
    const columns = clampRegion(x, width, this.width);
    const rows = clampRegion(y, height, this.height);
    if (columns.end <= columns.start || rows.end <= rows.start) return;
    for (let row = rows.start; row < rows.end; row++) {
      const base = row * this.width;
      for (let column = columns.start; column < columns.end; column++) {
        this.cells[base + column] = defaultCell();
      }
    }
    this.repairAll();
  }

  /**
   * Fill the whole buffer or a clipped region. Passing a Style (or nothing)
   * fills blanks; passing a Cell repeats its symbol only when it is
   * single-width (wide fill symbols fall back to blanks with the same style).
   */
  fill(cellOrStyle: Cell | Style = {}, x = 0, y = 0, width = this.width, height = this.height): void {
    const cell = 'symbol' in cellOrStyle ? cellOrStyle : undefined;
    let symbol = ' ';
    if (cell !== undefined) {
      const normalized = normalizeSymbol(cell.symbol);
      if (normalized.width === 1) symbol = normalized.symbol;
    }
    const style: Style = cell === undefined
      ? (cellOrStyle as Style)
      : { fg: (cellOrStyle as Cell).fg, bg: (cellOrStyle as Cell).bg, attrs: (cellOrStyle as Cell).attrs };

    const columns = clampRegion(x, width, this.width);
    const rows = clampRegion(y, height, this.height);
    if (columns.end <= columns.start || rows.end <= rows.start) return;
    for (let row = rows.start; row < rows.end; row++) {
      for (let column = columns.start; column < columns.end; column++) {
        this.set(column, row, createCell(symbol, style));
      }
    }
  }

  /** Resize in place, preserving the overlapping top-left region. */
  resize(width: number, height: number): void {
    const nextWidth = normalizeDimension(width, 'width');
    const nextHeight = normalizeDimension(height, 'height');
    if (nextWidth === this.width && nextHeight === this.height) return;

    const next: Cell[] = new Array<Cell>(nextWidth * nextHeight);
    for (let i = 0; i < next.length; i++) next[i] = defaultCell();

    const copyWidth = Math.min(this.width, nextWidth);
    const copyHeight = Math.min(this.height, nextHeight);
    for (let row = 0; row < copyHeight; row++) {
      for (let column = 0; column < copyWidth; column++) {
        next[row * nextWidth + column] = cloneCell(this.cells[row * this.width + column]!);
      }
    }

    this.width = nextWidth;
    this.height = nextHeight;
    this.cells = next;
    this.repairAll();
  }

  /** Deep copy, including cells and their colors. */
  clone(): CellBuffer {
    const copy = new CellBuffer(this.width, this.height);
    for (let i = 0; i < this.cells.length; i++) {
      copy.cells[i] = cloneCell(this.cells[i]!);
    }
    return copy;
  }
}

/**
 * A front/back pair for double-buffered frame drawing. The renderer treats
 * front as what is currently on screen and diffs it against back.
 */
export class DoubleBuffer {
  front: CellBuffer;
  back: CellBuffer;

  constructor(width: number, height: number) {
    this.front = new CellBuffer(width, height);
    this.back = new CellBuffer(width, height);
  }

  get width(): number {
    return this.back.width;
  }

  get height(): number {
    return this.back.height;
  }

  swap(): void {
    const previousFront = this.front;
    this.front = this.back;
    this.back = previousFront;
  }

  resize(width: number, height: number): void {
    this.front.resize(width, height);
    this.back.resize(width, height);
  }

  /** Forget what is on screen so the next diff repaints everything. */
  invalidate(): void {
    this.front.clear();
  }

  clear(): void {
    this.front.clear();
    this.back.clear();
  }
}
