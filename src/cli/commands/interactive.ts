import path from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import {
  latestModelSelection,
  rebuildHistory,
  restoreReadTracker,
  type TurnResult,
} from '../../agent/index.js';
import type { ConfigOverrides } from '../../config/index.js';
import { SessionGrants, approvalPrefixFor } from '../../policy/index.js';
import type { ApprovalDecision, ApprovalRequest } from '../../policy/types.js';
import type { Message, ReasoningEffort } from '../../providers/types.js';
import {
  type SessionHandle,
  type SessionStoreApi,
  type SessionSummary,
} from '../../session/index.js';
import { ReadFileTracker, type PlanStep } from '../../tools/index.js';
import { abortError, SessionError } from '../../util/errors.js';
import { generateRequestId } from '../../util/ids.js';
import { PlainRenderer, type TextSink } from '../../ui/plain.js';
import { VERSION } from '../../version.js';
import { hookWarnings } from '../../hooks/index.js';
import { bootstrap, type CliApp } from '../bootstrap.js';
import {
  localCommandAuditEvents,
  localCommandResultEvent,
  localCommandStartEvent,
  parseLocalCommand,
  runLocalCommand,
  type LocalCommandOutcome,
} from '../local-command.js';
import { describeModelSelection, parseModelCommand } from '../model-command.js';
import { createLoop, DEFAULT_SHELL_TIMEOUT_MS } from '../runtime.js';
import { runTuiInteractive } from './tui.js';

export interface InteractiveCommandOptions {
  cwd: string;
  /** Extra writable directories alongside cwd (from --add-dir). */
  addDirs?: readonly string[];
  /** Bypass all application-level permission checks (--yolo). */
  yolo?: boolean;
  /** Permission/config overrides from CLI flags. */
  cli?: ConfigOverrides;
  initialPrompt?: string;
  json?: boolean;
  route?: string;
  model?: string;
  provider?: string;
  /** Continue the most recent idle/interrupted session for this cwd. */
  continueSession?: boolean;
  /** Resume a specific session by id or unique prefix. */
  resumeSessionId?: string;
  /** Fork a session and continue in the new session. */
  forkSessionId?: string;
  /** Force full-screen TUI; otherwise auto-detect a TTY. */
  tui?: boolean;
  /** Force the line-oriented renderer. */
  plain?: boolean;
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadableStream;
  stdout?: TextSink;
  stderr?: TextSink;
}

async function findLatestResumable(
  store: SessionStoreApi,
  cwd: string,
): Promise<SessionSummary | undefined> {
  const resolved = path.resolve(cwd);
  const sessions = await store.listSessions();
  return sessions.find(
    (session) =>
      (session.status === 'idle' || session.status === 'interrupted') &&
      path.resolve(session.cwd) === resolved,
  );
}

const EXIT_COMMANDS = new Set(['/quit', '/exit']);
const DOUBLE_SIGINT_MS = 1_500;

/**
 * Line-oriented interactive mode. The TUI replaces this later in M2; sessions
 * stay open (no session.end) so the rollout remains available for replay.
 *
 * Input is consumed by a readline instance started before bootstrap and queued
 * as lines. This keeps piped/EOF timing deterministic without dropping input.
 */
