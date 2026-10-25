import { describe, expect, it } from 'vitest';
import { InputParser } from '../src/tui/terminal/input.js';
import type { InputEvent, KeyEvent } from '../src/tui/terminal/input.js';

const NO_MODS = { ctrl: false, alt: false, shift: false, meta: false };

function keyEvents(events: InputEvent[]): KeyEvent[] {
  return events.filter((event): event is KeyEvent => event.type === 'key');
}

function firstKey(events: InputEvent[]): KeyEvent {
  const keys = keyEvents(events);
  expect(keys).toHaveLength(1);
  return keys[0]!;
}

describe('printable input', () => {
  it('parses ASCII, uppercase, space, CJK and emoji', () => {
    const parser = new InputParser();
    expect(parser.push('a')).toEqual([{ type: 'key', code: 'a', text: 'a', mods: NO_MODS }]);
    expect(firstKey(parser.push('A'))).toMatchObject({ code: 'a', text: 'A', mods: { shift: true } });
    expect(firstKey(parser.push(' '))).toEqual({ type: 'key', code: 'space', text: ' ', mods: NO_MODS });
    expect(firstKey(parser.push('你'))).toMatchObject({ code: '你', text: '你' });
    expect(firstKey(parser.push('👩‍💻'))).toMatchObject({ code: '👩‍💻', text: '👩‍💻' });
    expect(firstKey(parser.push('!'))).toMatchObject({ code: '!', text: '!' });
  });

  it('keeps combining sequences as one key', () => {
    const event = firstKey(new InputParser().push('e\u0301'));
    expect(event.text).toBe('e\u0301');
    expect(event.code).toBe('e');
  });
});

describe('control and special keys', () => {
  it('parses Ctrl+A..Z without text', () => {
    const parser = new InputParser();
    for (const [sequence, code] of [
      ['\x01', 'a'],
      ['\x03', 'c'],
      ['\x05', 'e'],
      ['\x1a', 'z'],
    ] as const) {
      const event = firstKey(parser.push(sequence));
      expect(event).toMatchObject({ code, mods: { ctrl: true } });
      expect(event.text).toBeUndefined();
    }
  });

  it('parses Enter, Tab, Backspace and Ctrl+J distinctly', () => {
    const parser = new InputParser();
    expect(firstKey(parser.push('\r')).code).toBe('enter');
    expect(firstKey(parser.push('\r\n')).code).toBe('enter');
    expect(firstKey(parser.push('\t'))).toMatchObject({ code: 'tab', mods: NO_MODS });
    expect(firstKey(parser.push('\x7f')).code).toBe('backspace');
    expect(firstKey(parser.push('\x08')).code).toBe('backspace');
    expect(firstKey(parser.push('\n'))).toMatchObject({ code: 'j', mods: { ctrl: true } });
  });

  it('parses CSI navigation and editing keys', () => {
    const parser = new InputParser();
    const table: ReadonlyArray<readonly [string, string]> = [
      ['\x1b[A', 'up'],
      ['\x1b[B', 'down'],
      ['\x1b[C', 'right'],
      ['\x1b[D', 'left'],
      ['\x1b[H', 'home'],
      ['\x1b[F', 'end'],
      ['\x1b[1~', 'home'],
      ['\x1b[2~', 'insert'],
      ['\x1b[3~', 'delete'],
      ['\x1b[4~', 'end'],
      ['\x1b[5~', 'pageup'],
      ['\x1b[6~', 'pagedown'],
      ['\x1b[7~', 'home'],
      ['\x1b[8~', 'end'],
    ];
    for (const [sequence, code] of table) {
      expect(firstKey(parser.push(sequence)).code).toBe(code);
    }
    expect(firstKey(parser.push('\x1b[Z'))).toMatchObject({ code: 'tab', mods: { shift: true } });
  });

  it('parses SS3 navigation and function keys', () => {
    const parser = new InputParser();
    const table: ReadonlyArray<readonly [string, string]> = [
      ['\x1bOA', 'up'],
      ['\x1bOB', 'down'],
      ['\x1bOC', 'right'],
      ['\x1bOD', 'left'],
      ['\x1bOH', 'home'],
      ['\x1bOF', 'end'],
      ['\x1bOP', 'f1'],
      ['\x1bOQ', 'f2'],
      ['\x1bOR', 'f3'],
      ['\x1bOS', 'f4'],
      ['\x1bOM', 'enter'],
    ];
    for (const [sequence, code] of table) {
      expect(firstKey(parser.push(sequence)).code).toBe(code);
    }
  });

  it('parses F1-F12', () => {
    const sequences: ReadonlyArray<readonly [string, string]> = [
      ['\x1b[11~', 'f1'],
      ['\x1b[12~', 'f2'],
      ['\x1b[13~', 'f3'],
      ['\x1b[14~', 'f4'],
      ['\x1b[15~', 'f5'],
      ['\x1b[17~', 'f6'],
      ['\x1b[18~', 'f7'],
      ['\x1b[19~', 'f8'],
      ['\x1b[20~', 'f9'],
      ['\x1b[21~', 'f10'],
      ['\x1b[23~', 'f11'],
      ['\x1b[24~', 'f12'],
    ];
    const parser = new InputParser();
    const events = parser.push(sequences.map(([sequence]) => sequence).join(''));
    expect(keyEvents(events).map((event) => event.code)).toEqual(sequences.map(([, code]) => code));
  });

  it('parses CSI modifier parameters', () => {
    const parser = new InputParser();
    expect(firstKey(parser.push('\x1b[1;2A'))).toMatchObject({ code: 'up', mods: { shift: true } });
    expect(firstKey(parser.push('\x1b[1;5C'))).toMatchObject({ code: 'right', mods: { ctrl: true } });
    expect(firstKey(parser.push('\x1b[1;3D'))).toMatchObject({ code: 'left', mods: { alt: true } });
    expect(firstKey(parser.push('\x1b[1;9H'))).toMatchObject({ code: 'home', mods: { meta: true } });
    expect(firstKey(parser.push('\x1b[1;4P'))).toMatchObject({ code: 'f1', mods: { shift: true, alt: true } });
    expect(firstKey(parser.push('\x1b[3;5~'))).toMatchObject({ code: 'delete', mods: { ctrl: true } });
  });

  it('parses Alt+key and Alt+Enter', () => {
    const parser = new InputParser();
    expect(firstKey(parser.push('\x1ba'))).toMatchObject({ code: 'a', text: 'a', mods: { alt: true } });
    expect(firstKey(parser.push('\x1bA'))).toMatchObject({ code: 'a', text: 'A', mods: { alt: true, shift: true } });
    expect(firstKey(parser.push('\x1b\r'))).toMatchObject({ code: 'enter', mods: { alt: true } });
  });
});

