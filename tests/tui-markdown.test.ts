import { describe, expect, it } from 'vitest';
import { renderMarkdown, parseInlineMarkdown, wrapStyledSegments } from '../src/tui/widgets/markdown.js';
import { buildAssistantTextLines, buildExecCellLines } from '../src/tui/widgets/transcript.js';
import { TUI_COLORS } from '../src/tui/state/types.js';
import type { ExecCell } from '../src/tui/state/types.js';

function plain(lines: ReturnType<typeof renderMarkdown>): string[] {
  return lines.map((line) => line.segments.map((segment) => segment.text).join(''));
}

describe('markdown renderer', () => {
  it('renders headings, inline emphasis/code/links and bullets', () => {
    const lines = renderMarkdown(
      '# Title\n\nA **bold** and `code` with [link](https://example.com).\n\n- first\n- second',
      60,
    );
    const text = plain(lines);
    expect(text[0]).toContain('Title');
    expect(text.join('\n')).toContain('A bold and code with link.');
    expect(text.some((line) => line.includes('• first'))).toBe(true);
    const heading = lines[0]?.segments[0];
    expect(heading?.style.attrs).toBe(1);
    const allSegments = lines.flatMap((line) => line.segments);
    expect(allSegments.some((segment) => segment.text === 'code' && segment.style.fg === TUI_COLORS.accent)).toBe(true);
    expect(allSegments.some((segment) => segment.text === 'link' && segment.style.attrs === 8)).toBe(true);
  });

  it('styles fenced code and diff lines, including unclosed fences', () => {
    const lines = renderMarkdown(
      'before\n\n```ts\nconst x = 1;\n```\n\n```diff\n+add\n-remove\n@@ hunk\n```\n\n```\nstreaming',
      40,
    );
    const text = plain(lines);
    expect(text.join('\n')).toContain('const x = 1;');
    expect(text.join('\n')).toContain('streaming');
    const codeLine = lines.find((line) => line.segments.some((segment) => segment.text === 'const x = 1;'));
    expect(codeLine?.background).toBeDefined();
    const add = lines.find((line) => line.segments.some((segment) => segment.text === '+add'));
    const remove = lines.find((line) => line.segments.some((segment) => segment.text === '-remove'));
    const meta = lines.find((line) => line.segments.some((segment) => segment.text === '@@ hunk'));
    expect(add?.segments[0]?.style.fg).toBe(TUI_COLORS.success);
    expect(remove?.segments[0]?.style.fg).toBe(TUI_COLORS.error);
    expect(meta?.segments[0]?.style.fg).toBe(TUI_COLORS.accent);
  });

  it('wraps wide CJK text without splitting graphemes', () => {
    const lines = renderMarkdown('你好🚀世界'.repeat(6), 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      const width = line.segments.reduce((sum, segment) => sum + [...segment.text].length, 0);
      expect(width).toBeLessThanOrEqual(10);
    }
    const joined = plain(lines).join('');
    expect(joined).toContain('你好');
    expect(joined).toContain('🚀');
  });

  it('parses inline tokens with a plain fallback for incomplete emphasis', () => {
    const segments = parseInlineMarkdown('a **bold** b `code` c *italic* d [x](u) e');
    expect(segments.map((segment) => segment.text)).toContain('bold');
    expect(segments.map((segment) => segment.text)).toContain('code');
    expect(segments.map((segment) => segment.text)).toContain('italic');
    expect(segments.map((segment) => segment.text)).toContain('x');
    const incomplete = parseInlineMarkdown('a **still streaming');
    expect(incomplete.map((segment) => segment.text).join('')).toBe('a **still streaming');
  });

  it('wraps styled segments and preserves style boundaries', () => {
    const lines = wrapStyledSegments([
      { text: 'a'.repeat(5), style: { attrs: 1 } },
      { text: 'b'.repeat(7), style: { attrs: 2 } },
    ], 6);
    expect(lines.map((line) => line.map((segment) => segment.text).join(''))).toEqual(['aaaaab', 'bbbbbb']);
    expect(lines[0]?.map((segment) => segment.style.attrs)).toEqual([1, 2]);
  });
});

describe('transcript message units', () => {
  it('prefixes markdown assistant lines and keeps code backgrounds', () => {
    const lines = buildAssistantTextLines('# Heading\n```\ncode\n```', 30);
    expect(lines[0]?.segments[0]?.text).toBe('• ');
    const codeLine = lines.find((line) => line.segments.some((segment) => segment.text === 'code'));
    expect(codeLine?.background).toBeDefined();
  });

  it('colors exec diff output and honors error output', () => {
    const base: ExecCell = {
      type: 'exec',
      id: 'e1',
      callId: 'c1',
      name: 'shell',
      command: 'git diff',
      output: '+added\n-removed\n@@ hunk\ncontext',
      isError: false,
      running: false,
    };
    const lines = buildExecCellLines(base, 60);
    const added = lines.find((line) => line.segments.some((segment) => segment.text === '+added'));
    const removed = lines.find((line) => line.segments.some((segment) => segment.text === '-removed'));
    const hunk = lines.find((line) => line.segments.some((segment) => segment.text === '@@ hunk'));
    expect(added?.segments[1]?.style.fg).toBe(TUI_COLORS.success);
    expect(removed?.segments[1]?.style.fg).toBe(TUI_COLORS.error);
    expect(hunk?.segments[1]?.style.fg).toBe(TUI_COLORS.accent);

    const failed = buildExecCellLines({ ...base, output: '+added', isError: true }, 60);
    expect(failed[1]?.segments[1]?.style.fg).toBe(TUI_COLORS.error);
  });
});
