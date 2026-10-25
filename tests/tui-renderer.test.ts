import { describe, expect, it } from 'vitest';
import {
  ATTR_BOLD,
  CellBuffer,
  ansiColor,
  color256,
  createCell,
  rgbColor,
} from '../src/tui/terminal/buffer.js';
import {
  HIDE_CURSOR,
  Renderer,
  SHOW_CURSOR,
  SYNC_END,
  SYNC_START,
  ansi256ToRgb,
  detectColorMode,
  nearestAnsi16,
  nearestAnsi256,
  renderDiff,
} from '../src/tui/terminal/renderer.js';
import {
  ALT_SCREEN_ENTER,
  ALT_SCREEN_EXIT,
  BRACKETED_PASTE_ENTER,
  BRACKETED_PASTE_EXIT,
  CURSOR_HIDE,
  CURSOR_SHOW,
  MOUSE_ENTER,
  MOUSE_EXIT,
  TerminalSession,
} from '../src/tui/terminal/session.js';
import type { Disposer, SessionSignal, TerminalIO } from '../src/tui/terminal/session.js';

function bodyOf(output: string): string {
  expect(output.startsWith(SYNC_START)).toBe(true);
  expect(output.endsWith(SYNC_END)).toBe(true);
  return output.slice(SYNC_START.length, output.length - SYNC_END.length);
}

