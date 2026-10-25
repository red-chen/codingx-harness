import { describe, expect, it } from 'vitest';
import {
  ATTR_BOLD,
  ATTR_DIM,
  ATTR_ITALIC,
  ATTR_REVERSE,
  ATTR_UNDERLINE,
  Attr,
  CellBuffer,
  DEFAULT_COLOR,
  DoubleBuffer,
  ansiColor,
  blankCell,
  cellsEqual,
  color256,
  colorsEqual,
  createCell,
  defaultCell,
  rgbColor,
  symbolWidth,
} from '../src/tui/terminal/buffer.js';

describe('cell model', () => {
  it('exports distinct attribute flags', () => {
    const flags = [ATTR_BOLD, ATTR_DIM, ATTR_ITALIC, ATTR_UNDERLINE, ATTR_REVERSE];
    expect(new Set(flags).size).toBe(5);
    expect(Attr.Bold).toBe(ATTR_BOLD);
    expect(Attr.Underline).toBe(ATTR_UNDERLINE);
    expect(Attr.Reverse).toBe(ATTR_REVERSE);
  });

  it('creates colors for default, 16, 256 and truecolor', () => {
    expect(DEFAULT_COLOR).toEqual({ type: 'default' });
    expect(ansiColor(300)).toEqual({ type: 'ansi', value: 15 });
    expect(ansiColor(-1)).toEqual({ type: 'ansi', value: 0 });
    expect(color256(999)).toEqual({ type: 'ansi256', value: 255 });
    expect(rgbColor(-5, 300, 12.7)).toEqual({ type: 'rgb', r: 0, g: 255, b: 12 });
    expect(colorsEqual(rgbColor(1, 2, 3), rgbColor(1, 2, 3))).toBe(true);
    expect(colorsEqual(rgbColor(1, 2, 3), ansiColor(1))).toBe(false);
  });

  it('creates default, blank and styled cells with display widths', () => {
    expect(defaultCell()).toEqual({
      symbol: ' ',
      fg: DEFAULT_COLOR,
      bg: DEFAULT_COLOR,
      attrs: 0,
      width: 1,
    });
    expect(blankCell({ attrs: ATTR_BOLD }).attrs).toBe(ATTR_BOLD);
    const wide = createCell('你', { fg: ansiColor(1) });
    expect(wide.symbol).toBe('你');
    expect(wide.width).toBe(2);
    expect(symbolWidth('你')).toBe(2);
    expect(symbolWidth('🚀')).toBe(2);
    expect(symbolWidth('a')).toBe(1);
    expect(symbolWidth('')).toBe(1);
  });

  it('compares cells including style and width', () => {
    const a = createCell('a', { fg: ansiColor(1) });
    const b = createCell('a', { fg: ansiColor(1) });
    expect(cellsEqual(a, b)).toBe(true);
    expect(cellsEqual(a, createCell('a', { fg: ansiColor(2) }))).toBe(false);
    expect(cellsEqual(createCell('a'), createCell('a', { attrs: ATTR_BOLD }))).toBe(false);
  });
});

describe('CellBuffer basics', () => {
  it('allocates a grid of default cells and reports dimensions', () => {
    const buffer = new CellBuffer(3, 2);
    expect(buffer.width).toBe(3);
    expect(buffer.height).toBe(2);
    expect(buffer.get(2, 1)).toMatchObject({ symbol: ' ', width: 1 });
    expect(buffer.get(0, 0)?.fg).toEqual(DEFAULT_COLOR);
  });

  it('is bounds safe for get and set', () => {
    const buffer = new CellBuffer(2, 2);
    expect(buffer.get(-1, 0)).toBeUndefined();
    expect(buffer.get(0, 2)).toBeUndefined();
    expect(buffer.get(1.5, 0)).toBeUndefined();
    expect(buffer.inBounds(1, 1)).toBe(true);
    expect(() => buffer.set(-1, 0, createCell('x'))).not.toThrow();
    expect(() => buffer.set(2, 0, createCell('x'))).not.toThrow();
    expect(buffer.get(0, 0)?.symbol).toBe(' ');
  });

  it('rejects invalid dimensions and accepts zero-size buffers', () => {
    expect(() => new CellBuffer(-1, 0)).toThrow(RangeError);
    expect(() => new CellBuffer(0, Number.NaN)).toThrow(RangeError);
    const empty = new CellBuffer(0, 0);
    expect(empty.get(0, 0)).toBeUndefined();
    expect(() => empty.clear()).not.toThrow();
    expect(() => empty.fill({})).not.toThrow();
    expect(() => empty.resize(0, 0)).not.toThrow();
  });

  it('writes strings with style and returns the next column', () => {
    const buffer = new CellBuffer(5, 1);
    const style = { fg: ansiColor(1), bg: color256(24), attrs: ATTR_BOLD };
    const next = buffer.setString(0, 0, 'AB', style);
    expect(next).toBe(2);
    expect(buffer.get(0, 0)).toMatchObject({ symbol: 'A', width: 1, fg: { type: 'ansi', value: 1 }, bg: { type: 'ansi256', value: 24 }, attrs: ATTR_BOLD });
    expect(buffer.get(1, 0)?.symbol).toBe('B');
    expect(buffer.get(2, 0)?.symbol).toBe(' ');
  });

  it('strips control sequences while writing', () => {
    const buffer = new CellBuffer(5, 1);
    buffer.setString(0, 0, '\x1b[31mred\x1b[0m');
    expect(buffer.get(0, 0)?.symbol).toBe('r');
    expect(buffer.get(2, 0)?.symbol).toBe('d');
    expect(buffer.get(3, 0)?.symbol).toBe(' ');
  });
});

