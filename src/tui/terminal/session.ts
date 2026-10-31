/**
 * Terminal session lifecycle: alternate screen, cursor, bracketed paste, raw
 * mode, resize/data/signal forwarding, and idempotent restoration.
 *
 * All IO is injected; tests never touch process.stdin. createProcessTerminalIO
 * is the only place that binds the real process streams.
 */

export type SessionSignal = 'SIGINT' | 'SIGTERM';
export type Disposer = () => void;

export interface TerminalIO {
  write(text: string): unknown;
  readonly isTTY: boolean;
  setRawMode?(enabled: boolean): void;
  readonly columns: number;
  readonly rows: number;
  onResize?(listener: (columns: number, rows: number) => void): void | Disposer;
  onData?(listener: (chunk: string | Uint8Array) => void): void | Disposer;
  onSignal?(signal: SessionSignal, listener: () => void): void | Disposer;
}

export interface TerminalSessionOptions {
  onData?: (chunk: string | Uint8Array) => void;
  onResize?: (columns: number, rows: number) => void;
  onSignal?: (signal: SessionSignal) => void;
  /** Default true. */
  altScreen?: boolean;
  /** Default true. */
  hideCursor?: boolean;
  /** Default true. */
  bracketedPaste?: boolean;
  /** Enable SGR mouse wheel reporting. Default true. */
  mouse?: boolean;
  /** Default true. */
  rawMode?: boolean;
}

export const ALT_SCREEN_ENTER = '\x1b[?1049h';
export const ALT_SCREEN_EXIT = '\x1b[?1049l';
export const CURSOR_HIDE = '\x1b[?25l';
export const CURSOR_SHOW = '\x1b[?25h';
export const BRACKETED_PASTE_ENTER = '\x1b[?2004h';
export const BRACKETED_PASTE_EXIT = '\x1b[?2004l';
export const MOUSE_ENTER = '\x1b[?1002h\x1b[?1006h';
export const MOUSE_EXIT = '\x1b[?1006l\x1b[?1002l';

function finiteDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

/**
 * A TerminalSession. Construction is side-effect free; enter() performs the
 * terminal setup and exit()/restore() undoes it. exit() is idempotent and
 * swallows IO failures so it remains safe in error paths.
 */
export class TerminalSession {
  private readonly io: TerminalIO;
  private readonly options: TerminalSessionOptions;
  private active = false;
  private altScreenActive = false;
  private cursorHidden = false;
  private bracketedPasteActive = false;
  private mouseActive = false;
  private rawModeActive = false;
  private disposers: Disposer[] = [];
  private lastErrorValue: unknown;

  constructor(io: TerminalIO, options: TerminalSessionOptions = {}) {
    this.io = io;
    this.options = options;
  }

  get isActive(): boolean {
    return this.active;
  }

  get isTTY(): boolean {
    return this.io.isTTY;
  }

  get columns(): number {
    return finiteDimension(this.io.columns, 80);
  }

  get rows(): number {
    return finiteDimension(this.io.rows, 24);
  }

  get size(): { columns: number; rows: number } {
    return { columns: this.columns, rows: this.rows };
  }

  /** The last IO error observed during best-effort setup/restore, if any. */
  get lastError(): unknown {
    return this.lastErrorValue;
  }

  /**
   * Enter the full-screen terminal. Returns false without side effects when
   * the injected IO is not a TTY (callers can fall back to plain output).
   */
  enter(): boolean {
    if (this.active) return true;
    if (!this.io.isTTY) return false;

    this.active = true;

    if (this.options.altScreen !== false) {
      this.altScreenActive = true;
      this.safeWrite(ALT_SCREEN_ENTER);
    }
    if (this.options.hideCursor !== false) {
      this.cursorHidden = true;
      this.safeWrite(CURSOR_HIDE);
    }
    if (this.options.bracketedPaste !== false) {
      this.bracketedPasteActive = true;
      this.safeWrite(BRACKETED_PASTE_ENTER);
    }
    if (this.options.mouse !== false) {
      this.mouseActive = true;
      this.safeWrite(MOUSE_ENTER);
    }
    if (this.options.rawMode !== false && typeof this.io.setRawMode === 'function') {
      this.rawModeActive = true;
      this.safeCall(() => this.io.setRawMode?.(true));
    }

    this.subscribe(() => this.io.onResize?.((columns, rows) => {
      this.options.onResize?.(finiteDimension(columns, this.columns), finiteDimension(rows, this.rows));
    }));

    if (this.options.onData !== undefined) {
      this.subscribe(() => this.io.onData?.((chunk) => {
        this.options.onData?.(chunk);
      }));
    }

    this.subscribe(() => this.io.onSignal?.('SIGINT', () => this.handleSignal('SIGINT')));
    this.subscribe(() => this.io.onSignal?.('SIGTERM', () => this.handleSignal('SIGTERM')));

    return true;
  }

