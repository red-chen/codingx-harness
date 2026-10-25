import { describe, expect, it } from 'vitest';
import {
  ALT_SCREEN_ENTER,
  ALT_SCREEN_EXIT,
  BRACKETED_PASTE_ENTER,
  BRACKETED_PASTE_EXIT,
  CURSOR_HIDE,
  CURSOR_SHOW,
  TerminalSession,
  type Disposer,
  type SessionSignal,
  type TerminalIO,
} from '../src/tui/index.js';

class FakeIO implements TerminalIO {
  readonly writes: string[] = [];
  readonly rawModes: boolean[] = [];
  columns = 100;
  rows = 40;
  isTTY = true;
  resizeHandler?: (columns: number, rows: number) => void;
  dataHandler?: (chunk: string | Uint8Array) => void;
  readonly signalHandlers = new Map<SessionSignal, () => void>();
  disposed = 0;

  write(text: string): void {
    this.writes.push(text);
  }

  setRawMode(enabled: boolean): void {
    this.rawModes.push(enabled);
  }

  onResize(listener: (columns: number, rows: number) => void): Disposer {
    this.resizeHandler = listener;
    return () => {
      this.resizeHandler = undefined;
      this.disposed += 1;
    };
  }

  onData(listener: (chunk: string | Uint8Array) => void): Disposer {
    this.dataHandler = listener;
    return () => {
      this.dataHandler = undefined;
      this.disposed += 1;
    };
  }

  onSignal(signal: SessionSignal, listener: () => void): Disposer {
    this.signalHandlers.set(signal, listener);
    return () => {
      this.signalHandlers.delete(signal);
      this.disposed += 1;
    };
  }
}

describe('TerminalSession', () => {
  it('enters alt screen/raw/paste mode and restores idempotently', () => {
    const io = new FakeIO();
    const resizes: Array<[number, number]> = [];
    const session = new TerminalSession(io, { onResize: (c, r) => resizes.push([c, r]) });
    expect(session.enter()).toBe(true);
    expect(session.isActive).toBe(true);
    expect(io.rawModes).toEqual([true]);
    expect(io.writes.join('')).toContain(ALT_SCREEN_ENTER);
    expect(io.writes.join('')).toContain(CURSOR_HIDE);
    expect(io.writes.join('')).toContain(BRACKETED_PASTE_ENTER);

    io.columns = 120;
    io.rows = 50;
    io.resizeHandler?.(120, 50);
    expect(resizes).toEqual([[120, 50]]);

    session.exit();
    expect(session.isActive).toBe(false);
    expect(io.rawModes).toEqual([true, false]);
    expect(io.writes.join('')).toContain(BRACKETED_PASTE_EXIT);
    expect(io.writes.join('')).toContain(CURSOR_SHOW);
    expect(io.writes.join('')).toContain(ALT_SCREEN_EXIT);
    expect(io.disposed).toBe(3);

    const writesAfterExit = io.writes.length;
    session.exit();
    expect(io.writes.length).toBe(writesAfterExit);
    expect(io.rawModes).toEqual([true, false]);
  });

  it('does nothing on non-TTY IO', () => {
    const io = new FakeIO();
    io.isTTY = false;
    const session = new TerminalSession(io);
    expect(session.enter()).toBe(false);
    expect(session.isActive).toBe(false);
    expect(io.writes).toEqual([]);
    expect(io.rawModes).toEqual([]);
  });

  it('restores before forwarding a signal', () => {
    const io = new FakeIO();
    const signals: SessionSignal[] = [];
    const session = new TerminalSession(io, { onSignal: (signal) => signals.push(signal) });
    session.enter();
    io.signalHandlers.get('SIGTERM')?.();
    expect(session.isActive).toBe(false);
    expect(signals).toEqual(['SIGTERM']);
    expect(io.rawModes).toEqual([true, false]);
    expect(io.writes.join('')).toContain(ALT_SCREEN_EXIT);
  });

  it('forwards data and tolerates write failures', () => {
    const io = new FakeIO();
    const chunks: Array<string | Uint8Array> = [];
    const session = new TerminalSession(io, { onData: (chunk) => chunks.push(chunk) });
    session.enter();
    io.dataHandler?.('abc');
    expect(chunks).toEqual(['abc']);

    const broken: TerminalIO = {
      write() {
        throw new Error('write failed');
      },
      isTTY: true,
      setRawMode() {
        throw new Error('raw failed');
      },
      columns: 80,
      rows: 24,
    };
    const failing = new TerminalSession(broken);
    expect(failing.enter()).toBe(true);
    expect(failing.isActive).toBe(true);
    expect(failing.lastError).toBeInstanceOf(Error);
    failing.exit();
    expect(failing.isActive).toBe(false);
  });
});
