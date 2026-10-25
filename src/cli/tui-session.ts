import type { TurnResult } from '../agent/index.js';
import type { SessionHandle } from '../session/index.js';
import type { AskAnswer, AskQuestion } from '../tools/index.js';
import { abortError } from '../util/errors.js';
import { TuiRuntime } from '../tui/runtime.js';
import type { TerminalIO } from '../tui/terminal/session.js';
import type { TuiApp, TuiCopyTarget } from '../tui/state/app.js';
import type { UiCommand } from '../tui/state/commands.js';
import { copyTextToClipboard } from '../util/clipboard.js';
import { debugLog } from '../util/debug.js';
import { describeModelSelection, parseModelCommand, type ModelSelection } from './model-command.js';

export interface TuiModelController {
  get(): ModelSelection;
  set(selection: ModelSelection): Promise<void> | void;
}

export interface TuiSessionOptions {
  app: TuiApp;
  io: TerminalIO;
  session: SessionHandle;
  runTurn: (text: string, signal: AbortSignal) => Promise<TurnResult>;
  /** Model/effort control backed by the router and AgentLoop. */
  model?: TuiModelController;
  /** Reset agent-loop state after the rollout is cleared. */
  onClear?: () => void;
  initialPrompt?: string;
}

/**
 * Connects TuiApp/TuiRuntime to an AgentLoop for one interactive session.
 * Local commands and queue scheduling live here; widgets stay pure.
 */
export class TuiSession {
  readonly app: TuiApp;
  readonly runtime: TuiRuntime;
  private readonly session: SessionHandle;
  private readonly runTurn: (text: string, signal: AbortSignal) => Promise<TurnResult>;
  private readonly model: TuiModelController | undefined;
  private readonly onClear: (() => void) | undefined;
  private readonly initialPrompt: string | undefined;
  private active: AbortController | undefined;
  private clearing = false;
  private changingModel = false;
  private exiting = false;
  private finished = false;
  private resolveRun: ((code: number) => void) | undefined;
  private exitCode = 0;
  private lastCtrlC = 0;
  private pendingAsk: { resolve: (answers: readonly AskAnswer[] | null) => void } | undefined;

  constructor(options: TuiSessionOptions) {
    this.app = options.app;
    this.session = options.session;
    this.runTurn = options.runTurn;
    this.model = options.model;
    this.onClear = options.onClear;
    this.initialPrompt = options.initialPrompt;
    this.runtime = new TuiRuntime({
      app: options.app,
      io: options.io,
      onCommand: (command) => this.handleCommand(command),
      onLocalCommand: (text) => this.handleLocalCommand(text),
      onCopy: () => void this.copyTarget('all'),
      onIdleCtrlC: () => this.handleIdleCtrlC(),
      onSignal: () => this.exit(0),
    });
  }

  async run(): Promise<number> {
    if (!this.runtime.start()) {
      throw new Error('The terminal is not a TTY; use --plain.');
    }
    const done = new Promise<number>((resolve) => {
      this.resolveRun = resolve;
    });
    if (this.initialPrompt !== undefined && this.initialPrompt.trim().length > 0) {
      void this.submitProgrammatic(this.initialPrompt);
    }
    return done;
  }

  render(): void {
    this.runtime.render(true);
  }

  exit(code = 0): void {
    if (this.exiting) return;
    this.exiting = true;
    this.exitCode = code;
    this.active?.abort();
    this.runtime.stop();
    if (this.active === undefined) this.finish();
  }