  /** Restore every terminal mode touched by enter(). Safe to call repeatedly. */
  exit(): void {
    if (!this.active) return;
    this.active = false;

    const disposers = this.disposers;
    this.disposers = [];
    for (const dispose of disposers) {
      this.safeCall(dispose);
    }

    if (this.mouseActive) {
      this.mouseActive = false;
      this.safeWrite(MOUSE_EXIT);
    }
    if (this.bracketedPasteActive) {
      this.bracketedPasteActive = false;
      this.safeWrite(BRACKETED_PASTE_EXIT);
    }
    if (this.cursorHidden) {
      this.cursorHidden = false;
      this.safeWrite(CURSOR_SHOW);
    }
    if (this.altScreenActive) {
      this.altScreenActive = false;
      this.safeWrite(ALT_SCREEN_EXIT);
    }
    if (this.rawModeActive) {
      this.rawModeActive = false;
      this.safeCall(() => this.io.setRawMode?.(false));
    }
  }

  /** Alias for exit(). */
  restore(): void {
    this.exit();
  }

  dispose(): void {
    this.exit();
  }

  /** Best-effort write through the injected IO. Returns false on failure. */
  write(text: string): boolean {
    try {
      this.io.write(text);
      return true;
    } catch (error) {
      this.lastErrorValue = error;
      return false;
    }
  }

  private handleSignal(signal: SessionSignal): void {
    // Restore before notifying so a callback that exits the process leaves a
    // usable terminal behind.
    this.exit();
    if (this.options.onSignal !== undefined) {
      this.safeCall(() => this.options.onSignal?.(signal));
    }
  }

  private subscribe(register: () => void | Disposer): void {
    try {
      const disposer = register();
      if (typeof disposer === 'function') this.disposers.push(disposer);
    } catch (error) {
      this.lastErrorValue = error;
    }
  }

  private safeWrite(text: string): void {
    try {
      this.io.write(text);
    } catch (error) {
      this.lastErrorValue = error;
    }
  }

  private safeCall(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.lastErrorValue = error;
    }
  }
}

export interface ProcessTerminalIOOptions {
  stdin?: typeof process.stdin;
  stdout?: typeof process.stdout;
}

/**
 * Bind TerminalIO to the real process streams. Only called explicitly by the
 * eventual CLI integration; unit tests use a fake TerminalIO.
 */
export function createProcessTerminalIO(options: ProcessTerminalIOOptions = {}): TerminalIO {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  const columns = (): number => finiteDimension(stdout.columns ?? 0, 80);
  const rows = (): number => finiteDimension(stdout.rows ?? 0, 24);

  return {
    write(text: string): unknown {
      return stdout.write(text);
    },
    get isTTY(): boolean {
      return stdin.isTTY === true && stdout.isTTY === true;
    },
    setRawMode(enabled: boolean): void {
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(enabled);
    },
    get columns(): number {
      return columns();
    },
    get rows(): number {
      return rows();
    },
    onResize(listener: (columns: number, rows: number) => void): Disposer {
      const handler = (): void => listener(columns(), rows());
      process.on('SIGWINCH', handler);
      return () => {
        process.off('SIGWINCH', handler);
      };
    },
    onData(listener: (chunk: string | Uint8Array) => void): Disposer {
      const handler = (chunk: Buffer): void => listener(chunk);
      stdin.on('data', handler);
      // Switching sessions reuses a stream paused by the previous runtime.
      stdin.resume();
      return () => {
        stdin.off('data', handler);
        // A resumed TTY stream otherwise keeps the process alive after the TUI exits.
        if (stdin.listenerCount('data') === 0) stdin.pause();
      };
    },
    onSignal(signal: SessionSignal, listener: () => void): Disposer {
      process.on(signal, listener);
      return () => {
        process.off(signal, listener);
      };
    },
  };
}