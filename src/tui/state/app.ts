import type { UiEvent } from '../../agent/events.js';
import type { ToolCall } from '../../providers/types.js';
import { EMPTY_USAGE, addUsage, type TokenUsage } from '../../providers/types.js';
import type { PlanStep } from '../../tools/types.js';
import type { CellBuffer } from '../terminal/buffer.js';
import type { KeyEvent } from '../terminal/input.js';
import { composeFrame, composeFrameWithCursor, computeFrameLayout } from '../app.js';
import type { UiCommand } from './commands.js';
import type {
  AssistantCell,
  ComposerState,
  ExecCell,
  NoticeCell,
  PlanCell,
  TranscriptCell,
  TurnSummaryCell,
  TuiAppState,
  TuiErrorInfo,
  TuiSessionState,
  TuiStatus,
  UserCell,
} from './types.js';
import {
  clearComposer,
  createComposerState,
  deleteComposerBackward,
  deleteComposerForward,
  deleteComposerToLineEnd,
  deleteComposerToLineStart,
  deleteComposerWordBackward,
  historyNext,
  historyPrevious,
  insertComposerNewline,
  insertComposerText,
  moveComposerCursor,
} from '../widgets/composer.js';
import { slashMatches, type SlashCommand } from './slash.js';
import { transcriptHeight } from '../widgets/transcript.js';

/**
 * Explicit TUI state machine.
 *
 * TuiApp only consumes UiEvents, produces UiCommands and paints a CellBuffer.
 * It never reads process streams, timers, the model or the session store; the
 * clock is injected for tests and for the eventual CLI event loop.
 */

export type TuiCopyTarget = 'transcript' | 'last' | 'status' | 'input' | 'meta' | 'screen' | 'all';

export interface TuiAppOptions {
  readonly session: TuiSessionState;
  readonly version: string;
  readonly width?: number;
  readonly height?: number;
  readonly now?: () => number;
  readonly contextPercent?: number;
  readonly contextWindowTokens?: number;
  /** Total turn number already present in resumed history. */
  readonly initialTurnNumber?: number;
  readonly initialUsage?: TokenUsage;
  readonly initialTranscript?: readonly TranscriptCell[];
}

function dimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function copyUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
  };
}

function copySteps(steps: readonly PlanStep[]): PlanStep[] {
  return steps.map((step) => ({ step: step.step, status: step.status }));
}

function deriveTitle(text: string): string {
  const single = text.replace(/\s+/gu, ' ').trim();
  return single.length <= 60 ? single : single.slice(0, 59) + '…';
}

function copyError(error: TuiErrorInfo | undefined): TuiErrorInfo | undefined {
  if (error === undefined) return undefined;
  return { ...(error.code === undefined ? {} : { code: error.code }), message: error.message };
}

/** Human label after 'Ran '. Shell commands are shown verbatim. */
export function toolCommandLabel(call: ToolCall): string {
  const input = typeof call.input === 'object' && call.input !== null
    ? (call.input as Record<string, unknown>)
    : {};
  if (typeof input.command === 'string' && input.command.length > 0) return input.command;
  if (typeof input.path === 'string' && input.path.length > 0) return call.name + ' ' + input.path;
  return call.name;
}

function isCtrl(key: KeyEvent, code: string): boolean {
  return key.mods.ctrl && key.code === code;
}

function isEscape(key: KeyEvent): boolean {
  return key.code === 'escape' || key.code === 'esc';
}

function isPlainText(key: KeyEvent): boolean {
  return !key.mods.ctrl && !key.mods.alt && !key.mods.meta;
}

function isNewlineKey(key: KeyEvent): boolean {
  if (key.code === 'j' && key.mods.ctrl) return true;
  if (key.code === 'enter' && (key.mods.shift || key.mods.alt || key.mods.ctrl)) return true;
  return false;
}

export class TuiApp {
  private readonly now: () => number;
  private current: TuiAppState;
  private nextCellNumber = 0;