  /**
   * Show a question and wait for the user's answer. The returned promise stays
   * pending until the TUI emits answer/cancel-ask, and rejects when the turn is
   * aborted so the agent loop can unwind immediately.
   */
  ask(questions: readonly AskQuestion[], signal?: AbortSignal): Promise<readonly AskAnswer[] | null> {
    if (this.exiting) return Promise.resolve(null);
    this.pendingAsk?.resolve(null);
    this.pendingAsk = undefined;

    return new Promise<readonly AskAnswer[] | null>((resolve, reject) => {
      let settled = false;
      let pending: { resolve: (answers: readonly AskAnswer[] | null) => void } | undefined;
      const release = (): void => {
        if (this.pendingAsk !== pending) return;
        this.pendingAsk = undefined;
        this.app.clearAsk();
        this.render();
      };
      const settle = (value: readonly AskAnswer[] | null): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        release();
        resolve(value);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        release();
        reject(abortError('Question cancelled.'));
      };

      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.app.showQuestion(questions);
      this.render();
      pending = { resolve: settle };
      this.pendingAsk = pending;
    });
  }

  handleCommand(command: UiCommand): void {
    if (this.exiting) return;
    switch (command.type) {
      case 'submit':
        // TuiApp already appended the user cell before returning this command.
        if (this.active !== undefined) {
          this.app.enqueue(command.text, true);
          this.render();
          return;
        }
        void this.runPrompt(command.text);
        return;
      case 'interrupt':
        this.active?.abort();
        return;
      case 'answer':
        this.pendingAsk?.resolve(command.answers);
        return;
      case 'cancel-ask':
        this.pendingAsk?.resolve(null);
        return;
      case 'approval':
      case 'resume':
      case 'fork':
        this.app.addNotice('This overlay is not available in this build.', 'warning');
        this.render();
        return;
    }
  }

  handleLocalCommand(text: string): void {
    if (this.exiting) return;
    const line = text.trim();
    if (line === '/quit' || line === '/exit') {
      this.exit(0);
      return;
    }
    if (line === '/help') {
      this.app.openHelp();
      this.render();
      return;
    }
    if (line === '/session') {
      this.app.addNotice('session: ' + this.session.id + '\nfile: ' + this.session.filePath);
      this.render();
      return;
    }
    if (line === '/model' || line.startsWith('/model ')) {
      this.handleModelCommand(line);
      return;
    }
    if (line === '/clear') {
      void this.clearSession();
      return;
    }
    if (line === '/queue') {
      this.app.addNotice(this.app.queue.length + ' queued prompt(s).');
      this.render();
      return;
    }
    if (line === '/copy' || line.startsWith('/copy ')) {
      const argument = line === '/copy' ? 'transcript' : line.slice('/copy '.length).trim();
      const target = copyTargetFromArgument(argument);
      if (target === undefined) {
        this.app.addNotice('Unknown copy target: ' + argument + '. Use transcript/status/input/meta/screen/all/last.', 'warning');
        this.render();
        return;
      }
      void this.copyTarget(target);
      return;
    }
    this.app.addNotice('Unknown command: ' + line + '. Use /help.', 'warning');
    this.render();
  }

  private currentModelSelection(): ModelSelection {
    if (this.model) return this.model.get();
    const session = this.app.state.session;
    return {
      model: session.model,
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
    };
  }

  private handleModelCommand(line: string): void {
    const current = this.currentModelSelection();
    const command = parseModelCommand(line, current);
    if (command.type === 'show') {
      this.app.addNotice(describeModelSelection(current));
      this.render();
      return;
    }
    if (command.type === 'error') {
      this.app.addNotice(command.message, 'warning');
      this.render();
      return;
    }
    if (this.changingModel) return;
    if (this.active !== undefined) {
      this.app.addNotice('Cannot change model while a turn is running.', 'warning');
      this.render();
      return;
    }
    void this.applyModelSelection(command.selection);
  }

  private async applyModelSelection(selection: ModelSelection): Promise<void> {
    this.changingModel = true;
    try {
      await this.model?.set(selection);
      this.app.setModel(selection.model, selection.reasoningEffort);
      this.app.addNotice('Model updated.\n' + describeModelSelection(selection));
    } catch (error) {
      this.app.addNotice(
        'Failed to update model: ' + (error instanceof Error ? error.message : String(error)),
        'error',
      );
    } finally {
      this.changingModel = false;
      this.render();
    }
  }

  private async clearSession(): Promise<void> {
    if (this.exiting || this.clearing) return;
    if (this.active !== undefined) {
      this.app.addNotice('Cannot clear the session while a turn is running.', 'warning');
      this.render();
      return;
    }
    this.clearing = true;
    try {
      // Reset persistence first: the UI and agent history must only be dropped
      // once the rollout rewrite succeeded, otherwise replay would disagree.
      await this.session.clear();
      this.onClear?.();
      this.app.resetSession();
      this.app.addNotice('Session cleared: conversation and rollout history were reset.');
    } catch (error) {
      this.app.addNotice(
        'Failed to clear session: ' + (error instanceof Error ? error.message : String(error)),
        'error',
      );
    } finally {
      this.clearing = false;
      this.render();
    }
  }

  private async copyTarget(target: TuiCopyTarget): Promise<void> {
    const text = this.app.copyText(target);
    debugLog('clipboard', 'copy target=' + target + ' chars=' + text.length + ' trimmed=' + text.trim().length);
    if (text.trim().length === 0) {
      this.app.addNotice('Nothing to copy yet.');
      this.render();
      return;
    }
    const method = await copyTextToClipboard(text, {
      write: (chunk) => {
        this.runtime.write(chunk);
      },
    });
    debugLog('clipboard', 'copy target=' + target + ' done method=' + method);
    this.app.addNotice('Copied ' + target + ' (' + text.length + ' chars) to clipboard (' + method + ').');
    this.render();
  }

  private handleIdleCtrlC(): void {
    const now = Date.now();
    if (now - this.lastCtrlC < 1_500) {
      this.lastCtrlC = 0;
      this.exit(0);
      return;
    }
    this.lastCtrlC = now;
    this.app.addNotice('Press Ctrl+C again to exit.');
  }

  private async submitProgrammatic(text: string): Promise<void> {
    if (this.exiting) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed.startsWith('/')) {
      this.handleLocalCommand(trimmed);
      return;
    }
    if (this.app.status.state === 'working' || this.app.status.state === 'awaiting') {
      this.app.enqueue(text);
      this.render();
      return;
    }
    const command = this.app.submitText(text);
    if (command?.type !== 'submit') return;
    this.render();
    await this.runPrompt(text);
  }

  private async runPrompt(text: string): Promise<void> {
    if (this.exiting) return;
    const controller = new AbortController();
    this.active = controller;
    try {
      await this.runTurn(text, controller.signal);
    } catch (error) {
      if (this.app.status.state === 'working' || this.app.status.state === 'awaiting') {
        this.app.failTurn(error instanceof Error ? error.message : String(error));
      } else {
        this.app.addNotice(error instanceof Error ? error.message : String(error), 'error');
      }
      this.render();
    } finally {
      this.active = undefined;
      if (this.exiting) {
        this.finish();
      } else {
        const queued = this.app.dequeue();
        if (queued !== undefined) {
          this.render();
          if (queued.submitted) void this.runPrompt(queued.text);
          else void this.submitProgrammatic(queued.text);
        }
      }
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.resolveRun?.(this.exitCode);
  }
}
function copyTargetFromArgument(value: string): TuiCopyTarget | undefined {
  switch (value.toLowerCase()) {
    case 'transcript':
      return 'transcript';
    case 'last':
      return 'last';
    case 'status':
    case 'statusrow':
      return 'status';
    case 'input':
    case 'composer':
      return 'input';
    case 'meta':
    case 'metabar':
      return 'meta';
    case 'screen':
      return 'screen';
    case 'all':
      return 'all';
    default:
      return undefined;
  }
}
