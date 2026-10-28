import type { TurnResult } from '../agent/index.js';
import { SessionGrants, approvalPrefixFor } from '../policy/index.js';
import type { ApprovalDecision, ApprovalRequest } from '../policy/types.js';
import type { SessionHandle } from '../session/index.js';
import type { AskAnswer, AskQuestion } from '../tools/index.js';
import { abortError } from '../util/errors.js';
import { generateRequestId } from '../util/ids.js';
import type { TuiApprovalRequest } from '../tui/state/types.js';
import { TuiRuntime } from '../tui/runtime.js';
import type { TerminalIO } from '../tui/terminal/session.js';
import type { TuiApp, TuiCopyTarget } from '../tui/state/app.js';
import type { UiCommand } from '../tui/state/commands.js';
import { copyTextToClipboard } from '../util/clipboard.js';
import { debugLog } from '../util/debug.js';
import { describeModelSelection, parseModelCommand, type ModelSelection } from './model-command.js';
import {
  localCommandAuditEvents,
  localCommandResultEvent,
  localCommandStartEvent,
  parseLocalCommand,
  type LocalCommandOutcome,
} from './local-command.js';

export interface TuiModelController {
  get(): ModelSelection;
  set(selection: ModelSelection): Promise<void> | void;
}

export interface TuiPermissionController {
  list(): readonly string[];
  current(): { profile: string; approvalPolicy: string };
  set(profile: string): Promise<void>;
}

/** Executes a user-issued '!command'; supplied by the CLI with policy/sandbox wired in. */
export type TuiLocalCommandRunner = (command: string, signal: AbortSignal) => Promise<LocalCommandOutcome>;

