import path from 'node:path';
import { buildSystemPrompt, latestModelSelection, rebuildHistory, restoreReadTracker } from '../../agent/index.js';
import { DEFAULT_CONTEXT_WINDOW, type Message, type ReasoningEffort, type TokenUsage } from '../../providers/types.js';
import {
  type SessionHandle,
  type SessionStoreApi,
  type SessionSummary,
} from '../../session/index.js';
import { createPolicyRuntime } from '../../policy/index.js';
import { sandboxSummary } from '../../sandbox/index.js';
import { hookWarnings } from '../../hooks/index.js';
import { ReadFileTracker, type PlanStep } from '../../tools/index.js';
import { SessionError } from '../../util/errors.js';
import { isPathInside } from '../../util/paths.js';
import { createProcessTerminalIO, restoreTranscript, TuiApp, type TranscriptCell } from '../../tui/index.js';
import type { TextSink } from '../../ui/plain.js';
import { VERSION } from '../../version.js';
import type { InteractiveCommandOptions } from './interactive.js';
import { bootstrap } from '../bootstrap.js';
import { runLocalCommand } from '../local-command.js';
import { createLoop, DEFAULT_SHELL_TIMEOUT_MS } from '../runtime.js';
import { TuiSession, type TuiPermissionController } from '../tui-session.js';

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

async function openSession(
  app: Awaited<ReturnType<typeof bootstrap>>,
  options: InteractiveCommandOptions,
): Promise<{ session: SessionHandle; resumed: boolean }> {
  if (options.forkSessionId) {
    const session = await app.store.forkSession(options.forkSessionId, {
      cwd: app.cwd,
      model: app.router.selection.model,
      provider: app.router.selection.providerId,
      cliVersion: app.cliVersion,
    });
    return { session, resumed: true };
  }
  if (options.resumeSessionId) {
    return { session: await app.store.attachSession(options.resumeSessionId, 'write'), resumed: true };
  }
  if (options.continueSession) {
    const target = await findLatestResumable(app.store, app.cwd);
    if (!target) {
      throw new SessionError(
        'No idle or interrupted session found for ' + app.cwd + '. Start a new session, or use --fork <id>.',
      );
    }
    return { session: await app.store.attachSession(target.id, 'write'), resumed: true };
  }
  return {
    session: await app.store.createSession({
      cwd: app.cwd,
      model: app.router.selection.model,
      provider: app.router.selection.providerId,
      cliVersion: app.cliVersion,
    }),
    resumed: false,
  };
}

function totalUsageFrom(events: readonly { type: string; usage?: unknown }[]): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const event of events) {
    if (event.type !== 'turn.end' || typeof event.usage !== 'object' || event.usage === null) continue;
    const usage = event.usage as Record<string, unknown>;
    const add = (key: keyof TokenUsage): number => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
    const next: TokenUsage = {
      inputTokens: (total?.inputTokens ?? 0) + add('inputTokens'),
      outputTokens: (total?.outputTokens ?? 0) + add('outputTokens'),
      cacheReadTokens: (total?.cacheReadTokens ?? 0) + add('cacheReadTokens'),
      cacheCreationTokens: (total?.cacheCreationTokens ?? 0) + add('cacheCreationTokens'),
    };
    total = next;
  }
  return total;
}

function deriveSessionTitle(events: readonly { type: string; text?: unknown }[]): string | undefined {
  const first = events.find(
    (event) => event.type === 'user.message' && typeof event.text === 'string' && event.text.trim().length > 0,
  );
  if (!first || typeof first.text !== 'string') return undefined;
  const single = first.text.replace(/\s+/gu, ' ').trim();
  return single.length <= 60 ? single : single.slice(0, 59) + '…';
}

