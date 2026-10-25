import type { TurnResult } from '../agent/index.js';
import type { SessionHandle } from '../session/index.js';
import { TuiRuntime } from '../tui/runtime.js';
import type { TerminalIO } from '../tui/terminal/session.js';
import type { TuiApp, TuiCopyTarget } from '../tui/state/app.js';
import type { UiCommand } from '../tui/state/commands.js';
import { copyTextToClipboard } from '../util/clipboard.js';

export interface TuiSessionOptions {
  app: TuiApp;
  io: TerminalIO;
  session: SessionHandle;
  runTurn: (text: string, signal: AbortSignal) => Promise<TurnResult>;
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
  private readonly initialPrompt: string | undefined;
  private active: AbortController | undefined;
  private exiting = false;
  private finished = false;
  private resolveRun: ((code: number) => void) | undefined;
  private exitCode = 0;
  private lastCtrlC = 0;

  constructor(options: TuiSessionOptions) {
    this.app = options.app;
    this.session = options.session;
    this.runTurn = options.runTurn;
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
      case 'approval':
      case 'resume':
      case 'fork':
        this.app.addNotice('This overlay is not available in this build.', 'warning');
        this.render();
        return;
    }
  }

  handleLocalCommand(text: string): void {
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

  private async copyTarget(target: TuiCopyTarget): Promise<void> {
    const text = this.app.copyText(target);
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