  constructor(options: TuiAppOptions) {
    this.now = options.now ?? (() => Date.now());
    const width = dimension(options.width, 80);
    const height = dimension(options.height, 24);
    this.current = {
      mode: 'main',
      session: {
        sessionId: options.session.sessionId,
        cwd: options.session.cwd,
        model: options.session.model,
        ...(options.session.home ? { home: options.session.home } : {}),
        ...(options.session.title ? { title: options.session.title } : {}),
      },
      version: options.version,
      width,
      height,
      transcript: options.initialTranscript ? [...options.initialTranscript] : [],
      activeAssistant: null,
      plan: [],
      status: { state: 'idle', elapsedMs: 0 },
      usage: copyUsage(EMPTY_USAGE),
      queue: [],
      composer: createComposerState(),
      scroll: { offset: 0 },
      slashIndex: 0,
      slashDismissed: false,
      turnNumber: Number.isFinite(options.initialTurnNumber) && (options.initialTurnNumber ?? 0) > 0
        ? Math.floor(options.initialTurnNumber as number)
        : 0,
      currentTurnSteps: 0,
      totalUsage: copyUsage(options.initialUsage ?? EMPTY_USAGE),
      turnLlmDurationMs: 0,
      turnToolDurationMs: 0,
      contextUsedTokens: 0,
      contextWindowTokens: Number.isFinite(options.contextWindowTokens) && (options.contextWindowTokens ?? 0) > 0
        ? Math.floor(options.contextWindowTokens as number)
        : 1_000_000,
      ...(options.contextPercent === undefined ? {} : { contextPercent: clampPercent(options.contextPercent) }),
    };
  }

  get state(): TuiAppState {
    return this.current;
  }

  get mode(): TuiAppState['mode'] {
    return this.current.mode;
  }

  get transcript(): TuiAppState['transcript'] {
    return this.current.transcript;
  }

  get composer(): ComposerState {
    return this.current.composer;
  }

  get slashMenu(): readonly SlashCommand[] {
    if (this.current.slashDismissed) return [];
    return slashMatches(this.current.composer.text);
  }

  get slashSelected(): number {
    const count = this.slashMenu.length;
    if (count === 0) return 0;
    return Math.min(this.current.slashIndex, count - 1);
  }

  get status(): TuiStatus {
    return this.current.status;
  }

  get queue(): TuiAppState['queue'] {
    return this.current.queue;
  }

  get scrollOffset(): number {
    return this.current.scroll.offset;
  }

  get contextPercent(): number | undefined {
    return this.current.contextPercent;
  }

  getState(): TuiAppState {
    return this.current;
  }

  private patch(partial: Partial<TuiAppState>): void {
    this.current = { ...this.current, ...partial };
  }

  private nextId(prefix: string): string {
    this.nextCellNumber++;
    return prefix + '-' + this.nextCellNumber;
  }

  private appendCell(cell: TuiAppState['transcript'][number]): void {
    this.patch({ transcript: [...this.current.transcript, cell] });
  }

  private finalizeActiveAssistant(): void {
    const active = this.current.activeAssistant;
    if (active === null) return;
    if (active.text.trim().length === 0) {
      this.patch({ activeAssistant: null });
      return;
    }
    const cell: AssistantCell = {
      type: 'assistant',
      id: active.id,
      turnId: active.turnId,
      text: active.text,
      ...(active.durationMs === undefined ? {} : { durationMs: active.durationMs }),
    };
    this.patch({ activeAssistant: null, transcript: [...this.current.transcript, cell] });
  }