async function replayResumed(
  app: Awaited<ReturnType<typeof bootstrap>>,
  session: SessionHandle,
  readTracker: ReadFileTracker,
  stderr: TextSink,
): Promise<{
  initialMessages?: readonly Message[];
  plan?: readonly PlanStep[];
  title?: string;
  turnCount?: number;
  usage?: TokenUsage;
  transcript?: ReturnType<typeof restoreTranscript>;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}> {
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
      'warning: repaired ' + rebuilt.syntheticResults.length + ' dangling tool call(s) with synthetic tool_result events.\n',
    );
  }
  await restoreReadTracker(rebuilt, app.cwd, readTracker, app.additionalDirs);
  stderr.write(
    'resumed session ' + session.id + ' (' + rebuilt.messages.length + ' message(s), cwd ' + session.meta.cwd + ')\n',
  );
  if (path.resolve(session.meta.cwd) !== path.resolve(app.cwd)) {
    stderr.write(
      'warning: session cwd differs from the current workspace; relative paths in history may not resolve.\n',
    );
  }
  const title = deriveSessionTitle(events);
  const turnCount = events.filter((event) => event.type === 'turn.start').length;
  const usage = totalUsageFrom(events);
  const transcript = restoreTranscript(events);
  const modelSelection = latestModelSelection(events);
  return {
    ...(rebuilt.messages.length > 0 ? { initialMessages: rebuilt.messages } : {}),
    ...(rebuilt.plan && rebuilt.plan.length > 0 ? { plan: rebuilt.plan } : {}),
    ...(title ? { title } : {}),
    ...(turnCount > 0 ? { turnCount } : {}),
    ...(usage ? { usage } : {}),
    ...(transcript.length > 0 ? { transcript } : {}),
    ...(modelSelection.model ? { model: modelSelection.model } : {}),
    ...(modelSelection.reasoningEffort ? { reasoningEffort: modelSelection.reasoningEffort } : {}),
  };
}

/** Full-screen interactive mode. Falls back to the line UI only via the caller. */
export interface TuiResumeView {
  readonly title?: string;
  readonly turnCount?: number;
  readonly usage?: TokenUsage;
  readonly transcript?: readonly TranscriptCell[];
  readonly reasoningEffort?: ReasoningEffort;
}

export interface CreateTuiAppOptions {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly home?: string;
  readonly permissionProfile: string;
  readonly approvalPolicy: string;
  readonly contextWindow: number;
  readonly version: string;
  readonly width: number;
  readonly height: number;
  readonly resumed: TuiResumeView;
}

/** Build the TUI state with resumed transcript/counters in their correct slots. */
export function createTuiAppForSession(options: CreateTuiAppOptions): TuiApp {
  const resumed = options.resumed;
  return new TuiApp({
    session: {
      sessionId: options.sessionId,
      cwd: options.cwd,
      model: options.model,
      ...(resumed.reasoningEffort ? { reasoningEffort: resumed.reasoningEffort } : {}),
      ...(options.home ? { home: options.home } : {}),
      ...(resumed.title ? { title: resumed.title } : {}),
      permissionProfile: options.permissionProfile,
      approvalPolicy: options.approvalPolicy,
    },
    version: options.version,
    width: options.width,
    height: options.height,
    contextWindowTokens: options.contextWindow,
    ...(resumed.turnCount ? { initialTurnNumber: resumed.turnCount } : {}),
    ...(resumed.usage ? { initialUsage: resumed.usage } : {}),
    ...(resumed.transcript ? { initialTranscript: resumed.transcript } : {}),
  });
}

