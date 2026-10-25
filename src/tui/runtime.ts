import { ATTR_REVERSE, CellBuffer } from './terminal/buffer.js';
import { copyTextToClipboard } from '../util/clipboard.js';
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
  /** Injection point for selection-copy tests; defaults to OSC52/native clipboard. */
  copySelection?: (text: string) => Promise<string> | string;
  onIdleCtrlC?: () => void;
  onSignal?: (signal: SessionSignal) => void;
  tickMs?: number;
}

/**
 * Owns the real terminal: alt screen/raw mode, incremental input, frame diffing
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
  private running = false;
  private stopped = false;
  private lastRender = 0;
  private selection: { anchorX: number; anchorY: number; focusX: number; focusY: number; dragged: boolean } | undefined;

  constructor(options: TuiRuntimeOptions) {
    this.options = options;
    this.app = options.app;
    this.io = options.io;
    this.input = options.input ?? new InputParser();
    this.renderer = options.renderer ?? new Renderer({
      colorMode: options.colorMode ?? 'truecolor',
    });
    this.session = new TerminalSession(options.io, {
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
    this.app.setSize(this.io.columns, this.io.rows);
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
    if (event.type === 'mouse') {
      this.handleMouse(event);
      return;
    }
    if (event.type === 'wheel') {
      if (event.direction === 'up') this.app.scrollUp(3);
      else this.app.scrollDown(3);
      this.render();
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
      !key.mods.meta &&
      this.app.composer.text.trimStart().startsWith('/')
    ) {
      const text = this.app.composer.text.trim();
      this.app.clearComposer(true);
      this.options.onLocalCommand?.(text);
      this.render();
      return;
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
    this.front = new CellBuffer(columns, rows);
    this.render(true);
  }

  render(force = false): void {
    if (!this.running) return;
    const now = Date.now();
    if (!force && now - this.lastRender < 16) return;
    this.lastRender = now;
    const { frame, cursor } = this.app.frameWithCursor();
    if (this.selection !== undefined) this.highlightSelection(frame);
    if (this.front === undefined || this.front.width !== frame.width || this.front.height !== frame.height) {
      this.front = new CellBuffer(frame.width, frame.height);
    }
    const output = this.renderer.render(this.front, frame, {
      cursor,
      cursorVisible: cursor !== null,
    });
    this.front = frame;
    this.session.write(output);
  }

  private handleMouse(event: import('./terminal/input.js').MouseEvent): void {
    const frame = this.app.frame();
    if (frame.width === 0 || frame.height === 0) return;
    const x = Math.min(frame.width - 1, Math.max(0, event.x - 1));
    const y = Math.min(frame.height - 1, Math.max(0, event.y - 1));
    if (event.action === 'press') {
      if (event.button !== 0) return;
      this.selection = { anchorX: x, anchorY: y, focusX: x, focusY: y, dragged: false };
      this.render();
      return;
    }
    if (this.selection === undefined) return;
    if (event.action === 'drag') {
      this.selection = { ...this.selection, focusX: x, focusY: y, dragged: true };
      this.render();
      return;
    }
    if (event.action === 'release') {
      const selection = this.selection;
      this.selection = undefined;
      const text = selection.dragged ? this.selectionText(selection) : '';
      this.render(true);
      if (text.trim().length > 0) void this.copySelectionText(text);
    }
  }

  private selectionBounds(selection: { anchorX: number; anchorY: number; focusX: number; focusY: number }): {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } {
    const anchorFirst = selection.anchorY < selection.focusY ||
      (selection.anchorY === selection.focusY && selection.anchorX <= selection.focusX);
    return anchorFirst
      ? { startX: selection.anchorX, startY: selection.anchorY, endX: selection.focusX, endY: selection.focusY }
      : { startX: selection.focusX, startY: selection.focusY, endX: selection.anchorX, endY: selection.anchorY };
  }

  private highlightSelection(frame: CellBuffer): void {
    if (this.selection === undefined) return;
    const { startX, startY, endX, endY } = this.selectionBounds(this.selection);
    for (let y = startY; y <= endY; y++) {
      const from = y === startY ? startX : 0;
      const to = y === endY ? endX : frame.width - 1;
      for (let x = from; x <= to; x++) {
        const cell = frame.get(x, y);
        if (cell === undefined || cell.width === 0) continue;
        frame.set(x, y, { ...cell, attrs: cell.attrs | ATTR_REVERSE });
      }
    }
  }

  private selectionText(selection: { anchorX: number; anchorY: number; focusX: number; focusY: number }): string {
    const frame = this.app.frame();
    const { startX, startY, endX, endY } = this.selectionBounds(selection);
    const lines: string[] = [];
    for (let y = startY; y <= endY; y++) {
      const from = y === startY ? startX : 0;
      const to = y === endY ? endX : frame.width - 1;
      let line = '';
      for (let x = from; x <= to; x++) {
        const cell = frame.get(x, y);
        if (cell === undefined || cell.width === 0) continue;
        line += cell.symbol;
      }
      lines.push(line.replace(/ +$/u, ''));
    }
    return lines.join('\n');
  }

  private async copySelectionText(text: string): Promise<void> {
    try {
      const method = this.options.copySelection !== undefined
        ? await this.options.copySelection(text)
        : await copyTextToClipboard(text, { write: (chunk) => { this.session.write(chunk); } });
      this.app.addNotice('Copied selection (' + text.length + ' chars) to clipboard (' + method + ').');
    } catch (error) {
      this.app.addNotice('Clipboard copy failed: ' + (error instanceof Error ? error.message : String(error)), 'error');
    }
    this.render(true);
  }

  private tick(): void {
    if (!this.running) return;
    if (this.input.shouldFlush()) {
      for (const event of this.input.flushPending()) this.handleInput(event);
    }
    if (this.app.status.state === 'working' && Date.now() - this.lastRender >= 100) {
      this.render(true);
    }
  }
}