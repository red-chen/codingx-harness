import { loadConfig } from '../../config/index.js';
import { ensureSessiond, type RolloutEvent, type SessiondClient } from '../../session/index.js';
import type { SessionListItem, SessionListParams } from '../../sessiond/protocol.js';
import type { TextSink } from '../../ui/plain.js';
import { VERSION } from '../../version.js';
import { formatEvent } from './log.js';

export type SessionsAction = 'list' | 'show' | 'watch' | 'prune';

export interface SessionsCommandOptions {
  action: SessionsAction;
  sessionId?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  json?: boolean;
  limit?: number;
  status?: string;
  fromSeq?: number;
  olderThanDays?: number;
  dryRun?: boolean;
  stdout?: TextSink;
  stderr?: TextSink;
}

async function connect(options: SessionsCommandOptions): Promise<{
  client: SessiondClient;
  retentionDays: number;
  close(): Promise<void>;
}> {
  const loaded = await loadConfig({ cwd: options.cwd, env: options.env });
  if (!loaded.config.sessiond.enabled) {
    throw new Error('sessiond is disabled in config; sessions commands require [sessiond] enabled = true.');
  }
  const ensured = await ensureSessiond({
    cwd: options.cwd,
    socketPath: loaded.config.sessiond.socket,
    sessionDir: loaded.config.session.dir,
    idleTimeoutSeconds: loaded.config.sessiond.idleTimeoutSeconds,
    autostart: loaded.config.sessiond.autostart,
    cliVersion: VERSION,
    ...(options.env ? { env: options.env } : {}),
  });
  return {
    client: ensured.client,
    retentionDays: loaded.config.session.retentionDays,
    close: async () => ensured.client.close(),
  };
}

function formatSessionLine(session: SessionListItem): string {
  return [
    session.id,
    session.status,
    session.model,
    session.cwd,
    String(session.clients),
    session.updatedAt,
  ].join('\t');
}

function printSession(session: SessionListItem, stdout: TextSink): void {
  stdout.write(
    'session: ' + session.id + '\n' +
      '  status: ' + session.status + '\n' +
      '  cwd: ' + session.cwd + '\n' +
      '  model: ' + session.model + (session.provider ? ' (' + session.provider + ')' : '') + '\n' +
      '  file: ' + session.filePath + '\n' +
      '  clients: ' + session.clients + (session.writer ? ' (writer ' + session.writer + ')' : '') + '\n' +
      '  created: ' + session.createdAt + '\n' +
      '  updated: ' + session.updatedAt + '\n' +
      '  events: ' + session.eventCount + '\n',
  );
}

/** codingx sessions list/show/watch. */
export async function runSessionsCommand(options: SessionsCommandOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const connection = await connect(options);
  const client = connection.client;
  try {
    if (options.action === 'prune') {
      const result = await client.prune({
        olderThanDays: options.olderThanDays ?? connection.retentionDays,
        ...(options.dryRun ? { dryRun: true } : {}),
      });
      if (options.json) {
        stdout.write(JSON.stringify(result) + '\n');
      } else {
        stdout.write(
          (options.dryRun ? 'would prune ' : 'pruned ') + result.pruned.length + ' session(s), skipped ' + result.skipped + '\n',
        );
        for (const id of result.pruned) stdout.write('  ' + id + '\n');
      }
      return 0;
    }

    if (options.action === 'list') {
      const result = await client.list({
        limit: options.limit ?? 20,
        ...(options.status ? { status: options.status as SessionListParams['status'] } : {}),
      });
      if (options.json) {
        for (const session of result.sessions) stdout.write(JSON.stringify(session) + '\n');
      } else {
        stdout.write('ID\tSTATUS\tMODEL\tCWD\tCLIENTS\tUPDATED\n');
        for (const session of result.sessions) stdout.write(formatSessionLine(session) + '\n');
        if (result.nextCursor) stdout.write('(more sessions available)\n');
      }
      return 0;
    }

    const sessionId = options.sessionId;
    if (!sessionId) throw new Error('session id is required.');
    const got = await client.get(sessionId);
    if (options.action === 'show') {
      const replay = await client.replay({
        sessionId: sessionId,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      if (options.json) {
        stdout.write(JSON.stringify({ session: got, events: replay.events }) + '\n');
      } else {
        printSession(got.session, stdout);
        for (const event of replay.events) stdout.write(formatEvent(event) + '\n');
      }
      return 0;
    }

    // watch
    if (!options.json) printSession(got.session, stdout);
    const subscription = await client.subscribe(
      {
        sessionId,
        ...(options.fromSeq === undefined ? {} : { fromSeq: options.fromSeq }),
      },
      (message) => {
        if (options.json) {
          stdout.write(JSON.stringify(message) + '\n');
          return;
        }
        if (message.method === 'session.event') {
          const events = (message.params as { events?: unknown }).events;
          if (Array.isArray(events)) {
            for (const event of events) stdout.write(formatEvent(event as RolloutEvent) + '\n');
          }
        } else if (message.method === 'session.status') {
          const status = (message.params as { status?: unknown }).status;
          stdout.write('status: ' + String(status) + '\n');
        } else if (message.method === 'session.cleared') {
          const lastSeq = (message.params as { lastSeq?: unknown }).lastSeq;
          stdout.write('session cleared (replay restarts at seq 1, last seq: ' + String(lastSeq ?? 1) + ')\n');
        } else if (message.method === 'session.lease_revoked') {
          stdout.write('lease revoked\n');
        }
      },
    );
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        subscription.unsubscribe();
        process.removeListener('SIGINT', stop);
        resolve();
      };
      process.once('SIGINT', stop);
    });
    return 0;
  } finally {
    await connection.close();
  }
}
