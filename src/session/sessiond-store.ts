import type {
  AppendEventInput,
  CreateSessionOptions,
  ForkSessionOptions,
  ReplayOptions,
  RolloutEvent,
  SessionAccessMode,
  SessionHandle,
  SessionMeta,
  SessionStoreApi,
  SessionSummary,
} from './types.js';
import { SessiondClient } from './sessiond-client.js';
import type { SessionListItem } from '../sessiond/protocol.js';
import { SessionError } from '../util/errors.js';

export interface SessiondStoreOptions {
  client: SessiondClient;
  /** Heartbeat cadence for write leases; defaults to 5s. */
  heartbeatIntervalMs?: number;
}

function metaFromItem(item: SessionListItem): SessionMeta {
  return {
    id: item.id,
    cwd: item.cwd,
    model: item.model,
    ...(item.provider ? { provider: item.provider } : {}),
    createdAt: item.createdAt,
    cliVersion: '',
  };
}

function summaryFromItem(item: SessionListItem): SessionSummary {
  return {
    id: item.id,
    filePath: item.filePath,
    status: item.status,
    cwd: item.cwd,
    model: item.model,
    ...(item.provider ? { provider: item.provider } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    eventCount: item.eventCount,
  };
}

class RemoteSessionHandle implements SessionHandle {
  readonly id: string;
  readonly filePath: string;
  readonly meta: SessionMeta;
  readonly writable: boolean;
  private readonly client: SessiondClient;
  private readonly leaseId: string | undefined;
  private readonly heartbeatIntervalMs: number;
  private heartbeat: NodeJS.Timeout | undefined;
  private closed = false;
  private ended = false;

  constructor(options: {
    client: SessiondClient;
    id: string;
    filePath: string;
    meta: SessionMeta;
    writable: boolean;
    leaseId?: string;
    heartbeatIntervalMs: number;
  }) {
    this.client = options.client;
    this.id = options.id;
    this.filePath = options.filePath;
    this.meta = options.meta;
    this.writable = options.writable;
    this.leaseId = options.leaseId;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    if (this.writable && this.leaseId) this.startHeartbeat();
  }

  async append(events: AppendEventInput | AppendEventInput[]): Promise<RolloutEvent[]> {
    if (!this.writable) throw new SessionError('Session ' + this.id + ' is read-only.');
    if (this.ended || this.closed) throw new SessionError('Session ' + this.id + ' has ended or is closed.');
    const list = Array.isArray(events) ? events : [events];
    if (list.length === 0) return [];
    const result = await this.client.append({
      sessionId: this.id,
      ...(this.leaseId ? { leaseId: this.leaseId } : {}),
      events: list,
    });
    return result.events;
  }

  async replay(options: ReplayOptions = {}): Promise<RolloutEvent[]> {
    const result = await this.client.replay({
      sessionId: this.id,
      ...(options.fromSeq === undefined ? {} : { fromSeq: options.fromSeq }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    return result.events;
  }

  async end(reason = 'completed'): Promise<RolloutEvent> {
    if (!this.writable) throw new SessionError('Session ' + this.id + ' is read-only.');
    if (this.ended) throw new SessionError('Session ' + this.id + ' has already ended.');
    await this.client.end({
      sessionId: this.id,
      ...(this.leaseId ? { leaseId: this.leaseId } : {}),
      reason,
    });
    this.ended = true;
    this.stopHeartbeat();
    const events = (await this.client.replay({ sessionId: this.id })).events;
    const last = events[events.length - 1];
    if (!last) throw new SessionError('Session ' + this.id + ' ended without a rollout event.');
    return last;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    try {
      await this.client.detach(this.id, this.leaseId);
    } catch {
      // The daemon may already have released the lease after a crash/end.
    }
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      if (!this.leaseId || this.closed) return;
      void this.client.heartbeat({ sessionId: this.id, leaseId: this.leaseId }).catch(() => {
        this.stopHeartbeat();
      });
    }, this.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }
}

/** SessionStoreApi implementation backed by a sessiond connection. */
export class SessiondStore implements SessionStoreApi {
  private readonly client: SessiondClient;
  private readonly heartbeatIntervalMs: number;
  private closed = false;

  constructor(options: SessiondStoreOptions) {
    this.client = options.client;
    this.heartbeatIntervalMs = Math.max(100, options.heartbeatIntervalMs ?? 5_000);
  }

  async createSession(options: CreateSessionOptions): Promise<SessionHandle> {
    const created = await this.client.create({
      cwd: options.cwd,
      model: options.model,
      ...(options.provider ? { provider: options.provider } : {}),
      cliVersion: options.cliVersion,
      ...(options.requestId ? { requestId: options.requestId } : {}),
    });
    const meta: SessionMeta = {
      id: created.sessionId,
      cwd: options.cwd,
      model: options.model,
      ...(options.provider ? { provider: options.provider } : {}),
      createdAt: new Date().toISOString(),
      cliVersion: options.cliVersion,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.forkedFrom ? { forkedFrom: options.forkedFrom } : {}),
    };
    return new RemoteSessionHandle({
      client: this.client,
      id: created.sessionId,
      filePath: created.filePath,
      meta,
      writable: true,
      leaseId: created.leaseId,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
    });
  }

  async attachSession(idOrPrefix: string, mode: SessionAccessMode = 'read'): Promise<SessionHandle> {
    const attached = await this.client.attach({
      sessionId: idOrPrefix,
      mode: mode === 'write' ? 'write' : 'observe',
    });
    const got = await this.client.get(attached.sessionId);
    return new RemoteSessionHandle({
      client: this.client,
      id: attached.sessionId,
      filePath: got.session.filePath,
      meta: metaFromItem(got.session),
      writable: mode === 'write',
      ...(attached.leaseId ? { leaseId: attached.leaseId } : {}),
      heartbeatIntervalMs: this.heartbeatIntervalMs,
    });
  }

  async forkSession(idOrPrefix: string, options: ForkSessionOptions): Promise<SessionHandle> {
    const forked = await this.client.fork({
      sessionId: idOrPrefix,
      ...(options.upToSeq === undefined ? {} : { fromSeq: options.upToSeq }),
      cliVersion: options.cliVersion,
    });
    const got = await this.client.get(forked.sessionId);
    return new RemoteSessionHandle({
      client: this.client,
      id: forked.sessionId,
      filePath: forked.filePath,
      meta: {
        ...metaFromItem(got.session),
        cliVersion: options.cliVersion,
      },
      writable: true,
      leaseId: forked.leaseId,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
    });
  }

  async replaySession(idOrPrefix: string, options: ReplayOptions = {}): Promise<RolloutEvent[]> {
    const replay = await this.client.replay({
      sessionId: idOrPrefix,
      ...(options.fromSeq === undefined ? {} : { fromSeq: options.fromSeq }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    return replay.events;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.client.list({
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.sessions) summaries.push(summaryFromItem(item));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return summaries;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.client.close();
  }
}
