import { describe, expect, it } from 'vitest';
import {
  Constraints,
  length,
  max,
  min,
  percent,
  rect,
  split,
  splitHorizontal,
  splitVertical,
} from '../src/tui/layout/index.js';
import type { Constraint, Rect } from '../src/tui/layout/index.js';

function widths(rects: Rect[]): number[] {
  return rects.map((item) => item.width);
}

function heights(rects: Rect[]): number[] {
  return rects.map((item) => item.height);
}

describe('constraints', () => {
  it('builds length, percent, min and max constraints', () => {
    expect(length(4)).toEqual({ type: 'length', value: 4 });
    expect(percent(25)).toEqual({ type: 'percent', value: 25 });
    expect(min(2)).toEqual({ type: 'min', value: 2 });
    expect(max(8)).toEqual({ type: 'max', value: 8 });
    expect(Constraints.percent(50)).toEqual(percent(50));
  });

  it('accepts a reusable Constraint type', () => {
    const constraints: Constraint[] = [length(2), min(0)];
    const area: Rect = { x: 0, y: 0, width: 10, height: 1 };
    expect(widths(split(area, constraints))).toEqual([2, 8]);
  });

  it('normalizes rectangles and clamps negative sizes', () => {
    expect(rect(1, 2, 3.9, -1)).toEqual({ x: 1, y: 2, width: 3, height: 0 });
    expect(rect(0, 0, Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('horizontal split', () => {
  it('lays out fixed lengths left to right without overlap', () => {
    const area = { x: 0, y: 0, width: 100, height: 10 };
    const result = split(area, [length(10), length(20), length(30)]);
    expect(widths(result)).toEqual([10, 20, 30]);
    expect(result.map((item) => item.x)).toEqual([0, 10, 30]);
    expect(result.map((item) => item.height)).toEqual([10, 10, 10]);
    expect(result.every((item) => item.y === 0)).toBe(true);
  });

  it('resolves percentages and clamps them to the axis', () => {
    const area = { x: 0, y: 0, width: 100, height: 4 };
    expect(widths(split(area, [percent(25), percent(75)]))).toEqual([25, 75]);
    expect(widths(split({ ...area, width: 10 }, [percent(50), percent(50)]))).toEqual([5, 5]);
    expect(widths(split({ ...area, width: 5 }, [percent(50), percent(50)]))).toEqual([3, 2]);
    expect(widths(split(area, [percent(150)]))).toEqual([100]);
  });

  it('lets min constraints absorb leftover space', () => {
    const area = { x: 0, y: 0, width: 80, height: 1 };
    expect(widths(split(area, [length(1), min(0)]))).toEqual([1, 79]);
    expect(widths(split(area, [min(5), min(5)]))).toEqual([40, 40]);
    expect(widths(split({ ...area, width: 101 }, [percent(50), min(0)]))).toEqual([51, 50]);
  });

  it('lets max constraints grow up to their cap and leaves excess unused', () => {
    const area = { x: 0, y: 0, width: 10, height: 1 };
    expect(widths(split(area, [length(2), max(5)]))).toEqual([2, 5]);
    expect(widths(split(area, [max(5)]))).toEqual([5]);
    expect(widths(split(area, [max(8), max(4)]))).toEqual([6, 4]);
  });

  it('clamps when constraints over-allocate', () => {
    const area = { x: 0, y: 0, width: 100, height: 1 };
    expect(widths(split(area, [length(80), length(80)]))).toEqual([80, 20]);
    expect(widths(split({ ...area, width: 80 }, [length(200)]))).toEqual([80]);
    const sizes = widths(split(area, [percent(150), percent(150)]));
    expect(sizes.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(100);
  });

  it('treats invalid constraint values as zero', () => {
    const area = { x: 0, y: 0, width: 20, height: 1 };
    expect(widths(split(area, [length(-10)]))).toEqual([0]);
    expect(widths(split(area, [percent(Number.NaN)]))).toEqual([0]);
    expect(widths(split(area, [length(Number.POSITIVE_INFINITY)]))).toEqual([0]);
    expect(widths(split(area, [length(10), min(-5)]))).toEqual([10, 10]);
  });

  it('is deterministic and stable across repeated calls', () => {
    const area = { x: 0, y: 0, width: 5, height: 1 };
    const constraints = [percent(50), percent(50)];
    const first = split(area, constraints);
    for (let i = 0; i < 10; i++) {
      expect(split(area, constraints)).toEqual(first);
    }
    expect(widths(first)).toEqual([3, 2]);
  });
});

describe('vertical split and nesting', () => {
  it('lays out top to bottom and keeps full width', () => {
    const area = { x: 5, y: 2, width: 20, height: 10 };
    const result = splitVertical(area, [length(3), min(0)]);
    expect(heights(result)).toEqual([3, 7]);
    expect(result.map((item) => item.y)).toEqual([2, 5]);
    expect(result.map((item) => item.x)).toEqual([5, 5]);
    expect(result.map((item) => item.width)).toEqual([20, 20]);
  });

  it('supports an explicit direction argument', () => {
    const area = { x: 0, y: 0, width: 6, height: 10 };
    const vertical = split(area, [length(2), length(3)], 'vertical');
    expect(heights(vertical)).toEqual([2, 3]);
    expect(widths(vertical)).toEqual([6, 6]);
    expect(splitHorizontal(area, [length(2), length(3)])).toEqual(split(area, [length(2), length(3)], 'horizontal'));
  });

  it('composes nested splits', () => {
    const screen = { x: 0, y: 0, width: 80, height: 24 };
    const [header, body] = splitVertical(screen, [length(1), min(0)]);
    expect(header).toEqual({ x: 0, y: 0, width: 80, height: 1 });
    expect(body).toEqual({ x: 0, y: 1, width: 80, height: 23 });

    const [left, right] = splitHorizontal(body!, [percent(25), min(0)]);
    expect(left).toEqual({ x: 0, y: 1, width: 20, height: 23 });
    expect(right).toEqual({ x: 20, y: 1, width: 60, height: 23 });

    const [composer, footer] = splitVertical(right!, [min(1), length(1)]);
    expect(composer).toEqual({ x: 20, y: 1, width: 60, height: 22 });
    expect(footer).toEqual({ x: 20, y: 23, width: 60, height: 1 });
  });

  it('handles the 80x24 and 120x40 target sizes', () => {
    const narrow = splitHorizontal({ x: 0, y: 0, width: 80, height: 24 }, [percent(25), min(0)]);
    expect(widths(narrow)).toEqual([20, 60]);
    expect(narrow.every((item) => item.height === 24)).toBe(true);

    const wide = splitHorizontal({ x: 0, y: 0, width: 120, height: 40 }, [percent(25), min(0)]);
    expect(widths(wide)).toEqual([30, 90]);
    const rows = splitVertical({ x: 0, y: 0, width: 120, height: 40 }, [length(1), percent(10), min(0)]);
    expect(heights(rows)).toEqual([1, 4, 35]);
  });
});

describe('edge cases', () => {
  it('returns no rectangles for no constraints', () => {
    expect(split({ x: 0, y: 0, width: 10, height: 10 }, [])).toEqual([]);
  });

  it('is zero-size safe horizontally and vertically', () => {
    const zeroWidth = { x: 0, y: 0, width: 0, height: 10 };
    const horizontal = split(zeroWidth, [length(5), min(0)]);
    expect(widths(horizontal)).toEqual([0, 0]);
    expect(horizontal.map((item) => item.height)).toEqual([10, 10]);

    const zeroHeight = { x: 0, y: 0, width: 10, height: 0 };
    const vertical = splitVertical(zeroHeight, [length(5), min(0)]);
    expect(heights(vertical)).toEqual([0, 0]);
    expect(vertical.every((item) => item.width === 10)).toBe(true);

    const empty = splitVertical({ x: 0, y: 0, width: 0, height: 0 }, [percent(50), max(3)]);
    expect(empty).toEqual([
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 0, y: 0, width: 0, height: 0 },
    ]);
  });

  it('clamps negative and fractional area sizes', () => {
    const result = split({ x: 1, y: 2, width: -20, height: 3.9 }, [length(2), min(0)]);
    expect(result.map((item) => item.width)).toEqual([0, 0]);
    expect(result.every((item) => item.height === 3)).toBe(true);
  });
});
