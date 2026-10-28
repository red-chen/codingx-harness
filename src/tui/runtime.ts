import { computeFrameLayout } from './app.js';
import { layoutTranscript, transcriptHeight } from './widgets/transcript.js';
import { drawStyledLine } from './widgets/welcome.js';
import { CellBuffer } from './terminal/buffer.js';
import { debugLog } from '../util/debug.js';
import { InputParser, type InputEvent, type KeyEvent } from './terminal/input.js';
import { Renderer, type ColorMode } from './terminal/renderer.js';
import { TerminalSession, type SessionSignal, type TerminalIO } from './terminal/session.js';
import type { TuiApp } from './state/app.js';
import type { UiCommand } from './state/commands.js';

export interface TuiRuntimeOptions {
  app: TuiApp;
  io: TerminalIO;
  renderer?: Renderer;
  colorMode?: ColorMode;
  input?: InputParser;
  onCommand?: (command: UiCommand) => void | Promise<void>;
  onLocalCommand?: (text: string) => void;
  onCopy?: () => void;
  onIdleCtrlC?: () => void;
  onSignal?: (signal: SessionSignal) => void;
  tickMs?: number;
}

/**
 * Owns the real terminal: primary screen/raw mode, incremental input, frame diffing
 * and timers. The app is pure; all side effects are here and injectable.
 */
export class TuiRuntime {
  readonly app: TuiApp;
  private readonly io: TerminalIO;
  private readonly renderer: Renderer;
  private readonly input: InputParser;
  private readonly session: TerminalSession;
  private readonly options: TuiRuntimeOptions;
  private front: CellBuffer | undefined;
  private timer: NodeJS.Timeout | undefined;
  private renderTimer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private lastRender = 0;
  private archivedRows = 0;
  private archiveWidth = 0;
  private archiveSession = '';
  private archiveCells: readonly unknown[] = [];

