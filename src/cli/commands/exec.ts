import type { TurnResult } from '../../agent/index.js';
import type { ConfigOverrides } from '../../config/index.js';
import { ConfigError } from '../../util/errors.js';
import { PlainRenderer, type TextSink } from '../../ui/plain.js';
import { VERSION } from '../../version.js';
import { hookWarnings } from '../../hooks/index.js';
import { bootstrap } from '../bootstrap.js';
import { createLoop, initializeReasoningEffort } from '../runtime.js';

export interface ExecCommandOptions {
  prompt: string;
  cwd: string;
  /** Extra writable directories alongside cwd. */
  addDirs?: readonly string[];
  /** Bypass all application-level permission checks (--yolo). */
  yolo?: boolean;
  /** Permission/config overrides from CLI flags. */
  cli?: ConfigOverrides;
  json?: boolean;
  route?: string;
  model?: string;
  provider?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: TextSink;
  stderr?: TextSink;
}

function usageLine(usage: TurnResult['usage']): string {
  const cache = usage.cacheReadTokens > 0 ? ', cache read ' + usage.cacheReadTokens : '';
  return '[tokens: in ' + usage.inputTokens + ', out ' + usage.outputTokens + cache + ']\n';
}

/**
 * codingx exec: one turn, then session.end. Always exits with a deterministic
 * code: 0 done, 1 failed turn, 130 interrupted.
 */
export async function runExec(options: ExecCommandOptions): Promise<number> {
  if (options.prompt.trim().length === 0) throw new ConfigError('Prompt must not be empty.');
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const json = options.json ?? false;

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

  const renderer = new PlainRenderer({ stdout, stderr, json, finalOnly: true, version: VERSION });
  const session = await app.store.createSession({
    cwd: app.cwd,
    model: app.router.selection.model,
    provider: app.router.selection.providerId,
    cliVersion: app.cliVersion,
  });

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);

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

  let activeLoop: ReturnType<typeof createLoop> | undefined;
  let result: TurnResult | undefined;
  try {
    await initializeReasoningEffort(app, session);
    renderer.render({
      type: 'session.info',
      session: { sessionId: session.id, cwd: app.cwd, model: app.router.selection.model },
    });

    const loop = activeLoop = createLoop(app, session, (event) => renderer.render(event));
    result = await loop.runTurn(options.prompt, { signal: controller.signal });
  } finally {
    process.removeListener('SIGINT', onSigint);
    try { await activeLoop?.processes.close(); } catch (error) {
      stderr.write('warning: process cleanup: ' + (error instanceof Error ? error.message : String(error)) + '\n');
    }
    try {
      const endHooks = await app.hooks.run(
        'session_end',
        { sessionId: session.id, cwd: app.cwd, ...(result === undefined ? {} : { stopStatus: result.status }) },
        { session },
      );
      for (const warning of hookWarnings(endHooks)) stderr.write('warning: ' + warning + '\n');
    } catch {
      // Hook failures must not prevent the session from closing.
    }
    try {
      await session.end(result?.status ?? 'error');
    } catch {
      // The rollout may have failed; close() below still releases the lock.
    }
    await session.close();
    await app.store.close?.();
  }

  if (!result) throw new Error('Turn did not produce a result.');

  if (json) {
    if (result.status === 'error') {
      stderr.write('codingx: ' + (result.error?.message ?? 'turn failed') + '\n');
    }
    stderr.write(usageLine(result.usage));
  }

  if (result.status === 'done') return 0;
  if (result.status === 'aborted') return 130;
  return 1;
}
