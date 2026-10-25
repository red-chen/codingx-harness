/** Integer terminal rectangle. Width and height are always non-negative. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutDirection = 'horizontal' | 'vertical';

/**
 * A layout constraint for one axis. Values are in terminal cells:
 * - length: exact preferred size
 * - percent: percentage (0..100) of the available axis
 * - min: at least this many cells, may absorb leftover space
 * - max: at most this many cells, receiving space only after fixed/min parts
 */
export type Constraint =
  | { type: 'length'; value: number }
  | { type: 'percent'; value: number }
  | { type: 'min'; value: number }
  | { type: 'max'; value: number };

export function length(value: number): Constraint {
  return { type: 'length', value };
}

export function percent(value: number): Constraint {
  return { type: 'percent', value };
}

export function min(value: number): Constraint {
  return { type: 'min', value };
}

export function max(value: number): Constraint {
  return { type: 'max', value };
}

export const Constraints = { length, percent, min, max } as const;

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width: normalizeSize(width), height: normalizeSize(height) };
}

function normalizeSize(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeOrigin(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(maxValue, Math.max(minValue, value));
}

interface Span {
  preferred: number;
  max: number;
}

function spanFor(constraint: Constraint, available: number): Span {
  const value = Number.isFinite(constraint.value) ? Math.max(0, constraint.value) : 0;
  switch (constraint.type) {
    case 'length': {
      const amount = clamp(Math.round(value), 0, available);
      return { preferred: amount, max: amount };
    }
    case 'percent': {
      const percentage = clamp(value, 0, 100);
      const amount = clamp(Math.round((available * percentage) / 100), 0, available);
      return { preferred: amount, max: amount };
    }
    case 'min': {
      const amount = clamp(Math.round(value), 0, available);
      return { preferred: amount, max: available };
    }
    case 'max': {
      const amount = clamp(Math.round(value), 0, available);
      return { preferred: 0, max: amount };
    }
  }
}

function allocate(available: number, constraints: readonly Constraint[]): number[] {
  const spans = constraints.map((constraint) => spanFor(constraint, available));
  const sizes = new Array<number>(spans.length).fill(0);

  let remaining = available;
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index]!;
    const size = Math.min(span.preferred, remaining);
    sizes[index] = size;
    remaining -= size;
  }

  // Give unallocated space to flexible constraints (min/max), round-robin and
  // capped. If every constraint is fixed, the tail of the area stays unused.
  while (remaining > 0) {
    let progressed = false;
    for (let index = 0; index < spans.length && remaining > 0; index++) {
      if (sizes[index]! < spans[index]!.max) {
        sizes[index] = sizes[index]! + 1;
        remaining--;
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  return sizes;
}

/**
 * Split an area into consecutive rectangles.
 *
 * horizontal lays constraints left-to-right (each rect gets full height);
 * vertical lays them top-to-bottom (each rect gets full width). Sizes are
 * integer, clamped so their sum never exceeds the axis, and deterministic for
 * the same input. Percentages are rounded independently; rounding remainders
 * are not redistributed unless a min/max constraint can absorb them.
 */
export function split(
  area: Rect,
  constraints: readonly Constraint[],
  direction: LayoutDirection = 'horizontal',
): Rect[] {
  if (constraints.length === 0) return [];

  const x = normalizeOrigin(area.x);
  const y = normalizeOrigin(area.y);
  const width = normalizeSize(area.width);
  const height = normalizeSize(area.height);
  const available = direction === 'horizontal' ? width : height;
  const cross = direction === 'horizontal' ? height : width;
  const sizes = allocate(available, constraints);

  const result: Rect[] = [];
  let offset = 0;
  for (const size of sizes) {
    if (direction === 'horizontal') {
      result.push({ x: x + offset, y, width: size, height: cross });
    } else {
      result.push({ x, y: y + offset, width: cross, height: size });
    }
    offset += size;
  }
  return result;
}

export function splitHorizontal(area: Rect, constraints: readonly Constraint[]): Rect[] {
  return split(area, constraints, 'horizontal');
}

export function splitVertical(area: Rect, constraints: readonly Constraint[]): Rect[] {
  return split(area, constraints, 'vertical');
}