function sgrSequences(output: string): string[] {
  return output.match(/\x1b\[[0-9;]*m/g) ?? [];
}

function cursorMoves(output: string): string[] {
  return output.match(/\x1b\[\d+;\d+H/g) ?? [];
}

function renderSingle(style: Parameters<typeof createCell>[1], mode: 'truecolor' | '256' | '16' | 'none'): string {
  const front = new CellBuffer(1, 1);
  const back = new CellBuffer(1, 1);
  back.set(0, 0, createCell('X', style));
  return bodyOf(renderDiff(front, back, { colorMode: mode }));
}

describe('diff rendering', () => {
  it('emits only synchronized markers for an unchanged frame', () => {
    const front = new CellBuffer(10, 2);
    const back = new CellBuffer(10, 2);
    expect(renderDiff(front, back, { colorMode: '16' })).toBe(SYNC_START + SYNC_END);
  });

  it('moves once to a changed run and prints only changed cells', () => {
    const front = new CellBuffer(8, 2);
    const back = new CellBuffer(8, 2);
    back.setString(2, 1, 'ABC');
    const body = bodyOf(renderDiff(front, back, { colorMode: '16' }));
    expect(body).toBe('\x1b[2;3HABC');
    expect(cursorMoves(body)).toHaveLength(1);
    expect(sgrSequences(body)).toEqual([]);
  });

  it('skips unchanged cells and groups separate runs', () => {
    const front = new CellBuffer(8, 1);
    const back = new CellBuffer(8, 1);
    front.setString(0, 0, 'ABCDEFGH');
    back.setString(0, 0, 'ABXDEFYH');
    const body = bodyOf(renderDiff(front, back, { colorMode: '16' }));
    expect(body).toBe('\x1b[1;3HX\x1b[1;7HY');
    expect(cursorMoves(body)).toHaveLength(2);
  });

  it('renders a wide glyph once and skips its continuation cell', () => {
    const front = new CellBuffer(4, 1);
    const back = new CellBuffer(4, 1);
    back.setString(0, 0, '你A');
    const body = bodyOf(renderDiff(front, back, { colorMode: '16' }));
    expect(body).toBe('\x1b[1;1H你A');
    expect(body).not.toContain('你你');

    const unchangedFront = back.clone();
    const unchangedBack = back.clone();
    expect(renderDiff(unchangedFront, unchangedBack, { colorMode: '16' })).toBe(SYNC_START + SYNC_END);
  });

  it('emits SGR when style changes and resets when it returns to default', () => {
    const front = new CellBuffer(4, 1);
    const back = new CellBuffer(4, 1);
    const style = { fg: ansiColor(1), attrs: ATTR_BOLD };
    back.setString(0, 0, 'AB', style);
    back.setString(2, 0, 'CD');
    const body = bodyOf(renderDiff(front, back, { colorMode: '16' }));
    expect(body).toBe('\x1b[1;1H\x1b[1;31mAB\x1b[0mCD');
    expect(sgrSequences(body)).toEqual(['\x1b[1;31m', '\x1b[0m']);
    expect(body).not.toContain('\x1b[m');
  });

  it('does not emit color SGR for default cells', () => {
    const front = new CellBuffer(2, 1);
    const back = new CellBuffer(2, 1);
    back.setString(0, 0, 'AB');
    const body = bodyOf(renderDiff(front, back, { colorMode: 'truecolor' }));
    expect(body).toBe('\x1b[1;1HAB');
    expect(sgrSequences(body)).toEqual([]);
  });

  it('clears and repaints when dimensions differ', () => {
    const front = new CellBuffer(2, 2);
    const back = new CellBuffer(3, 1);
    back.setString(0, 0, 'X');
    const body = bodyOf(renderDiff(front, back, { colorMode: '16' }));
    expect(body.startsWith('\x1b[2J')).toBe(true);
    expect(body).toContain('X');
  });

  it('omits synchronized markers when disabled', () => {
    const front = new CellBuffer(2, 1);
    const back = new CellBuffer(2, 1);
    back.setString(0, 0, 'A');
    const output = renderDiff(front, back, { colorMode: '16', synchronized: false });
    expect(output).toBe('\x1b[1;1HA');
    expect(output).not.toContain('\x1b[?2026h');
  });

  it('positions and optionally shows/hides the cursor at frame end', () => {
    const front = new CellBuffer(5, 2);
    const back = new CellBuffer(5, 2);
    const hidden = renderDiff(front, back, { colorMode: '16', cursor: { x: 2, y: 1 }, cursorVisible: false });
    const hiddenBody = bodyOf(hidden);
    expect(hiddenBody).toBe(HIDE_CURSOR + '\x1b[2;3H');

    const shown = bodyOf(renderDiff(front, back, { colorMode: '16', cursor: { x: 0, y: 0 }, cursorVisible: true }));
    expect(shown).toBe(SHOW_CURSOR + '\x1b[1;1H');

    const clamped = bodyOf(renderDiff(front, back, { colorMode: '16', cursor: { x: 99, y: -4 } }));
    expect(clamped).toBe('\x1b[1;5H');
  });
});

describe('color capabilities', () => {
  it('renders truecolor foreground and background', () => {
    const body = renderSingle({ fg: rgbColor(255, 0, 0), bg: rgbColor(0, 128, 255) }, 'truecolor');
    expect(body).toContain('\x1b[38;2;255;0;0;48;2;0;128;255m');
  });

  it('downgrades truecolor to 256 colors deterministically', () => {
    const body = renderSingle({ fg: rgbColor(255, 0, 0) }, '256');
    expect(body).toContain('\x1b[38;5;196m');
    expect(nearestAnsi256(255, 0, 0)).toBe(196);
  });

  it('downgrades truecolor and 256 indexes to 16 colors', () => {
    expect(renderSingle({ fg: rgbColor(255, 0, 0) }, '16')).toContain('\x1b[91m');
    expect(renderSingle({ fg: color256(196) }, '16')).toContain('\x1b[91m');
    expect(renderSingle({ bg: ansiColor(4) }, '16')).toContain('\x1b[44m');
    expect(nearestAnsi16(255, 0, 0)).toBe(9);
  });

  it('keeps native 16-color and 256-color escapes in higher modes', () => {
    expect(renderSingle({ fg: ansiColor(1) }, 'truecolor')).toContain('\x1b[31m');
    expect(renderSingle({ fg: ansiColor(12) }, '256')).toContain('\x1b[94m');
    expect(renderSingle({ fg: color256(196) }, 'truecolor')).toContain('\x1b[38;5;196m');
  });

  it('emits no color SGR under NO_COLOR but keeps attributes', () => {
    const body = renderSingle({ fg: rgbColor(255, 0, 0), bg: rgbColor(0, 0, 255) }, 'none');
    expect(body).toBe('\x1b[1;1HX');
    expect(sgrSequences(body)).toEqual([]);

    const boldBody = renderSingle({ fg: rgbColor(255, 0, 0), attrs: ATTR_BOLD }, 'none');
    expect(boldBody).toBe('\x1b[1;1H\x1b[1mX\x1b[0m');
  });

  it('detects color mode from the environment', () => {
    expect(detectColorMode({ NO_COLOR: '' })).toBe('none');
    expect(detectColorMode({ FORCE_COLOR: '0' })).toBe('none');
    expect(detectColorMode({ COLORTERM: 'truecolor' })).toBe('truecolor');
    expect(detectColorMode({ COLORTERM: '24bit' })).toBe('truecolor');
    expect(detectColorMode({ TERM: 'xterm-256color' })).toBe('256');
    expect(detectColorMode({ TERM: 'dumb' })).toBe('none');
    expect(detectColorMode({})).toBe('16');
  });

  it('converts xterm-256 indexes to RGB and finds nearest neighbors', () => {
    expect(ansi256ToRgb(196)).toEqual({ r: 255, g: 0, b: 0 });
    expect(ansi256ToRgb(232)).toEqual({ r: 8, g: 8, b: 8 });
    expect(nearestAnsi256(0, 0, 0)).toBe(16);
  });

  it('never emits an empty SGR sequence', () => {
    const body = renderSingle({}, '16');
    expect(body).toBe('\x1b[1;1HX');
    expect(body).not.toContain('\x1b[m');
    expect(body).not.toContain('\x1b[;');
  });
});

describe('public barrel', () => {
  it('exports the kernel through src/tui/index.ts', async () => {
    const tui = await import('../src/tui/index.js');
    expect(typeof tui.renderDiff).toBe('function');
    expect(typeof tui.TerminalSession).toBe('function');
    expect(typeof tui.split).toBe('function');
    expect(typeof tui.displayWidth).toBe('function');
    expect(typeof tui.cellWidth).toBe('function');
    expect(typeof tui.graphemes).toBe('function');
    expect(tui.graphemes('👩‍💻')).toEqual(['👩‍💻']);
    expect(tui.cellWidth('你')).toBe(2);
  });
});

describe('Renderer wrapper', () => {
  it('returns and writes the rendered frame', () => {
    const front = new CellBuffer(3, 1);
    const back = new CellBuffer(3, 1);
    back.setString(0, 0, 'hey');
    let written = '';
    const renderer = new Renderer({ colorMode: '16', write: (text) => { written += text; } });
    const returned = renderer.render(front, back);
    expect(returned).toBe(written);
    expect(bodyOf(returned)).toBe('\x1b[1;1Hhey');
  });
});

class FakeIO implements TerminalIO {
  writes: string[] = [];
  rawModes: boolean[] = [];
  isTTY = true;
  columns = 100;
  rows = 40;
  failWrite = false;
  resizeHandler: ((columns: number, rows: number) => void) | undefined;
  dataHandler: ((chunk: string | Uint8Array) => void) | undefined;
  signalHandlers = new Map<SessionSignal, () => void>();
  disposed: string[] = [];

  write(text: string): boolean {
    if (this.failWrite) throw new Error('write failure');
    this.writes.push(text);
    return true;
  }

  setRawMode(enabled: boolean): void {
    this.rawModes.push(enabled);
  }

  onResize(listener: (columns: number, rows: number) => void): Disposer {
    this.resizeHandler = listener;
    return () => {
      this.resizeHandler = undefined;
      this.disposed.push('resize');
    };
  }

  onData(listener: (chunk: string | Uint8Array) => void): Disposer {
    this.dataHandler = listener;
    return () => {
      this.dataHandler = undefined;
      this.disposed.push('data');
    };
  }

  onSignal(signal: SessionSignal, listener: () => void): Disposer {
    this.signalHandlers.set(signal, listener);
    return () => {
      this.signalHandlers.delete(signal);
      this.disposed.push(signal);
    };
  }
}

describe('TerminalSession lifecycle', () => {
  it('enters and restores every terminal mode, forwarding resize/data', () => {
    const io = new FakeIO();
    const resizes: Array<[number, number]> = [];
    const data: Array<string | Uint8Array> = [];
    const session = new TerminalSession(io, {
      onResize: (columns, rows) => resizes.push([columns, rows]),
      onData: (chunk) => data.push(chunk),
    });

    expect(session.enter()).toBe(true);
    expect(io.writes).toEqual([ALT_SCREEN_ENTER, CURSOR_HIDE, BRACKETED_PASTE_ENTER, MOUSE_ENTER]);
    expect(io.rawModes).toEqual([true]);
    expect(session.isActive).toBe(true);
    expect(session.columns).toBe(100);
    expect(session.rows).toBe(40);
    expect(session.size).toEqual({ columns: 100, rows: 40 });

    io.resizeHandler?.(120, 50);
    io.dataHandler?.('typed');
    expect(resizes).toEqual([[120, 50]]);
    expect(data).toEqual(['typed']);

    session.exit();
    expect(io.writes.slice(4)).toEqual([MOUSE_EXIT, BRACKETED_PASTE_EXIT, CURSOR_SHOW, ALT_SCREEN_EXIT]);
    expect(io.rawModes).toEqual([true, false]);
    expect(session.isActive).toBe(false);
    expect(io.resizeHandler).toBeUndefined();
    expect(io.dataHandler).toBeUndefined();
    expect(io.signalHandlers.size).toBe(0);
    expect(io.disposed).toEqual(expect.arrayContaining(['resize', 'data', 'SIGINT', 'SIGTERM']));

    const writeCount = io.writes.length;
    const rawCount = io.rawModes.length;
    session.exit();
    session.restore();
    expect(io.writes.length).toBe(writeCount);
    expect(io.rawModes.length).toBe(rawCount);
  });

  it('does not touch anything when the IO is not a TTY', () => {
    const io = new FakeIO();
    io.isTTY = false;
    const session = new TerminalSession(io);
    expect(session.enter()).toBe(false);
    expect(io.writes).toEqual([]);
    expect(io.rawModes).toEqual([]);
    expect(io.resizeHandler).toBeUndefined();
    expect(io.signalHandlers.size).toBe(0);
  });

  it('restores before dispatching SIGINT/SIGTERM and removes listeners', () => {
    const io = new FakeIO();
    const signals: SessionSignal[] = [];
    const session = new TerminalSession(io, { onSignal: (signal) => signals.push(signal) });
    session.enter();
    io.writes = [];

    io.signalHandlers.get('SIGTERM')?.();
    expect(signals).toEqual(['SIGTERM']);
    expect(session.isActive).toBe(false);
    expect(io.writes).toEqual([MOUSE_EXIT, BRACKETED_PASTE_EXIT, CURSOR_SHOW, ALT_SCREEN_EXIT]);
    expect(io.rawModes).toEqual([true, false]);
    expect(io.signalHandlers.size).toBe(0);
  });

  it('honors disabled setup options', () => {
    const io = new FakeIO();
    const session = new TerminalSession(io, {
      altScreen: false,
      hideCursor: false,
      bracketedPaste: false,
      mouse: false,
      rawMode: false,
    });
    expect(session.enter()).toBe(true);
    expect(io.writes).toEqual([]);
    expect(io.rawModes).toEqual([]);
    session.exit();
    expect(io.writes).toEqual([]);
  });

  it('is safe when writes throw during enter and exit', () => {
    const io = new FakeIO();
    io.failWrite = true;
    const session = new TerminalSession(io);
    expect(() => session.enter()).not.toThrow();
    expect(session.isActive).toBe(true);
    expect(session.lastError).toBeInstanceOf(Error);
    expect(session.write('x')).toBe(false);

    expect(() => session.exit()).not.toThrow();
    expect(session.isActive).toBe(false);
    expect(io.rawModes).toEqual([true, false]);
    expect(() => session.restore()).not.toThrow();
  });

  it('can be entered again after a clean exit', () => {
    const io = new FakeIO();
    const session = new TerminalSession(io);
    session.enter();
    session.exit();
    io.writes = [];
    io.rawModes = [];
    expect(session.enter()).toBe(true);
    expect(io.writes).toEqual([ALT_SCREEN_ENTER, CURSOR_HIDE, BRACKETED_PASTE_ENTER, MOUSE_ENTER]);
    expect(io.rawModes).toEqual([true]);
    session.exit();
  });
});