describe('escape disambiguation', () => {
  it('buffers a lone ESC and exposes an explicit flush/timeout helper', () => {
    const parser = new InputParser();
    expect(parser.push('\x1b')).toEqual([]);
    expect(parser.pending).toBe('\x1b');
    expect(parser.pendingSince).not.toBeNull();
    expect(parser.shouldFlush(Date.now() + 1000)).toBe(true);
    expect(parser.flushPending()).toEqual([{ type: 'key', code: 'escape', mods: NO_MODS }]);
    expect(parser.pending).toBe('');
    expect(parser.pendingSince).toBeNull();
    expect(parser.flushPending()).toEqual([]);
  });

  it('flushes an incomplete CSI prefix as Escape', () => {
    const parser = new InputParser();
    expect(parser.push('\x1b[')).toEqual([]);
    expect(parser.flushPending()).toEqual([{ type: 'key', code: 'escape', mods: NO_MODS }]);
    expect(parser.push('a')).toEqual([{ type: 'key', code: 'a', text: 'a', mods: NO_MODS }]);
  });

  it('reassembles CSI sequences split across chunks', () => {
    const parser = new InputParser();
    expect(parser.push('\x1b')).toEqual([]);
    expect(parser.push('[')).toEqual([]);
    expect(parser.push('1;5')).toEqual([]);
    const event = firstKey(parser.push('C'));
    expect(event).toMatchObject({ code: 'right', mods: { ctrl: true } });
    expect(parser.pending).toBe('');
  });

  it('reassembles SS3 sequences split across chunks', () => {
    const parser = new InputParser();
    expect(parser.push('\x1bO')).toEqual([]);
    expect(firstKey(parser.push('A')).code).toBe('up');
  });

  it('can be reset after a pending escape', () => {
    const parser = new InputParser();
    parser.push('\x1b');
    parser.reset();
    expect(parser.pending).toBe('');
    expect(parser.pendingSince).toBeNull();
    expect(firstKey(parser.push('x')).text).toBe('x');
  });
});

describe('UTF-8 decoding', () => {
  it('decodes multi-byte characters split across Buffer chunks', () => {
    const parser = new InputParser();
    const bytes = Buffer.from('你');
    expect(parser.push(bytes.subarray(0, 1))).toEqual([]);
    expect(parser.push(bytes.subarray(1, 2))).toEqual([]);
    const event = firstKey(parser.push(bytes.subarray(2)));
    expect(event).toMatchObject({ code: '你', text: '你' });
  });

  it('decodes emoji split across byte chunks', () => {
    const parser = new InputParser();
    const bytes = Buffer.from('👩‍💻');
    expect(parser.push(bytes.subarray(0, 3))).toEqual([]);
    const events = parser.push(bytes.subarray(3));
    expect(keyEvents(events)).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'key', text: '👩‍💻' });
  });

  it('accepts empty chunks and mixed string/byte input', () => {
    const parser = new InputParser();
    expect(parser.push('')).toEqual([]);
    expect(parser.push(new Uint8Array())).toEqual([]);
    expect(parser.push(Buffer.from('\x1b['))).toEqual([]);
    expect(firstKey(parser.push('A')).code).toBe('up');
  });
});