describe('wide characters', () => {
  it('writes a wide glyph and its continuation cell', () => {
    const buffer = new CellBuffer(4, 1);
    buffer.setString(0, 0, '你a', { fg: ansiColor(2) });
    expect(buffer.get(0, 0)).toMatchObject({ symbol: '你', width: 2 });
    expect(buffer.get(1, 0)).toMatchObject({ symbol: '', width: 0 });
    expect(buffer.get(1, 0)?.fg).toEqual(ansiColor(2));
    expect(buffer.get(2, 0)).toMatchObject({ symbol: 'a', width: 1 });
  });

  it('writes emoji as a single wide glyph', () => {
    const buffer = new CellBuffer(4, 1);
    buffer.setString(0, 0, '🚀x');
    expect(buffer.get(0, 0)).toMatchObject({ symbol: '🚀', width: 2 });
    expect(buffer.get(1, 0)?.width).toBe(0);
    expect(buffer.get(2, 0)?.symbol).toBe('x');
  });

  it('repairs both halves when overwriting the leading cell', () => {
    const buffer = new CellBuffer(4, 1);
    buffer.setString(0, 0, '你');
    buffer.set(0, 0, createCell('x'));
    expect(buffer.get(0, 0)).toMatchObject({ symbol: 'x', width: 1 });
    expect(buffer.get(1, 0)).toMatchObject({ symbol: ' ', width: 1 });
  });

  it('repairs both halves when overwriting a continuation cell', () => {
    const buffer = new CellBuffer(4, 1);
    buffer.setString(0, 0, '你');
    buffer.set(1, 0, createCell('x'));
    expect(buffer.get(0, 0)).toMatchObject({ symbol: ' ', width: 1 });
    expect(buffer.get(1, 0)).toMatchObject({ symbol: 'x', width: 1 });
  });

  it('writes a wide glyph over two narrow cells', () => {
    const buffer = new CellBuffer(4, 1);
    buffer.setString(0, 0, 'abcd');
    buffer.set(1, 0, createCell('界'));
    expect(buffer.get(0, 0)?.symbol).toBe('a');
    expect(buffer.get(1, 0)).toMatchObject({ symbol: '界', width: 2 });
    expect(buffer.get(2, 0)?.width).toBe(0);
    expect(buffer.get(3, 0)?.symbol).toBe('d');
  });

  it('crops a wide glyph at the right edge instead of splitting it', () => {
    const buffer = new CellBuffer(3, 1);
    expect(buffer.setString(0, 0, '你好')).toBe(3);
    expect(buffer.get(0, 0)).toMatchObject({ symbol: '你', width: 2 });
    expect(buffer.get(1, 0)?.width).toBe(0);
    expect(buffer.get(2, 0)).toMatchObject({ symbol: ' ', width: 1 });

    const narrow = new CellBuffer(1, 1);
    narrow.set(0, 0, createCell('你'));
    expect(narrow.get(0, 0)).toMatchObject({ symbol: ' ', width: 1 });
  });

  it('clearing either half of a wide glyph clears both', () => {
    const buffer = new CellBuffer(4, 1);
    buffer.setString(0, 0, '你好');
    buffer.clear(0, 0, 1, 1);
    expect(buffer.get(0, 0)?.symbol).toBe(' ');
    expect(buffer.get(1, 0)?.symbol).toBe(' ');
    expect(buffer.get(2, 0)?.symbol).toBe('好');

    buffer.clear(2, 0, 1, 1);
    expect(buffer.get(2, 0)?.symbol).toBe(' ');
    expect(buffer.get(3, 0)?.symbol).toBe(' ');
  });
});

