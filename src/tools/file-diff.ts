import { z } from 'zod';

const lineSchema = z.object({
  kind: z.enum(['add', 'remove']),
  line: z.number().int().positive(),
  text: z.string(),
  noNewline: z.boolean().optional(),
});

const fileSchema = z.object({
  path: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  lines: z.array(lineSchema),
  truncated: z.boolean(),
  approximate: z.boolean(),
});

/** Bounded, replayable UI metadata. Never sent as model tool output. */
export type FileDiff = z.infer<typeof fileSchema>;
export type FileDiffLine = z.infer<typeof lineSchema>;

export function readFileDiffs(meta: unknown): FileDiff[] | undefined {
  const parsed = z.object({ fileDiffs: z.array(fileSchema) }).safeParse(meta);
  return parsed.success && parsed.data.fileDiffs.length > 0 ? parsed.data.fileDiffs : undefined;
}

const MAX_LINES = 400;
const MAX_CHARS = 64_000;
const MAX_WORK = 250_000;

/** Keep line endings in comparisons so EOF-only changes remain visible. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

/** Myers shortest edit script, with bounded work/storage for wholesale rewrites. */
function matchingLines(a: string[], b: string[]): [number, number][] | undefined {
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  let work = 0;
  for (let d = 0; d <= a.length + b.length; d++) {
    trace.push(frontier);
    const next = new Map<number, number>();
    for (let k = -d; k <= d; k += 2) {
      if (++work > MAX_WORK) return undefined;
      const down = frontier.get(k + 1) ?? -1;
      const right = frontier.get(k - 1) ?? -1;
      let x = k === -d || (k !== d && right < down) ? down : right + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x++; y++;
        if (++work > MAX_WORK) return undefined;
      }
      next.set(k, x);
      if (x >= a.length && y >= b.length) {
        const matches: [number, number][] = [];
        for (let depth = d; depth > 0; depth--) {
          const previous = trace[depth]!;
          const diagonal = x - y;
          const previousK = diagonal === -depth || (diagonal !== depth &&
            (previous.get(diagonal - 1) ?? -1) < (previous.get(diagonal + 1) ?? -1))
            ? diagonal + 1 : diagonal - 1;
          const previousX = previous.get(previousK)!;
          const previousY = previousX - previousK;
          while (x > previousX && y > previousY) matches.push([--x, --y]);
          x = previousX; y = previousY;
        }
        while (x > 0 && y > 0) matches.push([--x, --y]);
        return matches.reverse();
      }
    }
    frontier = next;
  }
  return undefined;
}

export function createFileDiff(path: string, before: string, after: string): FileDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) { aEnd--; bEnd--; }
  const matches = aEnd === start || bEnd === start ? []
    : matchingLines(a.slice(start, aEnd), b.slice(start, bEnd));
  const result: FileDiff = {
    path, additions: 0, deletions: 0, lines: [], truncated: false, approximate: matches === undefined,
  };
  let chars = 0;
  const add = (kind: FileDiffLine['kind'], index: number, raw: string): void => {
    if (kind === 'add') result.additions++; else result.deletions++;
    if (result.lines.length >= MAX_LINES || chars >= MAX_CHARS) { result.truncated = true; return; }
    const text = raw.replace(/\r?\n$/u, '');
    const shown = text.slice(0, Math.max(0, MAX_CHARS - chars));
    chars += shown.length;
    if (shown.length < text.length) result.truncated = true;
    result.lines.push({ kind, line: index + 1, text: shown,
      ...(!raw.endsWith('\n') ? { noNewline: true } : {}) });
  };
  let old = start;
  let current = start;
  const anchors: [number, number][] = (matches ?? []).map(([x, y]) => [x + start, y + start]);
  anchors.push([aEnd, bEnd]);
  for (const [oldMatch, newMatch] of anchors) {
    while (old < oldMatch) { add('remove', old, a[old]!); old++; }
    while (current < newMatch) { add('add', current, b[current]!); current++; }
    old++; current++;
  }
  return result;
}