  handleEvent(event: UiEvent): void {
    switch (event.type) {
      case 'session.info': {
        this.patch({
          session: {
            sessionId: event.session.sessionId,
            cwd: event.session.cwd,
            model: event.session.model,
            ...(this.current.session.home ? { home: this.current.session.home } : {}),
            ...(this.current.session.title ? { title: this.current.session.title } : {}),
          },
        });
        return;
      }

      case 'turn.started': {
        this.finalizeActiveAssistant();
        this.patch({
          status: {
            state: 'working',
            turnId: event.turnId,
            startedAt: this.now(),
            elapsedMs: 0,
          },
          turnNumber: this.current.turnNumber + 1,
          currentTurnSteps: 0,
          turnLlmDurationMs: 0,
          turnToolDurationMs: 0,
          activeAssistant: { id: this.nextId('assistant'), turnId: event.turnId, text: '' },
        });
        return;
      }

      case 'text.delta': {
        if (event.text.length === 0) return;
        const current = this.current.activeAssistant;
        if (current !== null && current.turnId === event.turnId) {
          this.patch({ activeAssistant: { ...current, text: current.text + event.text } });
          return;
        }
        if (current !== null) this.finalizeActiveAssistant();
        this.patch({
          activeAssistant: { id: this.nextId('assistant'), turnId: event.turnId, text: event.text },
        });
        return;
      }

      case 'tool.started': {
        this.finalizeActiveAssistant();
        const cell: ExecCell = {
          type: 'exec',
          id: this.nextId('exec'),
          callId: event.call.id,
          name: event.call.name,
          command: toolCommandLabel(event.call),
          output: '',
          isError: false,
          running: true,
        };
        this.appendCell(cell);
        return;
      }

      case 'llm.finished': {
        const active = this.current.activeAssistant;
        this.patch({
          turnLlmDurationMs: this.current.turnLlmDurationMs + Math.max(0, event.durationMs),
          ...(active !== null && active.turnId === event.turnId
            ? { activeAssistant: { ...active, durationMs: event.durationMs } }
            : {}),
        });
        return;
      }

      case 'tool.finished': {
        const transcript = [...this.current.transcript];
        let updated = false;
        for (let index = transcript.length - 1; index >= 0; index--) {
          const cell = transcript[index];
          if (cell === undefined || cell.type !== 'exec' || cell.callId !== event.callId) continue;
          transcript[index] = {
            ...cell,
            output: event.result.content,
            isError: event.result.isError === true,
            durationMs: event.durationMs,
            running: false,
          };
          updated = true;
          break;
        }
        if (!updated) {
          transcript.push({
            type: 'exec',
            id: this.nextId('exec'),
            callId: event.callId,
            name: event.name,
            command: event.name,
            output: event.result.content,
            isError: event.result.isError === true,
            durationMs: event.durationMs,
            running: false,
          });
        }
        this.patch({
          transcript,
          turnToolDurationMs: this.current.turnToolDurationMs + Math.max(0, event.durationMs),
        });
        return;
      }

      case 'plan.updated': {
        this.finalizeActiveAssistant();
        const steps = copySteps(event.steps);
        this.patch({ plan: steps });
        if (steps.length > 0) {
          const cell: PlanCell = { type: 'plan', id: this.nextId('plan'), steps };
          this.appendCell(cell);
        }
        return;
      }

      case 'usage.updated': {
        this.patch({ usage: copyUsage(event.usage) });
        return;
      }

      case 'context.updated': {
        this.patch({
          contextUsedTokens: Math.max(0, Number.isFinite(event.usedTokens) ? event.usedTokens : 0),
          contextWindowTokens: event.windowTokens > 0 ? Math.floor(event.windowTokens) : this.current.contextWindowTokens,
          currentTurnSteps: Math.max(0, Math.floor(event.steps)),
        });
        return;
      }

      case 'turn.finished': {
        this.finalizeActiveAssistant();
        const transcript = [...this.current.transcript];
        let error: TuiErrorInfo | undefined;
        if (event.status === 'error') {
          const code = event.error?.code;
          const message = event.error?.message ?? 'unknown error';
          error = { ...(code === undefined ? {} : { code }), message };
          const notice: NoticeCell = {
            type: 'notice',
            id: this.nextId('notice'),
            level: 'error',
            text: code !== undefined && code.length > 0 ? code + ': ' + message : message,
          };
          transcript.push(notice);
        }
        const status: TuiStatus = {
          state: 'idle',
          elapsedMs: Math.max(0, Number.isFinite(event.durationMs) ? event.durationMs : 0),
          outcome: event.status,
          ...(error === undefined ? {} : { error: copyError(error) as TuiErrorInfo }),
        };
        const summary: TurnSummaryCell = {
          type: 'turn',
          id: this.nextId('turn'),
          outcome: event.status,
          completedAt: this.now(),
          durationMs: Math.max(0, Number.isFinite(event.durationMs) ? event.durationMs : 0),
          llmDurationMs: this.current.turnLlmDurationMs,
          toolDurationMs: this.current.turnToolDurationMs,
          usage: copyUsage(event.usage),
        };
        transcript.push(summary);
        this.patch({
          activeAssistant: null,
          status,
          usage: copyUsage(event.usage),
          totalUsage: copyUsage(addUsage(this.current.totalUsage, event.usage)),
          transcript,
        });
        return;
      }
    }
  }

  /** Append user text as a submitted cell and clear the composer. */
  submitText(text: string): UiCommand | undefined {
    if (text.trim().length === 0) return undefined;
    const cell: UserCell = { type: 'user', id: this.nextId('user'), text };
    const history = [...this.current.composer.history, text].slice(-100);
    const title = this.current.session.title?.trim().length
      ? this.current.session.title
      : deriveTitle(text);
    this.patch({
      transcript: [...this.current.transcript, cell],
      session: { ...this.current.session, ...(title ? { title } : {}) },
      composer: createComposerState('', history),
      slashIndex: 0,
      slashDismissed: false,
    });
    return { type: 'submit', text };
  }

