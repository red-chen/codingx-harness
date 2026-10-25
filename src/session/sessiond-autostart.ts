import { spawn } from 'node:child_process';
import { SessionError } from '../util/errors.js';
import { SessiondClient } from './sessiond-client.js';

export interface EnsureSessiondOptions {
  socketPath: string;
  sessionDir: string;
  idleTimeoutSeconds: number;
  autostart: boolean;
  cliVersion?: string;
  env?: NodeJS.ProcessEnv;
  /** Injection point for tests; defaults to the real detached process. */
  spawnDaemon?: () => void;
}

export interface EnsuredSessiond {
  client: SessiondClient;
  started: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSessiond(socketPath: string, timeoutMs: number): Promise<SessiondClient> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  for (;;) {
    try {
      return await SessiondClient.connect({ socketPath, connectTimeoutMs: 400 });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (Date.now() >= deadline) break;
      await delay(50);
    }
  }
  throw new SessionError(
    'sessiond did not become ready at ' + socketPath + ': ' + (lastError?.message ?? 'unknown error'),
    { cause: lastError },
  );
}

/** Connect to sessiond, optionally starting a detached daemon when it is absent. */
export async function ensureSessiond(options: EnsureSessiondOptions): Promise<EnsuredSessiond> {
  try {
    const client = await SessiondClient.connect({
      socketPath: options.socketPath,
      connectTimeoutMs: 500,
      ...(options.cliVersion ? { clientVersion: options.cliVersion } : {}),
    });
    return { client, started: false };
  } catch {
    // Fall through to autostart.
  }

  if (!options.autostart) {
    throw new SessionError(
      'sessiond is not running at ' + options.socketPath + '. Start it with "codingx sessiond start" ' +
        'or enable sessiond.autostart.',
    );
  }

  if (options.spawnDaemon) {
    options.spawnDaemon();
  } else {
    const entry = process.argv[1];
    if (!entry) {
      throw new SessionError('Cannot autostart sessiond: the CLI entry path is unavailable.');
    }
    const args = [
      entry,
      'sessiond',
      '__daemon',
      '--socket',
      options.socketPath,
      '--sessions',
      options.sessionDir,
      '--idle-timeout',
      String(options.idleTimeoutSeconds),
    ];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: options.env ?? process.env,
      cwd: process.cwd(),
    });
    child.on('error', () => undefined);
    child.unref();
  }

  const client = await waitForSessiond(options.socketPath, 8_000);
  return { client, started: true };
}

export { waitForSessiond };
