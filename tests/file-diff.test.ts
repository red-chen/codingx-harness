import { describe, expect, it } from 'vitest';
import { createFileDiff, readFileDiffs } from '../src/tools/file-diff.js';

describe('file diff metadata', () => {
  it('uses original/new line numbers across separated replacements and insertions', () => {
    const diff = createFileDiff('a.ts', 'head\nold\nkeep\ntail\n', 'head\nnew\nextra\nkeep\nend\n');
    expect(diff).toMatchObject({ additions: 3, deletions: 2, truncated: false, approximate: false });
    expect(diff.lines).toEqual([
      { kind: 'remove', line: 2, text: 'old' },
      { kind: 'add', line: 2, text: 'new' },
      { kind: 'add', line: 3, text: 'extra' },
      { kind: 'remove', line: 4, text: 'tail' },
      { kind: 'add', line: 5, text: 'end' },
    ]);
  });

  it('handles empty files, CRLF, trailing blank lines and EOF-only edits', () => {
    expect(createFileDiff('a', '', '')).toMatchObject({ additions: 0, deletions: 0, lines: [] });
    expect(createFileDiff('a', '', 'one\n\n')).toMatchObject({ additions: 2, deletions: 0 });
    expect(createFileDiff('a', 'one\n', '')).toMatchObject({ additions: 0, deletions: 1 });
    expect(createFileDiff('a', 'one\r\n', 'two\r\n').lines.map((line) => line.text)).toEqual(['one', 'two']);
    expect(createFileDiff('a', 'one', 'one\n').lines).toEqual([
      { kind: 'remove', line: 1, text: 'one', noNewline: true },
      { kind: 'add', line: 1, text: 'one' },
    ]);
  });

  it('reconstructs varied repeated-line edits with minimal counts', () => {
    let seed = 13;
    const next = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0);
    for (let trial = 0; trial < 150; trial++) {
      const a = Array.from({ length: next() % 15 }, () => String(next() % 5));
      const b = Array.from({ length: next() % 15 }, () => String(next() % 5));
      const diff = createFileDiff('a', a.map((s) => s + '\n').join(''), b.map((s) => s + '\n').join(''));
      const removed = new Set(diff.lines.filter((line) => line.kind === 'remove').map((line) => line.line));
      const rebuilt = a.filter((_, index) => !removed.has(index + 1));
      for (const line of diff.lines.filter((line) => line.kind === 'add')) rebuilt.splice(line.line - 1, 0, line.text);
      expect(rebuilt).toEqual(b);
      // Independent dynamic-programming oracle for shortest insertion/deletion distance.
      const distance = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
      for (let i = 0; i <= a.length; i++) {
        for (let j = 0; j <= b.length; j++) {
          distance[i]![j] = i === 0 ? j : j === 0 ? i : a[i - 1] === b[j - 1]
            ? distance[i - 1]![j - 1]! : Math.min(distance[i - 1]![j]!, distance[i]![j - 1]!) + 1;
        }
      }
      expect(diff.additions + diff.deletions).toBe(distance[a.length]![b.length]);
    }
  });

  it('bounds large previews and pathological rewrites without losing change counts', () => {
    const many = createFileDiff('a', '', 'line\n'.repeat(10_000));
    expect(many).toMatchObject({ additions: 10_000, deletions: 0, truncated: true });
    expect(many.lines).toHaveLength(400);
    const long = createFileDiff('a', '', 'x'.repeat(100_000));
    expect(long.truncated).toBe(true);
    expect(long.lines[0]?.text.length).toBe(64_000);
    const rewrite = createFileDiff('a', 'old\n'.repeat(2000), 'new\n'.repeat(2000));
    expect(rewrite).toMatchObject({ additions: 2000, deletions: 2000, approximate: true });
  });

  it('rejects malformed/legacy metadata without breaking history rendering', () => {
    expect(readFileDiffs(undefined)).toBeUndefined();
    expect(readFileDiffs({ fileDiffs: [{ path: 'x' }] })).toBeUndefined();
    const diff = createFileDiff('a', '', 'hi\n');
    expect(readFileDiffs({ fileDiffs: [diff] })).toEqual([diff]);
  });
});