  private submitComposer(): UiCommand | undefined {
    return this.submitText(this.current.composer.text);
  }

  /** Clear the composer; optionally add the current text to history. */
  clearComposer(addToHistory = false): void {
    const composer = this.current.composer;
    const history = addToHistory ? [...composer.history, composer.text].slice(-100) : composer.history;
    this.patch({ composer: createComposerState('', history), slashIndex: 0, slashDismissed: false });
  }

  /** Queue text above the composer without submitting it. */
  enqueue(text: string, submitted = false): void {
    if (text.trim().length === 0) return;
    this.patch({
      queue: [...this.current.queue, { id: this.nextId('queue'), text, submitted }],
    });
  }

  /** Remove and return the oldest queued item. */
  dequeue(): TuiAppState['queue'][number] | undefined {
    const first = this.current.queue[0];
    if (first === undefined) return undefined;
    this.patch({ queue: this.current.queue.slice(1) });
    return first;
  }

  /** Append a notice cell (errors/status info that did not come from the model). */
  addNotice(text: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    const cell: NoticeCell = { type: 'notice', id: this.nextId('notice'), level, text };
    this.appendCell(cell);
  }

  /** Finalize a failed turn that never produced a turn.finished event. */
  failTurn(message: string): void {
    this.finalizeActiveAssistant();
    const notice: NoticeCell = {
      type: 'notice',
      id: this.nextId('notice'),
      level: 'error',
      text: message,
    };
    this.patch({
      activeAssistant: null,
      status: {
        state: 'idle',
        elapsedMs: 0,
        outcome: 'error',
        error: { message },
      },
      transcript: [...this.current.transcript, notice],
    });
  }

  /** Open the read-only help overlay. */
  openHelp(): void {
    this.patch({ mode: 'help' });
  }

  /** Open the transcript overlay. */
  openTranscript(): void {
    this.patch({ mode: 'transcript' });
  }

  private queueComposer(): void {
    const composer = this.current.composer;
    if (composer.text.trim().length === 0) return;
    this.patch({
      queue: [...this.current.queue, { id: this.nextId('queue'), text: composer.text, submitted: false }],
      composer: clearComposer(composer),
    });
  }

  private pageSize(): number {
    return Math.max(1, Math.floor(this.current.height / 2));
  }

  private welcomeOptions(): { version: string; model: string; cwd: string; home?: string; sessionId: string } | null {
    if (this.current.width < 40) return null;
    return {
      version: this.current.version,
      model: this.current.session.model,
      cwd: this.current.session.cwd,
      sessionId: this.current.session.sessionId,
      ...(this.current.session.home ? { home: this.current.session.home } : {}),
    };
  }

  private maxScrollOffset(): number {
    const layout = computeFrameLayout(this.current, this.current.width, this.current.height);
    const total = transcriptHeight(
      {
        cells: this.current.transcript,
        active: this.current.activeAssistant,
        welcome: this.welcomeOptions(),
      },
      this.current.width,
    );
    return Math.max(0, total - layout.transcript.height);
  }

  private scrollBy(rows: number): void {
    const max = this.maxScrollOffset();
    const next = Math.min(max, Math.max(0, this.current.scroll.offset + rows));
    if (next !== this.current.scroll.offset) this.patch({ scroll: { offset: next } });
  }

  /** Positive rows scroll up (away from live output). */
  scrollUp(rows: number): void {
    this.scrollBy(Math.max(0, Math.floor(rows)));
  }

  /** Positive rows scroll down toward live output. */
  scrollDown(rows: number): void {
    this.scrollBy(-Math.max(0, Math.floor(rows)));
  }

  private applyScrollKey(key: KeyEvent): boolean {
    if (key.code === 'pageup') {
      this.scrollBy(this.pageSize());
      return true;
    }
    if (key.code === 'pagedown') {
      this.scrollBy(-this.pageSize());
      return true;
    }
    if (key.code === 'up' && key.mods.shift) {
      this.scrollBy(1);
      return true;
    }
    if (key.code === 'down' && key.mods.shift) {
      this.scrollBy(-1);
      return true;
    }
    return false;
  }

  private closeOverlayText(key: KeyEvent): boolean {
    if (!isPlainText(key)) return false;
    const text = (key.text ?? '').toLowerCase();
    if (text === 'q') return true;
    return this.current.mode === 'help' && text === '?';
  }

  private setComposer(composer: ComposerState): void {
    this.patch({ composer, slashIndex: 0, slashDismissed: false });
  }