describe('bracketed paste, focus and resize', () => {
  it('parses a one-shot bracketed paste with newlines', () => {
    const parser = new InputParser();
    const events = parser.push('\x1b[200~line1\nline2\x1b[201~');
    expect(events).toEqual([{ type: 'paste', text: 'line1\nline2' }]);
    expect(parser.isPasting).toBe(false);
  });

  it('collects paste content split across chunks', () => {
    const parser = new InputParser();
    expect(parser.push('\x1b[200~hello\n')).toEqual([]);
    expect(parser.isPasting).toBe(true);
    expect(parser.push('wor')).toEqual([]);
    const events = parser.push('ld\x1b[201~');
    expect(events).toEqual([{ type: 'paste', text: 'hello\nworld' }]);
  });

  it('handles a paste terminator split across chunks', () => {
    const parser = new InputParser();
    expect(parser.push('\x1b[200~abc\x1b[20')).toEqual([]);
    expect(parser.push('1~')).toEqual([{ type: 'paste', text: 'abc' }]);
  });

  it('preserves raw escape-looking bytes inside a paste', () => {
    const parser = new InputParser();
    const events = parser.push('\x1b[200~a\x1b[31mb\x1b[201~');
    expect(events).toEqual([{ type: 'paste', text: 'a\x1b[31mb' }]);
  });

  it('parses focus events', () => {
    const parser = new InputParser();
    expect(parser.push('\x1b[I')).toEqual([{ type: 'focus', focused: true }]);
    expect(parser.push('\x1b[O')).toEqual([{ type: 'focus', focused: false }]);
  });

  it('parses resize sequences and split resize sequences', () => {
    const parser = new InputParser();
    expect(parser.push('\x1b[8;24;80t')).toEqual([{ type: 'resize', columns: 80, rows: 24 }]);
    expect(parser.push('\x1b[8;40;')).toEqual([]);
    expect(parser.push('120t')).toEqual([{ type: 'resize', columns: 120, rows: 40 }]);
  });

  it('parses SGR mouse wheel, press, drag and release events', () => {
    const parser = new InputParser();
    expect(parser.push('\x1b[<64;10;5M')).toEqual([{ type: 'wheel', direction: 'up' }]);
    expect(parser.push('\x1b[<65;10;5M')).toEqual([{ type: 'wheel', direction: 'down' }]);
    expect(parser.push('\x1b[<0;10;5M')).toEqual([
      { type: 'mouse', action: 'press', button: 0, x: 10, y: 5 },
    ]);
    expect(parser.push('\x1b[<32;14;5M')).toEqual([
      { type: 'mouse', action: 'drag', button: 0, x: 14, y: 5 },
    ]);
    expect(parser.push('\x1b[<0;14;5m')).toEqual([
      { type: 'mouse', action: 'release', button: 0, x: 14, y: 5 },
    ]);
  });

  it('does not flush while a paste is still open', () => {
    const parser = new InputParser();
    parser.push('\x1b[200~partial');
    expect(parser.shouldFlush(Date.now() + 1000)).toBe(false);
    expect(parser.flushPending()).toEqual([]);
    expect(parser.isPasting).toBe(true);
    expect(parser.push('\x1b[201~')).toEqual([{ type: 'paste', text: 'partial' }]);
  });
});

describe('unknown sequences', () => {
  it('ignores unknown CSI, OSC and DCS sequences', () => {
    const parser = new InputParser();
    expect(parser.push('\x1b[999z')).toEqual([]);
    expect(parser.push('\x1b[?25h')).toEqual([]);
    expect(parser.push('\x1b]0;title\x07')).toEqual([]);
    expect(parser.push('\x1bPq\x1b\\')).toEqual([]);
    expect(parser.push('ok')).toEqual([
      { type: 'key', code: 'o', text: 'o', mods: NO_MODS },
      { type: 'key', code: 'k', text: 'k', mods: NO_MODS },
    ]);
  });

  it('never throws on malformed or random input', () => {
    const parser = new InputParser();
    expect(() => {
      parser.push('\x1b[?;123z');
      parser.push('\x1bO\x1b]');
      parser.push('\x07\x00\x1f');
      parser.push('valid');
    }).not.toThrow();
    expect(parser.pending.length).toBeGreaterThanOrEqual(0);
  });
});