import path from 'node:path';
import { rebuildHistory, restoreReadTracker } from '../../agent/index.js';
import type { Message, TokenUsage } from '../../providers/types.js';
import {
  type SessionHandle,
  type SessionStoreApi,
  type SessionSummary,
} from '../../session/index.js';
import { ReadFileTracker, type PlanStep } from '../../tools/index.js';
import { SessionError } from '../../util/errors.js';
import { createProcessTerminalIO, restoreTranscript, TuiApp } from '../../tui/index.js';
import type { TextSink } from '../../ui/plain.js';
import { VERSION } from '../../version.js';
import type { InteractiveCommandOptions } from './interactive.js';
import { bootstrap } from '../bootstrap.js';
import { createLoop } from '../runtime.js';
import { TuiSession } from '../tui-session.js';

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
): Promise<{ initialMessages?: readonly Message[]; plan?: readonly PlanStep[]; title?: string; turnCount?: number; usage?: TokenUsage; transcript?: ReturnType<typeof restoreTranscript> }> {
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
  await restoreReadTracker(rebuilt, app.cwd, readTracker);
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
  return {
    ...(rebuilt.messages.length > 0 ? { initialMessages: rebuilt.messages } : {}),
    ...(rebuilt.plan && rebuilt.plan.length > 0 ? { plan: rebuilt.plan } : {}),
    ...(title ? { title } : {}),
    ...(turnCount > 0 ? { turnCount } : {}),
    ...(usage ? { usage } : {}),
    ...(transcript.length > 0 ? { transcript } : {}),
  };
}

/** Full-screen interactive mode. Falls back to the line UI only via the caller. */
export async function runTuiInteractive(options: InteractiveCommandOptions): Promise<number> {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  const app = await bootstrap({
    cwd: options.cwd,
    env,
    cli: {
      ...(options.route ? { route: options.route } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
    },
  });
  for (const warning of app.warnings) stderr.write('warning: ' + warning + '\n');

  let session: SessionHandle | undefined;
  try {
    const opened = await openSession(app, options);
    session = opened.session;
    const readTracker = new ReadFileTracker();
    const resumed = opened.resumed
      ? await replayResumed(app, session, readTracker, stderr)
      : {};

    const tuiApp = new TuiApp({
      session: {
        sessionId: session.id,
        cwd: app.cwd,
        model: app.router.selection.model,
        ...(env.HOME ? { home: env.HOME } : {}),
        ...(resumed.title ? { title: resumed.title } : {}),
        ...(resumed.turnCount ? { initialTurnNumber: resumed.turnCount } : {}),
        ...(resumed.usage ? { initialUsage: resumed.usage } : {}),
        ...(resumed.transcript ? { initialTranscript: resumed.transcript } : {}),
      },
      version: VERSION,
      width: process.stdout.columns ?? 80,
      height: process.stdout.rows ?? 24,
    });

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
      },
    );
    tuiApp.handleEvent({
      type: 'session.info',
      session: { sessionId: session.id, cwd: app.cwd, model: app.router.selection.model },
    });

    controller = new TuiSession({
      app: tuiApp,
      io: createProcessTerminalIO(),
      session,
      runTurn: (text, signal) => loop.runTurn(text, { signal }),
      ...(options.initialPrompt ? { initialPrompt: options.initialPrompt } : {}),
    });
    return await controller.run();
  } finally {
    if (session) await session.close();
    await app.store.close?.();
  }
}