  private completeSlash(): boolean {
    const commands = this.slashMenu;
    const command = commands[this.slashSelected];
    if (!command) return false;
    this.patch({
      composer: createComposerState(command.name + ' ', this.current.composer.history),
      slashIndex: 0,
      slashDismissed: true,
    });
    return true;
  }

  handleKey(key: KeyEvent): UiCommand | undefined {
    const mode = this.current.mode;

    if (mode !== 'main') {
      if (isEscape(key) || isCtrl(key, 'c') || (mode === 'transcript' && isCtrl(key, 't')) || this.closeOverlayText(key)) {
        this.patch({ mode: 'main' });
        return undefined;
      }
      this.applyScrollKey(key);
      return undefined;
    }

    if (isCtrl(key, 't')) {
      this.patch({ mode: 'transcript' });
      return undefined;
    }

    if (this.applyScrollKey(key)) return undefined;

    if (key.text === '?' && isPlainText(key) && this.current.composer.text.length === 0) {
      this.patch({ mode: 'help' });
      return undefined;
    }

    if (isEscape(key) || isCtrl(key, 'c')) {
      if (isEscape(key) && !isCtrl(key, 'c') && this.slashMenu.length > 0) {
        this.patch({ slashDismissed: true });
        return undefined;
      }
      if (this.current.status.state === 'working' || this.current.status.state === 'awaiting') {
        // The core owns cancellation; the app does not clear the turn locally.
        return { type: 'interrupt' };
      }
      return undefined;
    }

    if (isNewlineKey(key)) {
      this.setComposer(insertComposerNewline(this.current.composer));
      return undefined;
    }

    if (key.code === 'enter') {
      const commands = this.slashMenu;
      if (commands.length > 0 && !commands.some((command) => command.name === this.current.composer.text)) {
        this.completeSlash();
        return undefined;
      }
      return this.submitComposer();
    }

    if (key.code === 'tab' && !key.mods.shift) {
      if (this.completeSlash()) return undefined;
      if (this.current.status.state === 'working') this.queueComposer();
      return undefined;
    }

    if ((key.code === 'up' || key.code === 'down') && this.slashMenu.length > 0 && !key.mods.ctrl && !key.mods.alt) {
      const count = this.slashMenu.length;
      const delta = key.code === 'up' ? -1 : 1;
      this.patch({ slashIndex: (this.slashSelected + delta + count) % count });
      return undefined;
    }

    if (key.code === 'up' && !key.mods.ctrl && !key.mods.alt) {
      if (this.current.composer.text.length === 0 || this.current.composer.historyIndex >= 0) {
        this.setComposer(historyPrevious(this.current.composer));
      } else {
        this.setComposer(moveComposerCursor(this.current.composer, 'up'));
      }
      return undefined;
    }

    if (key.code === 'down' && !key.mods.ctrl && !key.mods.alt) {
      if (this.current.composer.text.length === 0 || this.current.composer.historyIndex >= 0) {
        this.setComposer(historyNext(this.current.composer));
      } else {
        this.setComposer(moveComposerCursor(this.current.composer, 'down'));
      }
      return undefined;
    }

    if (key.code === 'left' && !key.mods.ctrl && !key.mods.alt) {
      this.setComposer(moveComposerCursor(this.current.composer, 'left'));
      return undefined;
    }

    if (key.code === 'right' && !key.mods.ctrl && !key.mods.alt) {
      this.setComposer(moveComposerCursor(this.current.composer, 'right'));
      return undefined;
    }

    if (key.code === 'home') {
      this.setComposer(moveComposerCursor(this.current.composer, 'home'));
      return undefined;
    }

    if (key.code === 'end') {
      this.setComposer(moveComposerCursor(this.current.composer, 'end'));
      return undefined;
    }

    if (key.code === 'backspace') {
      this.setComposer(deleteComposerBackward(this.current.composer));
      return undefined;
    }

    if (key.code === 'delete') {
      this.setComposer(deleteComposerForward(this.current.composer));
      return undefined;
    }

    if (isCtrl(key, 'a')) {
      this.setComposer(moveComposerCursor(this.current.composer, 'home'));
      return undefined;
    }

    if (isCtrl(key, 'e')) {
      this.setComposer(moveComposerCursor(this.current.composer, 'end'));
      return undefined;
    }

    if (isCtrl(key, 'w')) {
      this.setComposer(deleteComposerWordBackward(this.current.composer));
      return undefined;
    }

    if (isCtrl(key, 'k')) {
      this.setComposer(deleteComposerToLineEnd(this.current.composer));
      return undefined;
    }

    if (isCtrl(key, 'u')) {
      this.setComposer(deleteComposerToLineStart(this.current.composer));
      return undefined;
    }

    if (key.text !== undefined && key.text.length > 0 && isPlainText(key)) {
      this.setComposer(insertComposerText(this.current.composer, key.text));
      return undefined;
    }

    return undefined;
  }

