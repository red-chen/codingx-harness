import path from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import {
  latestModelSelection,
  rebuildHistory,
  restoreReadTracker,
  type TurnResult,
} from '../../agent/index.js';
import type { Message, ReasoningEffort } from '../../providers/types.js';
import {
  type SessionHandle,
  type SessionStoreApi,
  type SessionSummary,
} from '../../session/index.js';
import { ReadFileTracker, type PlanStep } from '../../tools/index.js';
import { SessionError } from '../../util/errors.js';
import { PlainRenderer, type TextSink } from '../../ui/plain.js';
import { VERSION } from '../../version.js';
import { bootstrap, type CliApp } from '../bootstrap.js';
import { describeModelSelection, parseModelCommand } from '../model-command.js';
import { createLoop } from '../runtime.js';
import { runTuiInteractive } from './tui.js';

export interface InteractiveCommandOptions {
  cwd: string;
  /** Extra writable directories alongside cwd (from --add-dir). */
  addDirs?: readonly string[];
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
      cli: {
        ...(options.route ? { route: options.route } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
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

    const loop = createLoop(app, session, (event) => renderer.render(event), {
      readTracker,
      ...(initialMessages ? { initialMessages } : {}),
      ...(rebuiltPlan ? { initialPlan: rebuiltPlan } : {}),
      ...(resumedEffort ? { reasoningEffort: resumedEffort } : {}),
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

    if (options.initialPrompt && options.initialPrompt.trim().length > 0) {
      await runLine(options.initialPrompt);
    }

    for (;;) {
      if (exitRequested) break;
      prompt();
      const raw = await nextLine();
      if (raw === null || exitRequested) break;
      const line = raw.trim();
      if (line.length === 0) continue;
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
    if (session) await session.close();
    if (app) await app.store.close?.();
  }
}