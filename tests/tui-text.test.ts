import { describe, expect, it } from 'vitest';
import {
  displayWidth,
  graphemeSegments,
  graphemeWidth,
  sliceByWidth,
  stripControlSequences,
  truncateToWidth,
  wrapText,
} from '../src/tui/text/index.js';

describe('graphemes and display width', () => {
  it('segments mixed text into grapheme clusters', () => {
    expect(graphemeSegments('a👩‍💻e\u0301你好')).toEqual(['a', '👩‍💻', 'e\u0301', '你', '好']);
    expect(graphemeSegments('')).toEqual([]);
  });

  it('measures ASCII, CJK, emoji and combining sequences', () => {
    expect(displayWidth('')).toBe(0);
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('你好')).toBe(4);
    expect(displayWidth('👩‍💻')).toBe(2);
    expect(displayWidth('🚀')).toBe(2);
    expect(displayWidth('e\u0301')).toBe(1);
    expect(displayWidth('🇨🇳')).toBe(2);
    expect(graphemeWidth('你')).toBe(2);
    expect(graphemeWidth('e\u0301')).toBe(1);
  });

  it('strips ANSI before measuring', () => {
    expect(displayWidth('\x1b[31mred\x1b[0m')).toBe(3);
    expect(displayWidth('\x1b]8;;https://example.com\x07link\x1b]8;;\x07')).toBe(4);
    expect(displayWidth('a\nb')).toBe(2);
    expect(displayWidth('a\tb')).toBe(2);
  });

  it('never reports a negative width', () => {
    expect(displayWidth('\x00\x07\x1b[31m')).toBe(0);
    expect(graphemeWidth('\u0301')).toBeGreaterThanOrEqual(0);
    expect(displayWidth('\x9b31m\x9b0m')).toBe(0);
  });
});

describe('stripControlSequences', () => {
  it('removes CSI sequences, including C1 CSI', () => {
    expect(stripControlSequences('\x1b[1;31mred\x1b[0m')).toBe('red');
    expect(stripControlSequences('\x9b31mred\x9b0m')).toBe('red');
    expect(stripControlSequences('\x1b[2J\x1b[Hclean')).toBe('clean');
  });

  it('removes OSC hyperlinks and titles terminated by BEL or ST', () => {
    expect(stripControlSequences('\x1b]8;;https://example.com\x07link\x1b]8;;\x07')).toBe('link');
    expect(stripControlSequences('\x1b]0;title\x1b\\visible')).toBe('visible');
  });

  it('removes DCS, SOS, PM and APC control strings', () => {
    expect(stripControlSequences('\x1bP1;2|payload\x1b\\visible')).toBe('visible');
    expect(stripControlSequences('\x1bXignored\x1b\\visible')).toBe('visible');
    expect(stripControlSequences('\x1b^private\x1b\\visible')).toBe('visible');
    expect(stripControlSequences('\x1b_apc\x1b\\visible')).toBe('visible');
  });

  it('keeps newline and tab but removes other C0/C1 controls', () => {
    expect(stripControlSequences('a\r\nb\tc\x00\x07\x7fd')).toBe('a\nb\tcd');
    expect(stripControlSequences('a\u0085b\u009cc')).toBe('abc');
  });

  it('drops unterminated escapes instead of leaking them', () => {
    expect(stripControlSequences('safe\x1b[31')).toBe('safe');
    expect(stripControlSequences('safe\x1b')).toBe('safe');
    expect(stripControlSequences('safe\x1b]0;title')).toBe('safe');
    expect(stripControlSequences('safe\x1bPdcs')).toBe('safe');
  });

  it('is safe on empty and control-only input', () => {
    expect(stripControlSequences('')).toBe('');
    expect(stripControlSequences('\x00\r\x07')).toBe('');
    expect(() => stripControlSequences('\x1b[?25l\x1b]8;;x')).not.toThrow();
  });
});