export interface TuiSessionOptions {
  app: TuiApp;
  io: TerminalIO;
  session: SessionHandle;
  runTurn: (text: string, signal: AbortSignal) => Promise<TurnResult>;
  /** Run '!command' through policy/approval/sandbox; absent disables the feature. */
  runLocalCommand?: TuiLocalCommandRunner;
  /** Model/effort control backed by the router and AgentLoop. */
  model?: TuiModelController;
  /** Permission profile listing/switching backed by the CLI bootstrap. */
  permissions?: TuiPermissionController;
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
  private readonly runLocalCommand: TuiLocalCommandRunner | undefined;
  private readonly model: TuiModelController | undefined;
  private readonly permissions: TuiPermissionController | undefined;
  private readonly onClear: (() => void) | undefined;
  private readonly initialPrompt: string | undefined;
  private active: AbortController | undefined;
  private localActive: AbortController | undefined;
  private clearing = false;
  private changingModel = false;
  private changingPermission = false;
  private exiting = false;
  private finished = false;
  private resolveRun: ((code: number) => void) | undefined;
  private exitCode = 0;
  private lastCtrlC = 0;
  private pendingAsk: { resolve: (answers: readonly AskAnswer[] | null) => void } | undefined;
  private pendingApproval:
    | {
        requestId: string;
        request: ApprovalRequest;
        resolve: (decision: ApprovalDecision) => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  private readonly grants: SessionGrants;

  constructor(options: TuiSessionOptions) {
    this.app = options.app;
    this.session = options.session;
    this.runTurn = options.runTurn;
    this.runLocalCommand = options.runLocalCommand;
    this.model = options.model;
    this.permissions = options.permissions;
    this.onClear = options.onClear;
    this.initialPrompt = options.initialPrompt;
    this.grants = new SessionGrants(options.app.state.session.cwd);
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
    this.runtime.render();
  }

  exit(code = 0): void {
    if (this.exiting) return;
    this.exiting = true;
    this.exitCode = code;
    const pending = this.pendingApproval;
    if (pending !== undefined) pending.reject(abortError('Session exiting.'));
    this.active?.abort();
    this.localActive?.abort();
    this.runtime.stop();
    if (this.active === undefined && this.localActive === undefined) this.finish();
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

  /**
   * Show the approval panel and wait for a decision. Session/prefix grants are
   * kept in memory only; every request/decision is also written to the rollout.
   */
  async approve(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (this.exiting) return { decision: 'deny', reason: 'The session is exiting.' };
    if (signal?.aborted === true) throw abortError('Approval cancelled.');
    if (this.grants.permits(request.action)) {
      void this.session.append({
        type: 'approval.decided',
        requestId: generateRequestId(),
        ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
        ...(request.callId === undefined ? {} : { callId: request.callId }),
        decision: 'allow',
        scope: 'once',
        decidedBy: 'session-grant',
      });
      return { decision: 'allow', scope: 'once' };
    }

    this.pendingApproval?.reject(abortError('Approval superseded.'));
    const requestId = generateRequestId();
    const cwd = this.app.state.session.cwd;
    const allowPrefix = approvalPrefixFor(request.action, request.action.cwd ?? cwd) !== undefined;
    const uiRequest: TuiApprovalRequest = {
      requestId,
      tool: request.tool,
      action: {
        kind: request.action.kind,
        tool: request.action.tool,
        ...(request.action.path === undefined ? {} : { path: request.action.path }),
        ...(request.action.command === undefined ? {} : { command: request.action.command }),
        ...(request.action.cwd === undefined ? {} : { cwd: request.action.cwd }),
        ...(request.action.network === undefined ? {} : { network: request.action.network }),
      },
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      risk: request.risk,
      allowPrefix,
    };

    await this.session.append({
      type: 'approval.requested',
      requestId,
      ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      tool: request.tool,
      action: request.action,
      risk: request.risk,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    });

    return new Promise<ApprovalDecision>((resolve, reject) => {
      let settled = false;
      let pending:
        | {
            requestId: string;
            request: ApprovalRequest;
            resolve: (decision: ApprovalDecision) => void;
            reject: (error: unknown) => void;
          }
        | undefined;
      const release = (): void => {
        if (this.pendingApproval !== pending) return;
        this.pendingApproval = undefined;
        signal?.removeEventListener('abort', onAbort);
        this.app.clearApproval();
        this.render();
      };
      const settle = (decision: ApprovalDecision): void => {
        if (settled) return;
        settled = true;
        release();
        resolve(decision);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        release();
        void this.session.append({
          type: 'approval.decided',
          requestId,
          ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
          ...(request.callId === undefined ? {} : { callId: request.callId }),
          decision: 'deny',
          reason: 'aborted',
          decidedBy: 'user',
        });
        reject(abortError('Approval cancelled.'));
      };

      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      pending = { requestId, request, resolve: settle, reject: (error) => {
        if (settled) return;
        settled = true;
        release();
        reject(error);
      } };
      this.pendingApproval = pending;
      this.app.showApproval(uiRequest);
      this.render();
    });
  }

  private resolveApproval(decision: ApprovalDecision): void {
    const pending = this.pendingApproval;
    if (pending === undefined) return;
    this.pendingApproval = undefined;
    const granted =
      decision.decision === 'allow' && decision.scope !== 'once'
        ? this.grants.grant(pending.request.action, decision.scope)
        : false;
    this.app.clearApproval();
    this.render();
    void this.session.append({
      type: 'approval.decided',
      requestId: pending.requestId,
      ...(pending.request.turnId === undefined ? {} : { turnId: pending.request.turnId }),
      ...(pending.request.callId === undefined ? {} : { callId: pending.request.callId }),
      decision: decision.decision,
      ...(decision.decision === 'allow' ? { scope: decision.scope } : {}),
      ...(decision.decision === 'deny' && decision.reason !== undefined ? { reason: decision.reason } : {}),
      decidedBy: 'user',
    });
    if (granted && decision.decision === 'allow') {
      void this.session.append({
        type: 'permission.granted',
        requestId: pending.requestId,
        scope: decision.scope,
        action: pending.request.action,
      });
    }
    pending.resolve(decision);
  }

  handleCommand(command: UiCommand): void {
    if (this.exiting) return;
    switch (command.type) {
      case 'submit':
        // TuiApp already appended the user cell before returning this command.
        if (this.active !== undefined || this.localActive !== undefined) {
          this.app.enqueue(command.text, true);
          this.render();
          return;
        }
        void this.runPrompt(command.text);
        return;
      case 'interrupt':
        this.active?.abort();
        this.localActive?.abort();
        return;
      case 'answer':
        this.pendingAsk?.resolve(command.answers);
        return;
      case 'cancel-ask':
        this.pendingAsk?.resolve(null);
        return;
      case 'approval':
        this.resolveApproval(command.decision);
        return;
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
    if (line.startsWith('!')) {
      void this.runBangCommand(line).catch((error: unknown) => {
        this.app.addNotice(
          'Local command failed: ' + (error instanceof Error ? error.message : String(error)),
          'error',
        );
        this.render();
      });
      return;
    }
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
    if (line === '/permissions' || line.startsWith('/permissions ')) {
      this.handlePermissionsCommand(line);
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

  private handlePermissionsCommand(line: string): void {
    if (this.permissions === undefined) {
      this.app.addNotice('Permission switching is not available in this build.', 'warning');
      this.render();
      return;
    }
    const current = this.permissions.current();
    if (line === '/permissions') {
      if (this.active !== undefined || this.localActive !== undefined || this.changingPermission) {
        this.app.addNotice('Cannot change permissions while a command or turn is running.', 'warning');
        this.render();
        return;
      }
      const profiles = this.permissions.list();
      void this.ask([{
        id: 'permission-profile', header: 'Permissions',
        question: 'Current: ' + current.profile + ' · ' + current.approvalPolicy + '. Select a permission profile.',
        options: profiles.map((name) => ({ label: name })), multiSelect: false,
      }]).then(async (answers) => {
        const name = answers?.[0]?.selected[0];
        if (name !== undefined && profiles.includes(name) && !this.exiting
          && this.active === undefined && this.localActive === undefined && !this.changingPermission) {
          await this.applyPermissionProfile(name);
        }
      });
      return;
    }
    if (this.active !== undefined) {
      this.app.addNotice('Cannot change permissions while a turn is running.', 'warning');
      this.render();
      return;
    }
    if (this.changingPermission) return;
    const name = line.slice('/permissions '.length).trim();
    if (name.length === 0) {
      this.handlePermissionsCommand('/permissions');
      return;
    }
    void this.applyPermissionProfile(name);
  }

  private async applyPermissionProfile(name: string): Promise<void> {
    if (this.permissions === undefined) return;
    this.changingPermission = true;
    try {
      await this.permissions.set(name);
      // Grants are scoped to the permission profile that approved them. A
      // tighter profile must not inherit a previously granted write/command.
      this.grants.clear();
      const current = this.permissions.current();
      this.app.setPermission(current.profile, current.approvalPolicy);
      this.app.addNotice(
        'Permission profile updated: ' + current.profile + ' (' + current.approvalPolicy + ').' +
          (current.profile === ':danger-full-access' ? ' Full access is active.' : ''),
        current.profile === ':danger-full-access' ? 'warning' : 'info',
      );
    } catch (error) {
      this.app.addNotice(
        'Failed to update permission profile: ' + (error instanceof Error ? error.message : String(error)),
        'error',
      );
    } finally {
      this.changingPermission = false;
      this.render();
    }
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
      this.grants.clear();
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
    if (this.localActive !== undefined) {
      this.localActive.abort();
      this.app.addNotice('Interrupting local command.');
      this.render();
      return;
    }
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
    if (trimmed.startsWith('/') || trimmed.startsWith('!')) {
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
      if (this.exiting) this.finish();
      else this.drainQueue();
    }
  }

  /** Run the next queued prompt once the turn/local command has settled. */
  private drainQueue(): void {
    if (this.exiting || this.active !== undefined || this.localActive !== undefined) return;
    const queued = this.app.dequeue();
    if (queued === undefined) return;
    this.render();
    if (queued.submitted) void this.runPrompt(queued.text);
    else void this.submitProgrammatic(queued.text);
  }

  /**
   * Execute '!command' without the model. The command still goes through the
   * Shell policy, approval panel and OS sandbox supplied by the CLI; its
   * command/output are recorded as local.command / local.result so resume
   * restores the transcript without polluting model history.
   */
  private async runBangCommand(line: string): Promise<void> {
    if (this.exiting) return;
    const command = parseLocalCommand(line);
    if (command === undefined) return;
    if (command.length === 0) {
      this.app.addNotice('Usage: !<command> — the command runs locally with the Shell policy.', 'warning');
      this.render();
      return;
    }
    if (this.runLocalCommand === undefined) {
      this.app.addNotice('Local shell commands are not available in this build.', 'warning');
      this.render();
      return;
    }
    if (this.active !== undefined || this.localActive !== undefined) {
      this.app.addNotice('A turn is already running. Press Esc to interrupt it before running a local command.', 'warning');
      this.render();
      return;
    }

    if (this.app.composer.text.trim().length > 0) this.app.clearComposer(true);
    const controller = new AbortController();
    this.localActive = controller;
    const commandId = generateRequestId();
    const startedAt = Date.now();
    let outcome: LocalCommandOutcome | undefined;
    let durationMs = 0;
    let cellId: string | undefined;
    try {
      await this.session.append(localCommandStartEvent(commandId, command, this.app.state.session.cwd));
      cellId = this.app.beginLocalCommand(command);
      this.render();

      try {
        outcome = await this.runLocalCommand(command, controller.signal);
      } catch (error) {
        durationMs = Math.max(0, Date.now() - startedAt);
        outcome = {
          content: 'Local command failed: ' + (error instanceof Error ? error.message : String(error)),
          isError: true,
          exitCode: null,
          durationMs,
          timedOut: false,
          aborted: controller.signal.aborted,
          ...(controller.signal.aborted ? { code: 'ABORTED' } : {}),
        };
      }
      durationMs = Math.max(0, Number.isFinite(outcome.durationMs) ? outcome.durationMs : Date.now() - startedAt);

      await this.session.append(localCommandResultEvent(commandId, command, outcome));
      for (const event of localCommandAuditEvents(commandId, outcome, {
        profile: this.app.state.session.permissionProfile ?? 'none',
        approvalPolicy: this.app.state.session.approvalPolicy ?? 'none',
      })) {
        await this.session.append(event);
      }
    } finally {
      this.localActive = undefined;
      if (cellId !== undefined) {
        this.app.finishLocalCommand(cellId, {
          output: outcome?.content ?? 'Local command failed before producing a result.',
          isError: outcome?.isError ?? true,
          durationMs: durationMs > 0 ? durationMs : Math.max(0, Date.now() - startedAt),
          aborted: outcome?.aborted === true,
        });
      }
      this.render();
      if (this.exiting) this.finish();
      else this.drainQueue();
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