  constructor(options: TuiRuntimeOptions) {
    this.options = options;
    this.app = options.app;
    this.io = options.io;
    this.input = options.input ?? new InputParser();
    this.renderer = options.renderer ?? new Renderer({
      colorMode: options.colorMode ?? 'truecolor',
    });
    // Native scrollback and text selection both belong to the terminal.
    // Keep the primary screen and never capture mouse input.
    this.session = new TerminalSession(options.io, {
      mouse: false,
      altScreen: false,
      onData: (chunk) => this.feed(chunk),
      onResize: (columns, rows) => this.resize(columns, rows),
      onSignal: (signal) => {
        this.stop();
        options.onSignal?.(signal);
      },
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): boolean {
    if (this.running) return true;
    if (this.stopped) return false;
    if (!this.session.enter()) return false;
    this.running = true;
    // Allocate a viewport on the primary screen without erasing shell scrollback.
    this.session.write('\r' + '\n'.repeat(this.io.rows) + '\x1b[H');
    this.app.setSize(this.io.columns, this.io.rows);
    debugLog(
      'clipboard',
      'tui start term=' + (process.env.TERM ?? '?') +
        ' program=' + (process.env.TERM_PROGRAM ?? '?') +
        ' tmux=' + (process.env.TMUX === undefined ? 'no' : 'yes') +
        ' size=' + this.io.columns + 'x' + this.io.rows,
    );
    this.render(true);
    const tickMs = Math.max(16, this.options.tickMs ?? 50);
    this.timer = setInterval(() => this.tick(), tickMs);
    return true;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.session.write('\x1b[' + this.io.rows + ';1H\r\n');
    this.session.exit();
    this.stopped = true;
  }

  /** Write a terminal escape sequence (used for OSC52 clipboard output). */
  write(text: string): boolean {
    return this.session.write(text);
  }

  feed(chunk: string | Uint8Array): void {
    const events = this.input.push(chunk);
    for (const event of events) this.handleInput(event);
  }

  handleInput(event: InputEvent): void {
    if (!this.running) return;
    if (event.type === 'resize') {
      this.resize(event.columns, event.rows);
      return;
    }
    if (event.type === 'focus') return;
    if (event.type === 'mouse') return;
    if (event.type === 'wheel') {
      if (this.app.mode === 'main' || this.app.mode === 'transcript') {
        if (event.direction === 'up') this.app.scrollUp(3);
        else this.app.scrollDown(3);
        this.render();
      } else if (this.app.mode === 'approval' && this.app.state.approval?.details) {
        this.handleKey({ type: 'key', code: event.direction,
          mods: { ctrl: false, alt: false, shift: false, meta: false } });
      }
      return;
    }
    if (event.type === 'paste') {
      this.handleKey({ type: 'key', code: 'paste', text: event.text, mods: { ctrl: false, alt: false, shift: false, meta: false } });
      return;
    }
    this.handleKey(event);
  }

  private handleKey(key: KeyEvent): void {
    if (this.app.mode === 'main' && key.mods.ctrl && key.code === 'y') {
      this.options.onCopy?.();
      return;
    }
    if (this.app.mode === 'main' && key.mods.ctrl && key.code === 'c' && this.app.status.state === 'idle') {
      this.options.onIdleCtrlC?.();
      this.render();
      return;
    }

    if (
      this.app.mode === 'main' &&
      key.code === 'enter' &&
      !key.mods.ctrl &&
      !key.mods.alt &&
      !key.mods.meta
    ) {
      const composerText = this.app.composer.text;
      if (composerText.trimStart().startsWith('/')) {
        const text = composerText.trim();
        this.app.clearComposer(true);
        this.options.onLocalCommand?.(text);
        this.render();
        return;
      }
      // '!command' runs locally through the core, never as a model prompt. The
      // handler clears the composer once it accepts the command; while a turn
      // is running it keeps the text so the user can retry.
      if (composerText.trimStart().startsWith('!')) {
        this.options.onLocalCommand?.(composerText.trim());
        this.render();
        return;
      }
    }

    const command = this.app.handleKey(key);
    this.render();
    if (command !== undefined) this.dispatch(command);
  }

  private dispatch(command: UiCommand): void {
    if (!this.options.onCommand) return;
    try {
      const result = this.options.onCommand(command);
      if (result instanceof Promise) {
        void result.catch((error) => this.reportError(error));
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    this.app.addNotice(error instanceof Error ? error.message : String(error), 'error');
    this.render();
  }

  private resize(columns: number, rows: number): void {
    this.app.setSize(columns, rows);
    // Keep the previous front buffer so render() sees the dimension change and
    // the renderer repaints every cell. Replacing it with a blank
    // buffer of the new size hides the resize from the diff: blank cells are
    // "unchanged", so stale content from the old layout stays visible.
    this.render(true);
  }

  render(force = false): void {
    if (!this.running) return;
    const now = Date.now();
    const elapsed = now - this.lastRender;
    if (!force && elapsed < 16) {
      // Coalesce bursts (SSE text deltas, resize, key events) into one frame.
      // A trailing timer guarantees the latest state is painted even when no
      // further event arrives to trigger the next render.
      if (this.renderTimer === undefined) {
        this.renderTimer = setTimeout(() => {
          this.renderTimer = undefined;
          this.render(true);
        }, Math.max(1, 16 - elapsed));
        this.renderTimer.unref?.();
      }
      return;
    }
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.lastRender = now;
    this.archiveHistory();
    const { frame, cursor } = this.app.frameWithCursor();
    // A size mismatch forces every cell to repaint, including blanks.
    // Never emit ED2: iTerm2 may save the entire old screen to scrollback.
    if (this.front === undefined) this.front = new CellBuffer(0, 0);
    const output = this.renderer.render(this.front, frame, {
      cursor,
      cursorVisible: cursor !== null,
      clearOnResize: false,
    });
    this.front = frame;
    this.session.write(output);
  }


  /** Move hidden transcript rows into native scrollback; never capture the mouse. */
  private archiveHistory(): void {
    const state = this.app.state;
    if (state.mode !== 'main' || state.scroll.offset !== 0) return;
    const width = state.width;
    const height = state.height;
    if (width < 1 || height < 1) return;
    const options = {
      cells: state.transcript,
      active: state.activeAssistant,
      welcome: width < 40 ? null : {
        version: state.version, model: state.session.model, cwd: state.session.cwd,
        sessionId: state.session.sessionId,
        ...(state.session.home ? { home: state.session.home } : {}),
      },
    };
    const total = transcriptHeight(options, width);
    const visible = computeFrameLayout(state, width, height).transcript.height;
    const hidden = Math.max(0, total - visible);
    const reset = this.archiveSession !== state.session.sessionId
      || (this.archiveCells.length > 0 && state.transcript.length === 0);
    if (reset) this.archivedRows = 0;
    // Previously archived rows are terminal-owned and reflow there on resize.
    // Rebase the current viewport rather than writing duplicate old history.
    if (!reset && this.archiveWidth !== 0 && this.archiveWidth !== width) {
      this.archivedRows = hidden;
    }
    this.archiveSession = state.session.sessionId;
    this.archiveWidth = width;
    this.archiveCells = state.transcript;
    if (hidden <= this.archivedRows) return;
    const count = hidden - this.archivedRows;
    const lines = layoutTranscript({ ...options, scrollOffset: visible }, width, count).lines;
    let archivedOutput = '';
    for (const line of lines) {
      const row = new CellBuffer(width, 1);
      drawStyledLine(row, { x: 0, y: 0, width, height: 1 }, 0, line);
      // Replace the top row, then scroll the whole primary screen by one line.
      // Only the transcript enters scrollback, never the composer or overlays.
      archivedOutput += '\x1b[H\x1b[2K' + this.renderer.render(new CellBuffer(width, 1), row)
        + '\x1b[' + height + ';1H\r\n';
    }
    this.archivedRows = hidden;
    this.session.write(archivedOutput);
    // Scrolling invalidates every physical row, including blank cells.
    this.front = new CellBuffer(0, 0);
  }

  private tick(): void {
    if (!this.running) return;
    if (this.input.shouldFlush()) {
      for (const event of this.input.flushPending()) this.handleInput(event);
    }
    if (
      (this.app.status.state === 'working' || this.app.status.state === 'awaiting') &&
      Date.now() - this.lastRender >= 100
    ) {
      this.render();
    }
  }
}
