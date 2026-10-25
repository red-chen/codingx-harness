import { loadConfig } from '../../config/index.js';
import { SessiondClient, ensureSessiond } from '../../session/index.js';
import { SessiondDaemon } from '../../sessiond/index.js';
import type { DaemonStatusResult } from '../../sessiond/protocol.js';
import type { TextSink } from '../../ui/plain.js';
import { VERSION } from '../../version.js';

export type SessiondAction = 'start' | 'stop' | 'status' | 'restart';

export interface SessiondCommandOptions {
  action: SessiondAction;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  json?: boolean;
  stdout?: TextSink;
  stderr?: TextSink;
}

export interface DaemonProcessOptions {
  socketPath: string;
  sessionDir: string;
  idleTimeoutSeconds: number;
  version?: string;
}

function printStatus(status: DaemonStatusResult, options: SessiondCommandOptions, stdout: TextSink): void {
  if (options.json) {
    stdout.write(JSON.stringify({ ok: true, sessiond: status }) + '\n');
    return;
  }
  stdout.write(
    'sessiond running\n' +
      '  pid: ' + status.pid + '\n' +
      '  socket: ' + status.socket + '\n' +
      '  version: ' + status.version + '\n' +
      '  started: ' + status.startedAt + '\n' +
      '  sessions: ' + status.sessionCount + '\n' +
      '  connections: ' + status.connectionCount + '\n',
  );
}

async function connectExisting(socketPath: string): Promise<SessiondClient | undefined> {
  try {
    return await SessiondClient.connect({ socketPath, connectTimeoutMs: 500 });
  } catch {
    return undefined;
  }
}

async function resolvePaths(options: SessiondCommandOptions): Promise<{
  socketPath: string;
  sessionDir: string;
  idleTimeoutSeconds: number;
  autostart: boolean;
  enabled: boolean;
}> {
  const loaded = await loadConfig({ cwd: options.cwd, env: options.env });
  return {
    socketPath: loaded.config.sessiond.socket,
    sessionDir: loaded.config.session.dir,
    idleTimeoutSeconds: loaded.config.sessiond.idleTimeoutSeconds,
    autostart: loaded.config.sessiond.autostart,
    enabled: loaded.config.sessiond.enabled,
  };
}

/** Start/stop/status/restart the local sessiond. */
export async function runSessiondCommand(options: SessiondCommandOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const paths = await resolvePaths(options);

  if (options.action === 'status') {
    const client = await connectExisting(paths.socketPath);
    if (!client) {
      if (options.json) stdout.write(JSON.stringify({ ok: false, running: false, socket: paths.socketPath }) + '\n');
      else stderr.write('sessiond is not running (' + paths.socketPath + ')\n');
      return 1;
    }
    try {
      printStatus(await client.status(), options, stdout);
      return 0;
    } finally {
      client.close();
    }
  }

  if (options.action === 'stop') {
    const client = await connectExisting(paths.socketPath);
    if (!client) {
      if (options.json) stdout.write(JSON.stringify({ ok: true, running: false }) + '\n');
      else stdout.write('sessiond is not running\n');
      return 0;
    }
    try {
      await client.shutdown(true);
      if (options.json) stdout.write(JSON.stringify({ ok: true, stopped: true }) + '\n');
      else stdout.write('sessiond stopped\n');
      return 0;
    } finally {
      client.close();
    }
  }

  if (options.action === 'restart') {
    const existing = await connectExisting(paths.socketPath);
    if (existing) {
      await existing.shutdown(true).catch(() => undefined);
      existing.close();
    }
  }

  const ensured = await ensureSessiond({
    socketPath: paths.socketPath,
    sessionDir: paths.sessionDir,
    idleTimeoutSeconds: paths.idleTimeoutSeconds,
    autostart: true,
    cliVersion: VERSION,
    ...(options.env ? { env: options.env } : {}),
  });
  try {
    printStatus(await ensured.client.status(), options, stdout);
    return 0;
  } finally {
    ensured.client.close();
  }
}

/** Internal hidden command: run the daemon in the foreground. */
export async function runDaemonProcess(options: DaemonProcessOptions): Promise<number> {
  const daemon = await SessiondDaemon.start({
    socketPath: options.socketPath,
    sessionDir: options.sessionDir,
    idleTimeoutMs: Math.max(0, options.idleTimeoutSeconds) * 1000,
    ...(options.version ? { version: options.version } : {}),
  });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void daemon.stop('signal');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await daemon.wait();
    return 0;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