describe('sliceByWidth', () => {
  it('takes a prefix that fits the width', () => {
    expect(sliceByWidth('abcdef', 3)).toBe('abc');
    expect(sliceByWidth('abc', 10)).toBe('abc');
    expect(sliceByWidth('', 5)).toBe('');
  });

  it('never splits wide characters', () => {
    expect(sliceByWidth('你好世界', 5)).toBe('你好');
    expect(sliceByWidth('你好世界', 3)).toBe('你');
    expect(sliceByWidth('你好世界', 1)).toBe('');
    expect(sliceByWidth('👩‍💻x', 2)).toBe('👩‍💻');
    expect(sliceByWidth('👩‍💻x', 1)).toBe('');
  });

  it('keeps combining sequences attached', () => {
    expect(sliceByWidth('e\u0301x', 1)).toBe('e\u0301');
    expect(sliceByWidth('e\u0301x', 0)).toBe('');
  });

  it('clamps invalid widths to empty', () => {
    expect(sliceByWidth('abc', 0)).toBe('');
    expect(sliceByWidth('abc', -4)).toBe('');
    expect(sliceByWidth('abc', Number.NaN)).toBe('');
  });

  it('strips control sequences before slicing', () => {
    expect(sliceByWidth('\x1b[31mred\x1b[0m', 2)).toBe('re');
  });
});

describe('truncateToWidth', () => {
  it('returns text unchanged when it fits', () => {
    expect(truncateToWidth('hello', 5)).toBe('hello');
    expect(truncateToWidth('你好', 4)).toBe('你好');
    expect(truncateToWidth('', 3)).toBe('');
  });

  it('adds an ellipsis without exceeding the width', () => {
    expect(truncateToWidth('abcdef', 4)).toBe('abc…');
    expect(truncateToWidth('你好世界', 5)).toBe('你好…');
    expect(truncateToWidth('你好世界', 4)).toBe('你…');
    expect(displayWidth(truncateToWidth('abcdefgh', 6))).toBeLessThanOrEqual(6);
  });

  it('handles tiny maximum widths and zero', () => {
    expect(truncateToWidth('hello', 1)).toBe('…');
    expect(truncateToWidth('hello', 0)).toBe('');
    expect(truncateToWidth('你好', 1)).toBe('…');
  });

  it('supports a custom ellipsis and clips an oversized ellipsis', () => {
    expect(truncateToWidth('abcdef', 5, '...')).toBe('ab...');
    expect(truncateToWidth('abcdef', 2, '...')).toBe('..');
    expect(truncateToWidth('abcdef', 3, '')).toBe('abc');
  });

  it('strips ANSI input and never splits a grapheme', () => {
    expect(truncateToWidth('\x1b[31mabcdef\x1b[0m', 4)).toBe('abc…');
    const out = truncateToWidth('👩‍💻👩‍💻', 3);
    expect(out).toBe('👩‍💻…');
    expect(displayWidth(out)).toBeLessThanOrEqual(3);
  });
});

describe('wrapText', () => {
  it('wraps at word boundaries', () => {
    expect(wrapText('hello world', 5)).toEqual(['hello', 'world']);
    expect(wrapText('one two three', 7)).toEqual(['one', 'two', 'three']);
    expect(wrapText('ab cd', 4)).toEqual(['ab', 'cd']);
  });

  it('hard-wraps words longer than the width', () => {
    expect(wrapText('abcdef', 3)).toEqual(['abc', 'def']);
    expect(wrapText('abcdefgh', 4)).toEqual(['abcd', 'efgh']);
  });

  it('preserves explicit newlines and empty lines', () => {
    expect(wrapText('a\nb', 10)).toEqual(['a', 'b']);
    expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b']);
    expect(wrapText('a\n', 10)).toEqual(['a', '']);
    expect(wrapText('', 10)).toEqual(['']);
  });

  it('wraps CJK by display width', () => {
    expect(wrapText('你好世界', 4)).toEqual(['你好', '世界']);
    expect(wrapText('你好世界', 5)).toEqual(['你好', '世界']);
    expect(wrapText('你好世界', 3)).toEqual(['你', '好', '世', '界']);
  });

  it('does not split emoji graphemes', () => {
    expect(wrapText('👩‍💻👩‍💻', 2)).toEqual(['👩‍💻', '👩‍💻']);
  });

  it('makes progress for non-positive and narrow widths', () => {
    expect(wrapText('ab', 0)).toEqual(['a', 'b']);
    expect(wrapText('你好', 1)).toEqual(['你', '好']);
  });

  it('leaves fitting lines untouched, including whitespace', () => {
    expect(wrapText('hello world', 11)).toEqual(['hello world']);
    expect(wrapText('  indented', 20)).toEqual(['  indented']);
  });

  it('strips control sequences before wrapping', () => {
    expect(wrapText('\x1b[31mred blue\x1b[0m', 4)).toEqual(['red', 'blue']);
  });
});
