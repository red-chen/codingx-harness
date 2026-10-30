import { describe, expect, it } from 'vitest';
import { createFileDiff } from '../src/tools/file-diff.js';
import { TuiApp } from '../src/tui/state/app.js';
import { restoreTranscript } from '../src/tui/state/restore.js';
import { TUI_COLORS, type ExecCell } from '../src/tui/state/types.js';
import { displayWidth } from '../src/tui/text/index.js';
import { CellBuffer } from '../src/tui/terminal/buffer.js';
import { buildExecCellLines, layoutTranscript, renderTranscript } from '../src/tui/widgets/transcript.js';
import type { StyledTextLine } from '../src/tui/widgets/welcome.js';

const plain = (lines: readonly StyledTextLine[]): string => lines.map((line) => line.segments.map((s) => s.text).join('')).join('\n');
function cell(id: string, path = 'src/a.ts', before = 'const old = 1;\n', after = 'const next = 2;\n'): ExecCell {
  return { type: 'exec', id, callId: id, name: 'Edit', command: 'Edit ' + path,
    output: 'Edited ' + path, running: false, isError: false, fileDiffs: [createFileDiff(path, before, after)] };
}

describe('Edited transcript', () => {
  it('shows colored totals, path, old/new line numbers and full-width row backgrounds', () => {
    const lines = buildExecCellLines(cell('a'), 80);
    expect(plain(lines)).toContain('Edited 1 file (+1 -1)');
    expect(plain(lines)).toContain('└ src/a.ts (+1 -1)');
    expect(plain(lines)).toMatch(/1 - const old = 1;/u);
    expect(plain(lines)).toMatch(/1 \+ const next = 2;/u);
    expect(lines.find((line) => plain([line]).includes('old ='))?.background).toEqual(TUI_COLORS.diffDelBg);
    expect(lines.find((line) => plain([line]).includes('next ='))?.background).toEqual(TUI_COLORS.diffAddBg);
    expect(lines[0]?.segments.find((s) => s.text === '+1')?.style.fg).toEqual(TUI_COLORS.diffAdd);
    const buffer = new CellBuffer(80, 20);
    renderTranscript({ x: 0, y: 0, width: 80, height: 20 }, buffer, { cells: [cell('a')] });
    const removalRow = lines.findIndex((line) => plain([line]).includes('old ='));
    expect(buffer.get(79, removalRow)?.bg).toEqual(TUI_COLORS.diffDelBg);
  });

  it('groups consecutive successful writes by unique path but separates errors and other tools', () => {
    const cells: ExecCell[] = [cell('a'), { ...cell('b', 'b.ts'), name: 'Write' }, cell('c'),
      { ...cell('failed'), isError: true, output: 'Permission denied' },
      { ...cell('shell'), fileDiffs: undefined, name: 'Shell', command: 'npm test', output: 'passed' }];
    const text = plain(layoutTranscript({ cells }, 80, 100).lines);
    expect(text).toContain('Edited 2 files (+3 -3)');
    expect(text).toContain('src/a.ts (+2 -2)');
    expect(text.match(/• Edited/gu)).toHaveLength(1);
    expect(text).toContain('Permission denied');
    expect(text).toContain('Ran npm test');
  });

  it('previews three rendered rows per file and expands all retained changes', () => {
    const c = cell('a', 'a.txt', '', Array.from({ length: 12 }, (_, i) => 'line' + i + '\n').join(''));
    const collapsed = plain(buildExecCellLines(c, 60));
    expect(collapsed).toContain('line2');
    expect(collapsed).not.toContain('line3');
    expect(collapsed).toContain('Show details (Ctrl+O)');
    expect(plain(buildExecCellLines({ ...c, expanded: true }, 60))).toContain('line11');
  });

  it('wraps CJK/code without changing whitespace or leaking control sequences', () => {
    const c = { ...cell('a', '测试.ts', '', '\tconst 中文 = "你好世界";\u001b[2J\n'), expanded: true };
    for (const width of [12, 30, 80]) {
      const lines = buildExecCellLines(c, width);
      expect(plain(lines)).not.toContain('\u001b');
      expect(lines.every((line) => displayWidth(plain([line])) <= width)).toBe(true);
      expect(lines.filter((line) => line.background).length).toBeGreaterThan(0);
    }
    const rows = buildExecCellLines(c, 80).filter((line) => line.background);
    expect(plain(rows)).toContain('+     const 中文');
  });

  it('retains metadata through live events, Ctrl+O and offline replay', () => {
    const app = new TuiApp({ session: { sessionId: 's', cwd: '/tmp', model: 'm' }, version: 'test', width: 80, height: 24 });
    const fileDiffs = cell('a').fileDiffs!;
    app.handleEvent({ type: 'tool.started', turnId: 't', call: { id: 'a', name: 'Edit', input: { path: 'src/a.ts' } } });
    app.handleEvent({ type: 'tool.finished', turnId: 't', callId: 'a', name: 'Edit', durationMs: 1,
      result: { content: 'Edited', meta: { fileDiffs } } });
    expect(app.state.transcript[0]).toMatchObject({ fileDiffs, running: false });
    app.handleKey({ type: 'key', code: 'o', mods: { ctrl: true, alt: false, shift: false, meta: false } });
    expect(app.state.transcript[0]).toMatchObject({ expanded: true });
    const restored = restoreTranscript([
      { seq: 1, ts: '', eventId: '1', type: 'tool.call', callId: 'a', name: 'Edit', input: { path: 'src/a.ts' } },
      { seq: 2, ts: '', eventId: '2', type: 'tool.result', callId: 'a', content: 'Edited', meta: { fileDiffs } },
    ]);
    expect(restored[0]).toMatchObject({ fileDiffs, running: false });
    expect(plain(layoutTranscript({ cells: restored }, 80, 30).lines)).toContain('Edited 1 file');
  });
});
