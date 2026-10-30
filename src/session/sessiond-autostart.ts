import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { buildChildEnv } from '../exec/index.js';
import { SESSIOND_METHODS } from '../sessiond/protocol.js';
import { RpcResponseError } from '../sessiond/transport.js';
import { SessionError } from '../util/errors.js';
import { SessiondClient } from './sessiond-client.js';

export interface EnsureSessiondOptions {
  socketPath: string;
  cwd?: string;
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
  /** True when a daemon from an older build was stopped and replaced. */
  replacedStale?: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeMissing(missing: readonly string[]): string {
  if (missing.length >= SESSIOND_METHODS.length) return 'it does not advertise an RPC method list';
  return 'missing ' + missing.join(', ');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function socketExists(socketPath: string): Promise<boolean> {
  try {
    await access(socketPath);
    return true;
  } catch {
    return false;
  }
}

/** Wait until the daemon removed its socket so a replacement can bind it. */
async function waitForSocketGone(socketPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await socketExists(socketPath))) return true;
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
}

/**
 * Stop a daemon whose initialize reply did not advertise every method this
 * build needs. `shutdown(false)` is intentional: a daemon with active write
 * leases is left alone and the caller gets an actionable error instead of a
 * mid-turn restart.
 */
async function stopOutdatedSessiond(
  client: SessiondClient,
  socketPath: string,
  missing: readonly string[],
): Promise<void> {
  try {
    await client.shutdown(false);
  } catch (error) {
    if (error instanceof RpcResponseError && error.kind === 'SESSION_BUSY') {
      throw new SessionError(
        'sessiond at ' + socketPath + ' is running an older build (' + describeMissing(missing) + ') ' +
          'and still holds session leases. Close other codingx sessions and run "codingx sessiond restart".',
        { cause: error },
      );
    }
    throw new SessionError(
      'Cannot replace the outdated sessiond at ' + socketPath + ' (' + describeMissing(missing) + '): ' +
        errorText(error) + '. Run "codingx sessiond restart".',
      { cause: error },
    );
  } finally {
    client.close();
  }
  if (!(await waitForSocketGone(socketPath, 3_000))) {
    throw new SessionError(
      'The outdated sessiond at ' + socketPath + ' did not release its socket. Run "codingx sessiond restart".',
    );
  }
}

async function waitForSessiond(socketPath: string, timeoutMs: number, cwd?: string): Promise<SessiondClient> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  for (;;) {
    try {
      return await SessiondClient.connect({ socketPath, connectTimeoutMs: 400, ...(cwd === undefined ? {} : { cwd }) });
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

/**
 * Connect to sessiond, optionally starting a detached daemon when it is
 * absent. A long-lived daemon from before an upgrade is detected through the
 * method list it advertises during initialize and replaced; otherwise its
 * missing methods only surface later as `Unknown method: session.clear`.
 */
export async function ensureSessiond(options: EnsureSessiondOptions): Promise<EnsuredSessiond> {
  let outdated: { client: SessiondClient; missing: string[] } | undefined;
  try {
    const client = await SessiondClient.connect({
      socketPath: options.socketPath,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      connectTimeoutMs: 500,
      ...(options.cliVersion ? { clientVersion: options.cliVersion } : {}),
    });
    const missing = client.missingMethods(SESSIOND_METHODS);
    if (!client.cwdIsolation) missing.push('cwd isolation');
    if (!client.readableWorkspaces) missing.push('readable cwd directories');
    if (missing.length === 0) return { client, started: false };
    outdated = { client, missing };
  } catch {
    // No daemon, or a handshake failure: fall through to autostart.
  }

  if (outdated) {
    if (!options.autostart) {
      outdated.client.close();
      throw new SessionError(
        'sessiond at ' + options.socketPath + ' is running an older build (' +
          describeMissing(outdated.missing) + '). Run "codingx sessiond restart" or enable sessiond.autostart.',
      );
    }
    await stopOutdatedSessiond(outdated.client, options.socketPath, outdated.missing);
  } else if (!options.autostart) {
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
      // The daemon only needs local paths and a working PATH. Do not leak
      // provider credentials or other tool environment into a long-lived child.
      env: buildChildEnv(
        ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'USER', 'SHELL'],
        options.env ?? process.env,
      ),
      cwd: process.cwd(),
    });
    child.on('error', () => undefined);
    child.unref();
  }

  const client = await waitForSessiond(options.socketPath, 8_000, options.cwd);
  const missing = client.missingMethods(SESSIOND_METHODS);
  if (!client.cwdIsolation) missing.push('cwd isolation');
  if (!client.readableWorkspaces) missing.push('readable cwd directories');
  if (missing.length > 0) {
    client.close();
    throw new SessionError(
      'sessiond at ' + options.socketPath + ' started but is still outdated (' + describeMissing(missing) +
        '). Run "codingx sessiond restart".',
    );
  }
  return { client, started: true, ...(outdated ? { replacedStale: true } : {}) };
}

export { waitForSessiond };