export async function runInteractive(options: InteractiveCommandOptions): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const json = options.json ?? false;
  const modeCount = [options.continueSession, options.resumeSessionId, options.forkSessionId].filter(Boolean).length;
  if (modeCount > 1) {
    throw new SessionError('Use only one of --continue, --resume or --fork.');
  }

  const input = options.stdin ?? process.stdin;
  const stdinIsTTY = Boolean((input as { isTTY?: boolean }).isTTY);
  const stdoutIsTTY = Boolean((stdout as { isTTY?: boolean }).isTTY);
  const useTui = options.tui === true || (!options.plain && !json && stdinIsTTY && stdoutIsTTY);
  if (useTui) {
    if (json) throw new SessionError('--json cannot be combined with the TUI.');
    if (!stdinIsTTY || !stdoutIsTTY) {
      throw new SessionError('The TUI requires a TTY; use --plain for redirected input/output.');
    }
    return runTuiInteractive(options);
  }

  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = createInterface({ input, output: sink, terminal: false, crlfDelay: Infinity });

  const lineQueue: string[] = [];
  let inputClosed = false;
  let lineWaiter: (() => void) | undefined;
  const wake = (): void => {
    const waiter = lineWaiter;
    lineWaiter = undefined;
    waiter?.();
  };
  rl.on('line', (line) => {
    lineQueue.push(line);
    wake();
  });
  rl.on('close', () => {
    inputClosed = true;
    wake();
  });

  const nextLine = async (): Promise<string | null> => {
    for (;;) {
      const queued = lineQueue.shift();
      if (queued !== undefined) return queued;
      if (inputClosed) return null;
      await new Promise<void>((resolve) => {
        lineWaiter = resolve;
      });
    }
  };

  let app: CliApp | undefined;
  let session: SessionHandle | undefined;
  let activeController: AbortController | undefined;
  let lastSigint = 0;
  let exitRequested = false;
  const commandOut = json ? stderr : stdout;

  const prompt = (): void => {
    if (exitRequested) return;
    if (json) stderr.write('› ');
    else stdout.write('› ');
  };

  const onSigint = (): void => {
    if (activeController) {
      activeController.abort();
      return;
    }
    const now = Date.now();
    if (now - lastSigint < DOUBLE_SIGINT_MS) {
      exitRequested = true;
      rl.close();
      return;
    }
    lastSigint = now;
    stderr.write('\nPress Ctrl+C again to exit.\n');
  };
  process.on('SIGINT', onSigint);

  try {
    app = await bootstrap({
      cwd: options.cwd,
      env,
      ...(options.addDirs && options.addDirs.length > 0 ? { addDirs: options.addDirs } : {}),
      ...(options.yolo ? { yolo: true } : {}),
      cli: {
        ...(options.route ? { route: options.route } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.cli ?? {}),
      },
    });
    for (const warning of app.warnings) stderr.write('warning: ' + warning + '\n');

    const renderer = new PlainRenderer({ stdout, stderr, json, showBanner: true, version: VERSION });
    let resumed = false;

    if (options.forkSessionId) {
      session = await app.store.forkSession(options.forkSessionId, {
        cwd: app.cwd,
        model: app.router.selection.model,
        provider: app.router.selection.providerId,
        cliVersion: app.cliVersion,
      });
      resumed = true;
    } else if (options.resumeSessionId) {
      session = await app.store.attachSession(options.resumeSessionId, 'write');
      resumed = true;
    } else if (options.continueSession) {
      const target = await findLatestResumable(app.store, app.cwd);
      if (!target) {
        throw new SessionError(
          'No idle or interrupted session found for ' + app.cwd + '. Start a new session, or use --fork <id>.',
        );
      }
      session = await app.store.attachSession(target.id, 'write');
      resumed = true;
    } else {
      session = await app.store.createSession({
        cwd: app.cwd,
        model: app.router.selection.model,
        provider: app.router.selection.providerId,
        cliVersion: app.cliVersion,
      });
    }

    if (!session) throw new SessionError('Failed to open a session.');
    if (!app) throw new SessionError('Failed to initialize the CLI.');

    const currentSession = session;
    const currentApp = app;
    const readTracker = new ReadFileTracker();
    let initialMessages: readonly Message[] | undefined;
    let rebuiltPlan: readonly PlanStep[] | undefined;
    let resumedModel: string | undefined;
    let resumedEffort: ReasoningEffort | undefined;
    if (resumed) {
      const events = await session.replay();
      const rebuilt = rebuildHistory(events);
      if (rebuilt.syntheticResults.length > 0) {
        await session.append(
          rebuilt.syntheticResults.map((synthetic) => ({
            type: 'tool.result',
            turnId: synthetic.turnId,
            callId: synthetic.callId,
            name: synthetic.name,
            content: synthetic.content,
            isError: true,
            synthetic: true,
          })),
        );
        stderr.write(
          'warning: repaired ' +
            rebuilt.syntheticResults.length +
            ' dangling tool call(s) with synthetic tool_result events.\n',
        );
      }
      await restoreReadTracker(rebuilt, app.cwd, readTracker, app.additionalDirs);
      const modelSelection = latestModelSelection(events);
      resumedModel = modelSelection.model;
      resumedEffort = modelSelection.reasoningEffort;
      initialMessages = rebuilt.messages;
      rebuiltPlan = rebuilt.plan;
      stderr.write(
        'resumed session ' + session.id + ' (' + rebuilt.messages.length + ' message(s), cwd ' + session.meta.cwd + ')\n',
      );
      if (path.resolve(session.meta.cwd) !== path.resolve(app.cwd)) {
        stderr.write(
          'warning: session cwd differs from the current workspace; relative paths in history may not resolve.\n',
        );
      }
    }
    if (resumedModel && !options.model) app.router.setModel(resumedModel);

    const startHooks = await app.hooks.run(
      'session_start',
      { sessionId: session.id, cwd: app.cwd },
      { session },
    );
    for (const warning of hookWarnings(startHooks)) stderr.write('warning: ' + warning + '\n');
    if (startHooks.context.trim().length > 0) {
      app.sessionHookContext = startHooks.context.trim();
      app.systemPrompt += '\n\n# Hook context (session_start)\n' + startHooks.context.trim();
    }

    const grants = new SessionGrants(currentApp.cwd);
    const readApprovalLine = (signal: AbortSignal | undefined): Promise<string | null> => {
      if (signal?.aborted === true) return Promise.reject(abortError('Approval cancelled.'));
      return new Promise<string | null>((resolve, reject) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = (): void => {
          finish();
          reject(abortError('Approval cancelled.'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        void nextLine().then(
          (value) => {
            finish();
            resolve(value);
          },
          (error) => {
            finish();
            reject(error);
          },
        );
      });
    };
    const approve = async (
      request: ApprovalRequest,
      signal?: AbortSignal,
    ): Promise<ApprovalDecision> => {
      if (grants.permits(request.action)) return { decision: 'allow', scope: 'once' };
      const requestId = generateRequestId();
      const target =
        request.action.command ?? request.action.path ?? request.action.tool;
      await currentSession.append({
        type: 'approval.requested',
        requestId,
        ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
        ...(request.callId === undefined ? {} : { callId: request.callId }),
        tool: request.tool,
        action: request.action,
        risk: request.risk,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      });
      stderr.write(
        '\n[approval] ' + request.tool + ': ' + target + '\n' +
          '  risk: ' + request.risk + '\n' +
          (request.reason === undefined ? '' : '  reason: ' + request.reason + '\n') +
          '  [a]llow once  [s]ession  [p]refix  [d]eny  [r]eason > ',
      );
      let raw: string | null;
      try {
        raw = await readApprovalLine(signal);
      } catch (error) {
        await currentSession.append({
          type: 'approval.decided',
          requestId,
          decision: 'deny',
          reason: 'aborted',
          decidedBy: 'user',
        });
        throw error;
      }
      let decision: ApprovalDecision = { decision: 'deny' };
      const choice = raw?.trim().toLowerCase() ?? '';
      const canPrefix =
        request.action.kind === 'exec' &&
        approvalPrefixFor(request.action, request.action.cwd ?? currentApp.cwd) !== undefined;
      if (choice === 'a' || choice === 'y' || choice === 'yes') {
        decision = { decision: 'allow', scope: 'once' };
      } else if (choice === 's') {
        decision = { decision: 'allow', scope: 'session' };
      } else if (choice === 'p' && canPrefix) {
        decision = { decision: 'allow', scope: 'prefix' };
      } else if (choice === 'r') {
        stderr.write('  reason > ');
        try {
          const reasonLine = await readApprovalLine(signal);
          decision = { decision: 'deny', reason: reasonLine?.trim() || 'denied by user' };
        } catch (error) {
          await currentSession.append({
            type: 'approval.decided',
            requestId,
            decision: 'deny',
            reason: 'aborted',
            decidedBy: 'user',
          });
          throw error;
        }
      }
      if (decision.decision === 'allow' && decision.scope !== 'once') {
        grants.grant(request.action, decision.scope);
      }
      await currentSession.append({
        type: 'approval.decided',
        requestId,
        ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
        ...(request.callId === undefined ? {} : { callId: request.callId }),
        decision: decision.decision,
        ...(decision.decision === 'allow' ? { scope: decision.scope } : {}),
        ...(decision.decision === 'deny' && decision.reason !== undefined ? { reason: decision.reason } : {}),
        decidedBy: 'user',
      });
      if (decision.decision === 'allow' && decision.scope !== 'once') {
        await currentSession.append({
          type: 'permission.granted',
          requestId,
          scope: decision.scope,
          action: request.action,
        });
      }
      return decision;
    };

    const loop = createLoop(app, session, (event) => renderer.render(event), {
      readTracker,
      ...(initialMessages ? { initialMessages } : {}),
      ...(rebuiltPlan ? { initialPlan: rebuiltPlan } : {}),
      ...(resumedEffort ? { reasoningEffort: resumedEffort } : {}),
      ...(json ? {} : { approve }),
    });
    renderer.render({
      type: 'session.info',
      session: { sessionId: session.id, cwd: app.cwd, model: app.router.selection.model },
    });

    const runLine = async (line: string): Promise<TurnResult> => {
      const controller = new AbortController();
      activeController = controller;
      try {
        return await loop.runTurn(line, { signal: controller.signal });
      } finally {
        activeController = undefined;
      }
    };

    const runLocal = async (line: string): Promise<void> => {
      const command = parseLocalCommand(line);
      if (command === undefined) return;
      if (command.length === 0) {
        commandOut.write('Usage: !<command>. The command runs locally with the Shell policy.\n');
        return;
      }
      if (json) {
        stderr.write('Local shell commands are not available with --json.\n');
        return;
      }
      const controller = new AbortController();
      activeController = controller;
      const commandId = generateRequestId();
      const startedAt = Date.now();
      await currentSession.append(localCommandStartEvent(commandId, command, currentApp.cwd));
      commandOut.write('! ' + command + '\n');
      let outcome: LocalCommandOutcome;
      try {
        outcome = await runLocalCommand({
          command,
          cwd: currentApp.cwd,
          env: currentApp.shellEnv,
          timeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
          maxOutputChars: currentApp.config.tools.maxOutputChars,
          policy: currentApp.policy,
          sandbox: currentApp.sandbox,
          approve,
          signal: controller.signal,
        });
      } catch (error) {
        outcome = {
          content: 'Local command failed: ' + (error instanceof Error ? error.message : String(error)),
          isError: true,
          exitCode: null,
          durationMs: Math.max(0, Date.now() - startedAt),
          timedOut: false,
          aborted: controller.signal.aborted,
          ...(controller.signal.aborted ? { code: 'ABORTED' } : {}),
        };
      } finally {
        activeController = undefined;
      }
      commandOut.write(outcome.content + '\n');
      await currentSession.append(localCommandResultEvent(commandId, command, outcome));
      for (const event of localCommandAuditEvents(commandId, outcome, {
        profile: currentApp.policy.profileName,
        approvalPolicy: currentApp.policy.approvalPolicy,
      })) {
        await currentSession.append(event);
      }
    };

    if (options.initialPrompt && options.initialPrompt.trim().length > 0) {
      const initial = options.initialPrompt.trim();
      if (initial.startsWith('!')) await runLocal(initial);
      else await runLine(options.initialPrompt);
    }

    for (;;) {
      if (exitRequested) break;
      prompt();
      const raw = await nextLine();
      if (raw === null || exitRequested) break;
      const line = raw.trim();
      if (line.length === 0) continue;
      if (line.startsWith('!')) {
        await runLocal(line);
        continue;
      }
      if (EXIT_COMMANDS.has(line)) break;
      if (line === '/help') {
        commandOut.write(
          'Commands: /help, /session, /model, /clear, /quit. Ctrl+C interrupts a running turn; press it twice to exit.\n',
        );
        continue;
      }
      if (line === '/session') {
        commandOut.write('session: ' + session.id + '\nfile: ' + session.filePath + '\n');
        continue;
      }
      if (line === '/model' || line.startsWith('/model ')) {
        const current = {
          model: app.router.selection.model,
          ...(loop.reasoningEffort ? { reasoningEffort: loop.reasoningEffort } : {}),
        };
        const command = parseModelCommand(line, current);
        if (command.type === 'show') {
          commandOut.write(describeModelSelection(current) + '\n');
          continue;
        }
        if (command.type === 'error') {
          commandOut.write(command.message + '\n');
          continue;
        }
        try {
          await session.append({
            type: 'model.changed',
            model: command.selection.model,
            ...(command.selection.reasoningEffort
              ? { reasoningEffort: command.selection.reasoningEffort }
              : {}),
          });
          app.router.setModel(command.selection.model);
          loop.setModel(command.selection.model);
          loop.setReasoningEffort(command.selection.reasoningEffort);
          commandOut.write(describeModelSelection(command.selection) + '\n');
        } catch (error) {
          commandOut.write(
            'Failed to update model: ' + (error instanceof Error ? error.message : String(error)) + '\n',
          );
        }
        continue;
      }
      if (line === '/clear') {
        try {
          await session.clear();
          grants.clear();
          loop.clearHistory();
          commandOut.write('Session cleared: conversation and rollout history were reset.\n');
        } catch (error) {
          commandOut.write(
            'Failed to clear session: ' + (error instanceof Error ? error.message : String(error)) + '\n',
          );
        }
        continue;
      }
      if (line.startsWith('/')) {
        commandOut.write('Unknown command: ' + line + '. Use /help.\n');
        continue;
      }

      const result = await runLine(line);
      if (result.status === 'error' && json) {
        stderr.write('codingx: ' + (result.error?.message ?? 'turn failed') + '\n');
      }
    }
    return 0;
  } finally {
    process.removeListener('SIGINT', onSigint);
    rl.close();
    if (session && app) {
      try {
        const endHooks = await app.hooks.run(
          'session_end',
          { sessionId: session.id, cwd: app.cwd },
          { session },
        );
        for (const warning of hookWarnings(endHooks)) stderr.write('warning: ' + warning + '\n');
      } catch {
        // Session hooks must not prevent close/lease release.
      }
    }
    if (session) await session.close();
    if (app) await app.store.close?.();
  }
}