export async function runTuiInteractive(options: InteractiveCommandOptions): Promise<number> {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  const app = await bootstrap({
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

  let session: SessionHandle | undefined;
  try {
    const opened = await openSession(app, options);
    session = opened.session;
    const activeSession = opened.session;
    const readTracker = new ReadFileTracker();
    const resumed = opened.resumed
      ? await replayResumed(app, session, readTracker, stderr)
      : {};
    if (resumed.model && !options.model) app.router.setModel(resumed.model);

    const startHooks = await app.hooks.run(
      'session_start',
      { sessionId: session.id, cwd: app.cwd },
      { session },
    );
    if (startHooks.context.trim().length > 0) {
      app.sessionHookContext = startHooks.context.trim();
      app.systemPrompt += '\n\n# Hook context (session_start)\n' + startHooks.context.trim();
    }

    const tuiApp = createTuiAppForSession({
      sessionId: session.id,
      cwd: app.cwd,
      model: app.router.selection.model,
      ...(env.HOME ? { home: env.HOME } : {}),
      permissionProfile: app.policy.profileName,
      approvalPolicy: app.policy.approvalPolicy,
      contextWindow: app.config.model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      version: VERSION,
      width: process.stdout.columns ?? 80,
      height: process.stdout.rows ?? 24,
      resumed,
    });
    for (const warning of hookWarnings(startHooks)) tuiApp.addNotice(warning, 'warning');

    let controller: TuiSession | undefined;
    const loop = createLoop(
      app,
      session,
      (event) => {
        tuiApp.handleEvent(event);
        controller?.render();
      },
      {
        readTracker,
        ...(resumed.initialMessages ? { initialMessages: resumed.initialMessages } : {}),
        ...(resumed.plan ? { initialPlan: resumed.plan } : {}),
        ...(resumed.reasoningEffort ? { reasoningEffort: resumed.reasoningEffort } : {}),
        ask: (questions, signal) =>
          controller === undefined ? Promise.resolve(null) : controller.ask(questions, signal),
        approve: (request, signal) =>
          controller === undefined
            ? Promise.resolve({ decision: 'deny', reason: 'The approval UI is not ready.' })
            : controller.approve(request, signal),
      },
    );
    tuiApp.handleEvent({
      type: 'session.info',
      session: { sessionId: session.id, cwd: app.cwd, model: app.router.selection.model },
    });
    if (app.yolo) {
      tuiApp.addNotice(
        'Full access is active (:danger-full-access + never). File tools are unrestricted and the OS sandbox is disabled.',
        'warning',
      );
    }

    const profiles = Object.keys(app.config.permissions.profiles).sort();
    const permissions: TuiPermissionController = {
      list: () => profiles,
      current: () => ({ profile: app.policy.profileName, approvalPolicy: app.policy.approvalPolicy }),
      set: async (name) => {
        if (!profiles.includes(name)) throw new Error('Unknown permission profile: ' + name);
        const policy = await createPolicyRuntime({
          cwd: app.cwd,
          additionalDirs: app.additionalDirs,
          env,
          config: { ...app.config.permissions, defaultProfile: name },
          approvalPolicy: app.config.approvalPolicy,
          reviewer: app.config.approvalsReviewer,
          alwaysAsk: app.config.approval.alwaysAsk,
          sessionDir: app.config.session.dir,
        });
        if (!policy.yolo && app.additionalDirs.length > 0) {
          const disallowed = app.additionalDirs.find(
            (directory) => !policy.writeRoots.some((root) => isPathInside(root, directory)),
          );
          if (disallowed !== undefined) {
            throw new Error(
              'Permission profile "' + name + '" does not allow the existing --add-dir root ' + disallowed + '.',
            );
          }
        }
        const previous = app.policy.profileName;
        app.policy = policy;
        app.yolo = policy.yolo;
        app.config.permissions = { ...app.config.permissions, defaultProfile: name };
        await activeSession.append({
          type: 'profile.changed',
          from: previous,
          to: name,
          source: 'tui',
        });
        loop.setPolicy(policy);
        const prompt = buildSystemPrompt(app.snapshot, {
          skills: app.skills.summaries(),
          ...(app.additionalDirs.length > 0 ? { additionalDirs: app.additionalDirs } : {}),
          permissionProfile: policy.profileName,
          approvalPolicy: policy.approvalPolicy,
          sandbox: sandboxSummary(app.sandbox.status, policy.sandboxPolicy),
          ...(policy.yolo ? { yolo: true } : {}),
        });
        const withHookContext = app.sessionHookContext
          ? prompt + '\n\n# Hook context (session_start)\n' + app.sessionHookContext
          : prompt;
        app.systemPrompt = withHookContext;
        loop.setSystemPrompt(withHookContext);
      },
    };

    controller = new TuiSession({
      app: tuiApp,
      io: createProcessTerminalIO(),
      session,
      runTurn: (text, signal) => loop.runTurn(text, { signal }),
      runLocalCommand: (command, signal) =>
        runLocalCommand({
          command,
          cwd: app.cwd,
          env: app.shellEnv,
          timeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
          maxOutputChars: app.config.tools.maxOutputChars,
          policy: app.policy,
          sandbox: app.sandbox,
          signal,
          approve: (request, approvalSignal) =>
            controller === undefined
              ? Promise.resolve({ decision: 'deny', reason: 'The approval UI is not ready.' })
              : controller.approve(request, approvalSignal),
        }),
      permissions,
      model: {
        get: () => ({
          model: app.router.selection.model,
          ...(loop.reasoningEffort ? { reasoningEffort: loop.reasoningEffort } : {}),
        }),
        set: async (selection) => {
          await activeSession.append({
            type: 'model.changed',
            model: selection.model,
            ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
          });
          app.router.setModel(selection.model);
          loop.setModel(selection.model);
          loop.setReasoningEffort(selection.reasoningEffort);
        },
      },
      onClear: () => loop.clearHistory(),
      ...(options.initialPrompt ? { initialPrompt: options.initialPrompt } : {}),
    });
    return await controller.run();
  } finally {
    if (session) {
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
      await session.close();
    }
    await app.store.close?.();
  }
}