describe('clear, fill, resize and clone', () => {
  it('fills styles and symbols across the whole buffer or a region', () => {
    const buffer = new CellBuffer(3, 2);
    buffer.fill({ bg: ansiColor(4) });
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 3; x++) {
        expect(buffer.get(x, y)).toMatchObject({ symbol: ' ', bg: { type: 'ansi', value: 4 } });
      }
    }

    buffer.fill(createCell('x', { attrs: ATTR_BOLD }), 1, 0, 2, 1);
    expect(buffer.get(0, 0)?.symbol).toBe(' ');
    expect(buffer.get(1, 0)).toMatchObject({ symbol: 'x', attrs: ATTR_BOLD });
    expect(buffer.get(2, 0)?.symbol).toBe('x');
    expect(buffer.get(1, 1)?.symbol).toBe(' ');
  });

  it('grows while preserving existing content and fills new cells', () => {
    const buffer = new CellBuffer(2, 1);
    buffer.setString(0, 0, 'ab');
    buffer.resize(4, 2);
    expect(buffer.width).toBe(4);
    expect(buffer.height).toBe(2);
    expect(buffer.get(0, 0)?.symbol).toBe('a');
    expect(buffer.get(1, 0)?.symbol).toBe('b');
    expect(buffer.get(2, 0)?.symbol).toBe(' ');
    expect(buffer.get(0, 1)?.symbol).toBe(' ');
  });

  it('shrinks and repairs a wide glyph cut at the new right edge', () => {
    const buffer = new CellBuffer(4, 1);
    buffer.setString(0, 0, '你好');
    buffer.resize(3, 1);
    expect(buffer.get(0, 0)).toMatchObject({ symbol: '你', width: 2 });
    expect(buffer.get(1, 0)?.width).toBe(0);
    expect(buffer.get(2, 0)).toMatchObject({ symbol: ' ', width: 1 });

    buffer.resize(1, 1);
    expect(buffer.get(0, 0)).toMatchObject({ symbol: ' ', width: 1 });
  });

  it('shrinks height and drops rows outside the new size', () => {
    const buffer = new CellBuffer(2, 2);
    buffer.setString(0, 0, 'ab');
    buffer.setString(0, 1, 'cd');
    buffer.resize(2, 1);
    expect(buffer.height).toBe(1);
    expect(buffer.get(0, 0)?.symbol).toBe('a');
  });

  it('clones independently', () => {
    const buffer = new CellBuffer(3, 1);
    buffer.setString(0, 0, 'ab', { fg: ansiColor(1) });
    const clone = buffer.clone();
    expect(clone.width).toBe(3);
    expect(clone.get(0, 0)?.symbol).toBe('a');
    clone.setString(0, 0, 'XY');
    expect(clone.get(0, 0)?.symbol).toBe('X');
    expect(buffer.get(0, 0)?.symbol).toBe('a');
    expect(buffer.get(1, 0)?.symbol).toBe('b');
    expect(clone.get(1, 0)?.symbol).toBe('Y');

    clone.get(0, 0)!.fg = rgbColor(9, 9, 9);
    expect(buffer.get(0, 0)?.fg).toEqual(ansiColor(1));
  });
});

describe('DoubleBuffer', () => {
  it('holds independent front and back buffers and swaps them', () => {
    const double = new DoubleBuffer(4, 2);
    double.back.setString(0, 0, 'next');
    expect(double.front.get(0, 0)?.symbol).toBe(' ');
    const previousFront = double.front;
    const previousBack = double.back;
    double.swap();
    expect(double.front).toBe(previousBack);
    expect(double.back).toBe(previousFront);
    expect(double.front.get(0, 0)?.symbol).toBe('n');
    expect(double.back.get(0, 0)?.symbol).toBe(' ');
  });

  it('resizes both buffers and can invalidate/clear them', () => {
    const double = new DoubleBuffer(2, 1);
    double.front.setString(0, 0, 'fr');
    double.back.setString(0, 0, 'bk');
    double.resize(5, 3);
    expect(double.width).toBe(5);
    expect(double.height).toBe(3);
    expect(double.front.width).toBe(5);
    expect(double.back.width).toBe(5);
    expect(double.front.get(0, 0)?.symbol).toBe('f');
    expect(double.back.get(0, 0)?.symbol).toBe('b');

    double.invalidate();
    expect(double.front.get(0, 0)?.symbol).toBe(' ');
    expect(double.back.get(0, 0)?.symbol).toBe('b');

    double.clear();
    expect(double.front.get(0, 0)?.symbol).toBe(' ');
    expect(double.back.get(0, 0)?.symbol).toBe(' ');
  });
});