  setSize(width: number, height: number): void {
    const nextWidth = Number.isFinite(width) && width >= 1 ? Math.floor(width) : this.current.width;
    const nextHeight = Number.isFinite(height) && height >= 1 ? Math.floor(height) : this.current.height;
    this.patch({ width: nextWidth, height: nextHeight });
    const max = this.maxScrollOffset();
    if (this.current.scroll.offset > max) this.patch({ scroll: { offset: max } });
  }

  setContextPercent(percentLeft: number | undefined): void {
    if (percentLeft === undefined || !Number.isFinite(percentLeft)) {
      this.patch({ contextPercent: undefined });
      return;
    }
    this.patch({ contextPercent: clampPercent(percentLeft) });
  }

  /** Plain text suitable for clipboard export; UI-only cells are omitted. */
  transcriptText(): string {
    const blocks: string[] = [];
    for (const cell of this.current.transcript) {
      const text = copyTextForCell(cell);
      if (text.length > 0) blocks.push(text);
    }
    const active = this.current.activeAssistant;
    if (active !== null && active.text.trim().length > 0) blocks.push(active.text);
    return blocks.join('\n\n');
  }

  copyText(target: TuiCopyTarget): string {
    if (target === 'transcript') return this.transcriptText();
    if (target === 'last') return this.lastAssistantText();
    if (target === 'input') return this.current.composer.text;
    if (target === 'screen') return this.frameText();
    const layout = computeFrameLayout(this.current, this.current.width, this.current.height);
    const row = (y: number): string => this.frameRowText(this.frame(), y);
    if (target === 'status') return row(layout.status.y);
    if (target === 'meta') return row(layout.meta.y);
    return [
      '== Transcript ==',
      this.transcriptText(),
      '== StatusRow ==',
      row(layout.status.y),
      '== Composer ==',
      this.current.composer.text,
      '== MetaBar ==',
      row(layout.meta.y),
    ].join('\n');
  }

  private frameText(): string {
    const frame = this.frame();
    const rows: string[] = [];
    for (let y = 0; y < frame.height; y++) rows.push(this.frameRowText(frame, y));
    return rows.join('\n').replace(/\n+$/u, '');
  }

  private frameRowText(frame: CellBuffer, y: number): string {
    let text = '';
    for (let x = 0; x < frame.width; x++) text += frame.get(x, y)?.symbol ?? ' ';
    return text.replace(/ +$/u, '');
  }

  lastAssistantText(): string {
    const active = this.current.activeAssistant;
    if (active !== null && active.text.trim().length > 0) return active.text;
    for (let index = this.current.transcript.length - 1; index >= 0; index--) {
      const cell = this.current.transcript[index];
      if (cell?.type === 'assistant' && cell.text.trim().length > 0) return cell.text;
    }
    return '';
  }

  frame(width = this.current.width, height = this.current.height): CellBuffer {
    return composeFrame(this.current, { width, height, now: this.now() });
  }

  frameWithCursor(width = this.current.width, height = this.current.height): ReturnType<typeof composeFrameWithCursor> {
    return composeFrameWithCursor(this.current, { width, height, now: this.now() });
  }

  renderFrame(): CellBuffer {
    return this.frame(this.current.width, this.current.height);
  }
}
function copyTextForCell(cell: TranscriptCell): string {
  switch (cell.type) {
    case 'user':
      return '› ' + cell.text;
    case 'assistant':
      return cell.text;
    case 'exec':
      return ['$ ' + cell.command, cell.output].filter((line) => line.length > 0).join('\n');
    case 'plan':
      return 'Plan:\n' + cell.steps.map((step) => '- [' + step.status + '] ' + step.step).join('\n');
    case 'notice':
      return cell.text;
    case 'turn':
      return (
        '✓ turn ' + cell.outcome +
        ' · total ' + Math.max(0, Math.round(cell.durationMs / 1000)) + 's' +
        ' · in ' + cell.usage.inputTokens +
        ' · out ' + cell.usage.outputTokens
      );
  }
}