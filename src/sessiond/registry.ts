import { randomUUID } from 'node:crypto';
import {
  deriveSessionStatus,
  nextSessionStatus,
  type ForkSessionOptions,
  type RolloutEvent,
  type SessionHandle,
  type SessionStatus,
  type SessionSummary,
} from '../session/index.js';
import { resolveSessionId } from '../util/ids.js';
import { canonicalizePath } from '../util/paths.js';
import type {
  JsonRpcNotification,
  SessionAppendParams,
  SessionAppendResult,
  SessionAttachParams,
  SessionAttachResult,
  SessionClearParams,
  SessionClearResult,
  SessionCreateParams,
  SessionCreateResult,
  SessionEndParams,
  SessionForkParams,
  SessionForkResult,
  SessionGetResult,
  SessionHeartbeatParams,
  SessionHeartbeatResult,
  SessionListItem,
  SessionListParams,
  SessionListResult,
  SessionPruneParams,
  SessionPruneResult,
  SessionReplayParams,
  SessionReplayResult,
  SessionSubscribeParams,
  SessionSubscribeResult,
} from './protocol.js';
import {
  SessiondRpcError,
  notification,
  validateEventSize,
} from './protocol.js';

export interface SessionStoreBackend {
  listSessions(): Promise<SessionSummary[]>;
  createSession(options: {
    cwd: string;
    model: string;
    provider?: string;
    cliVersion: string;
    requestId?: string;
  }): Promise<SessionHandle>;
  attachSession(idOrPrefix: string, mode: 'read' | 'write'): Promise<SessionHandle>;
  forkSession(idOrPrefix: string, options: ForkSessionOptions): Promise<SessionHandle>;
  replaySession(idOrPrefix: string, options?: { fromSeq?: number; limit?: number }): Promise<RolloutEvent[]>;
  deleteSession?(idOrPrefix: string): Promise<void>;
}

export type RegistryNotification = JsonRpcNotification;

export interface SessionSubscriber {
  clientId: string;
  sink: (message: RegistryNotification) => void;
}

export interface Subscription {
  sessionId: string;
  backlog: RolloutEvent[];
  lastSeq: number;
  status: SessionStatus;
  unsubscribe(): void;
}

export interface SessiondRegistryOptions {
  store: SessionStoreBackend;
  /** Write-lease TTL; defaults to 15000ms (heartbeat every 5s). */
  leaseTtlMs?: number;
}

interface WriterLease {
  id: string;
  clientId: string;
  sessionId: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

interface SessionRecord {
  id: string;
  filePath: string;
  cwd: string;
  model: string;
  provider?: string;
  createdAt: string;
  status: SessionStatus;
  lastSeq: number;
  eventCount: number;
  writer?: WriterLease;
  handle?: SessionHandle;
  observers: Set<string>;
  subscribers: Set<SessionSubscriber>;
}

function lastSeq(events: readonly RolloutEvent[]): number {
  return events[events.length - 1]?.seq ?? 0;
}

function isActiveStatus(status: SessionStatus): boolean {
  return status === 'running' || status === 'awaiting_approval';
}

function notFound(id: string): SessiondRpcError {
  return new SessiondRpcError('SESSION_NOT_FOUND', 'Session ' + id + ' was not found.');
}

/**
 * In-memory session authority for the daemon: owns write handles, leases,
 * observers, subscribers and status derivation. Persistence is delegated to a
 * SessionStoreBackend (EmbeddedSessionStore in M2).
 */
export class SessiondRegistry {
  private readonly store: SessionStoreBackend;
  private readonly leaseTtlMs: number;
  private readonly records = new Map<string, SessionRecord>();
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: SessiondRegistryOptions) {
    this.store = options.store;
    this.leaseTtlMs = Math.max(50, options.leaseTtlMs ?? 15_000);
  }

  /** Mark unfinished sessions from a previous daemon/CLI as interrupted. */
  async recover(): Promise<number> {
    return this.runExclusive(async () => {
      let marked = 0;
      const summaries = await this.store.listSessions();
      for (const summary of summaries) {
        if (!isActiveStatus(summary.status)) continue;
        let handle: SessionHandle | undefined;
        try {
          handle = await this.store.attachSession(summary.id, 'write');
          if (typeof handle.appendSystem === 'function') {
            await handle.appendSystem({
              type: 'session.interrupted',
              reason: 'daemon recovered a session with an unfinished turn',
            });
            marked += 1;
          }
        } catch {
          // Another live writer owns the session; recovery must not steal it.
        } finally {
          if (handle) await handle.close().catch(() => undefined);
        }
      }
      return marked;
    });
  }

  async create(clientId: string, params: SessionCreateParams): Promise<SessionCreateResult> {
    return this.runExclusive(async () => {
      this.assertOpen();
      const handle = await this.store.createSession({
        cwd: params.cwd,
        model: params.model,
        ...(params.provider ? { provider: params.provider } : {}),
        cliVersion: params.cliVersion,
        ...(params.requestId ? { requestId: params.requestId } : {}),
      });
      const events = await handle.replay();
      const record = this.recordFromHandle(handle, events);
      record.handle = handle;
      this.records.set(record.id, record);
      const lease = this.grantLease(record, clientId);
      this.publishStatus(record);
      return {
        sessionId: record.id,
        filePath: record.filePath,
        leaseId: lease.id,
        lastSeq: record.lastSeq,
      };
    });
  }

  async attach(clientId: string, params: SessionAttachParams): Promise<SessionAttachResult> {
    return this.runExclusive(async () => {
      this.assertOpen();
      const record = await this.ensureRecord(params.sessionId);
      if (params.mode === 'observe') {
        record.observers.add(clientId);
        this.publishStatus(record);
        return {
          sessionId: record.id,
          mode: 'observe',
          status: record.status,
          lastSeq: record.lastSeq,
        };
      }

      if (record.status === 'ended') {
        throw new SessiondRpcError('SESSION_BUSY', 'Session ' + record.id + ' has ended; fork it instead.');
      }
      if (record.writer) {
        if (record.writer.clientId === clientId) {
          return {
            sessionId: record.id,
            mode: 'write',
            leaseId: record.writer.id,
            status: record.status,
            lastSeq: record.lastSeq,
          };
        }
        throw new SessiondRpcError(
          'SESSION_BUSY',
          'Session ' + record.id + ' is already leased by another client.',
          { holder: record.writer.clientId },
        );
      }

      const handle = await this.store.attachSession(record.id, 'write');
      let events = await handle.replay();
      let status = deriveSessionStatus(events);
      if (isActiveStatus(status)) {
        const interrupted = await handle.appendSystem?.({
          type: 'session.interrupted',
          reason: 'previous writer disappeared before the turn converged',
        });
        if (interrupted) this.publishEvent(record, interrupted);
        events = await handle.replay();
        status = deriveSessionStatus(events);
      }
      if (status === 'interrupted') {
        const resumed = await handle.appendSystem?.({ type: 'session.resumed' });
        if (resumed) this.publishEvent(record, resumed);
        events = await handle.replay();
        status = deriveSessionStatus(events);
      }
      record.handle = handle;
      record.status = status;
      record.lastSeq = lastSeq(events);
      record.eventCount = events.length;
      const lease = this.grantLease(record, clientId);
      this.publishStatus(record);
      return {
        sessionId: record.id,
        mode: 'write',
        leaseId: lease.id,
        status: record.status,
        lastSeq: record.lastSeq,
      };
    });
  }

  async detach(clientId: string, sessionId: string, leaseId?: string): Promise<void> {
    return this.runExclusive(async () => {
      const record = await this.ensureRecord(sessionId);
      // Only an explicit write lease releases the writer. An observer (or a
      // writer's own read handle) must not detach the writer by accident.
      if (record.writer && record.writer.clientId === clientId && leaseId !== undefined) {
        if (leaseId !== record.writer.id) {
          throw new SessiondRpcError('LEASE_REVOKED', 'The lease does not belong to this writer.');
        }
        await this.releaseWriter(record, 'client detached', true);
      }
      record.observers.delete(clientId);
      this.publishStatus(record);
    });
  }

  async heartbeat(clientId: string, params: SessionHeartbeatParams): Promise<SessionHeartbeatResult> {
    return this.runExclusive(async () => {
      const record = await this.ensureRecord(params.sessionId);
      if (!record.writer || record.writer.id !== params.leaseId || record.writer.clientId !== clientId) {
        throw new SessiondRpcError('LEASE_REVOKED', 'The write lease is no longer valid.');
      }
      const lease = record.writer;
      if (lease.expiresAt <= Date.now()) {
        await this.releaseWriter(record, 'lease expired', true);
        throw new SessiondRpcError('LEASE_REVOKED', 'The write lease has expired.');
      }
      lease.expiresAt = Date.now() + this.leaseTtlMs;
      clearTimeout(lease.timer);
      lease.timer = this.leaseTimer(record.id, lease.id);
      return { ok: true, expiresAt: new Date(lease.expiresAt).toISOString() };
    });
  }

  async append(clientId: string, params: SessionAppendParams): Promise<SessionAppendResult> {
    return this.runExclusive(async () => {
      const record = await this.ensureRecord(params.sessionId);
      const writer = record.writer;
      if (!writer || writer.clientId !== clientId || (params.leaseId !== undefined && writer.id !== params.leaseId)) {
        throw new SessiondRpcError('LEASE_REVOKED', 'Append requires the current write lease.');
      }
      if (writer.expiresAt <= Date.now()) {
        await this.releaseWriter(record, 'lease expired', true);
        throw new SessiondRpcError('LEASE_REVOKED', 'The write lease has expired.');
      }
      for (const event of params.events) {
        if (typeof event.type !== 'string' || event.type.length === 0) {
          throw new SessiondRpcError('INVALID_PARAMS', 'Every appended event must have a type.');
        }
        try {
          validateEventSize(event);
        } catch (error) {
          throw new SessiondRpcError(
            'LIMIT_EXCEEDED',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      if (record.status === 'ended') {
        throw new SessiondRpcError('SESSION_BUSY', 'Session ' + record.id + ' has ended.');
      }
      if (!record.handle) throw new SessiondRpcError('INTERNAL', 'Session has no write handle.');
      const previousLastSeq = record.lastSeq;
      const appended = await record.handle.append(params.events);
      const newEvents = appended.filter((event) => event.seq > previousLastSeq);
      if (newEvents.length > 0) {
        record.lastSeq = newEvents[newEvents.length - 1]?.seq ?? record.lastSeq;
        record.eventCount += newEvents.length;
        for (const event of newEvents) record.status = nextSessionStatus(record.status, event);
      }
      this.publishEvent(record, newEvents);
      this.publishStatus(record);
      return {
        appended: appended.map((event) => ({ seq: event.seq, eventId: event.eventId })),
        events: appended,
        lastSeq: record.lastSeq,
      };
    });
  }

  /** Reset a leased session's rollout to its header and restart its sequence. */
  async clear(clientId: string, params: SessionClearParams): Promise<SessionClearResult> {
    return this.runExclusive(async () => {
      const record = await this.ensureRecord(params.sessionId);
      const writer = record.writer;
      if (!writer || writer.clientId !== clientId || (params.leaseId !== undefined && writer.id !== params.leaseId)) {
        throw new SessiondRpcError('LEASE_REVOKED', 'Clearing a session requires the current write lease.');
      }
      if (writer.expiresAt <= Date.now()) {
        await this.releaseWriter(record, 'lease expired', true);
        throw new SessiondRpcError('LEASE_REVOKED', 'The write lease has expired.');
      }
      if (isActiveStatus(record.status)) {
        throw new SessiondRpcError('SESSION_BUSY', 'Session ' + record.id + ' still has an active turn.');
      }
      if (!record.handle) throw new SessiondRpcError('INTERNAL', 'Session has no write handle.');

      await record.handle.clear();
      const events = await record.handle.replay();
      record.status = deriveSessionStatus(events);
      record.lastSeq = lastSeq(events);
      record.eventCount = events.length;
      this.publishCleared(record);
      this.publishStatus(record);
      return {
        sessionId: record.id,
        lastSeq: record.lastSeq,
        eventCount: record.eventCount,
      };
    });
  }

  async replay(params: SessionReplayParams): Promise<SessionReplayResult> {
    return this.runExclusive(async () => {
      const record = await this.ensureRecord(params.sessionId);
      const limit = params.limit === undefined ? undefined : Math.max(1, params.limit);
      const events = await this.store.replaySession(record.id, {
        ...(params.fromSeq === undefined ? {} : { fromSeq: params.fromSeq }),
        ...(limit === undefined ? {} : { limit: limit + 1 }),
      });
      const hasMore = limit !== undefined && events.length > limit;
      const selected = hasMore ? events.slice(0, limit) : events;
      return {
        events: selected,
        lastSeq: record.lastSeq,
        hasMore,
      };
    });
  }

  async subscribe(
    clientId: string,
    params: SessionSubscribeParams,
    sink: (message: RegistryNotification) => void,
  ): Promise<Subscription> {
    return this.runExclusive(async () => {
      const record = await this.ensureRecord(params.sessionId);
      const backlog = await this.store.replaySession(record.id, {
        ...(params.fromSeq === undefined ? {} : { fromSeq: params.fromSeq }),
      });
      const subscriber: SessionSubscriber = { clientId, sink };
      record.subscribers.add(subscriber);
      record.observers.add(clientId);
      this.publishStatus(record);
      return {
        sessionId: record.id,
        backlog,
        lastSeq: record.lastSeq,
        status: record.status,
        unsubscribe: () => {
          record.subscribers.delete(subscriber);
          record.observers.delete(clientId);
        },
      } satisfies Subscription;
    });
  }

  async fork(clientId: string, params: SessionForkParams): Promise<SessionForkResult> {
    return this.runExclusive(async () => {
      this.assertOpen();
      const source = await this.ensureRecord(params.sessionId);
      if (isActiveStatus(source.status)) {
        throw new SessiondRpcError('SESSION_BUSY', 'Session ' + source.id + ' is ' + source.status + '; fork is not allowed.');
      }
      if (source.writer) {
        throw new SessiondRpcError(
          'SESSION_BUSY',
          'Session ' + source.id + ' is still leased; detach it before forking.',
        );
      }
      const handle = await this.store.forkSession(source.id, {
        ...(params.fromSeq === undefined ? {} : { upToSeq: params.fromSeq }),
        cliVersion: params.cliVersion ?? '0.1.0',
      });
      const events = await handle.replay();
      const record = this.recordFromHandle(handle, events);
      record.handle = handle;
      this.records.set(record.id, record);
      const lease = this.grantLease(record, clientId);
      this.publishStatus(record);
      return {
        sessionId: record.id,
        filePath: record.filePath,
        leaseId: lease.id,
        lastSeq: record.lastSeq,
      };
    });
  }

  async end(clientId: string, params: SessionEndParams): Promise<void> {
    return this.runExclusive(async () => {
      const record = await this.ensureRecord(params.sessionId);
      const writer = record.writer;
      if (!writer || writer.clientId !== clientId || (params.leaseId !== undefined && writer.id !== params.leaseId)) {
        throw new SessiondRpcError('LEASE_REVOKED', 'Ending a session requires its write lease.');
      }
      if (isActiveStatus(record.status)) {
        throw new SessiondRpcError('SESSION_BUSY', 'Session ' + record.id + ' still has an active turn.');
      }
      if (!record.handle) throw new SessiondRpcError('INTERNAL', 'Session has no write handle.');
      const handle = record.handle;
      const event = await handle.end(params.reason ?? 'completed');
      record.status = 'ended';
      record.lastSeq = event.seq;
      record.eventCount += 1;
      clearTimeout(writer.timer);
      record.writer = undefined;
      record.handle = undefined;
      await handle.close().catch(() => undefined);
      this.publishEvent(record, [event]);
      this.publishStatus(record);
    });
  }

  async countSessions(): Promise<number> {
    return this.runExclusive(async () => (await this.store.listSessions()).length);
  }

  async prune(params: SessionPruneParams = {}): Promise<SessionPruneResult> {
    return this.runExclusive(async () => {
      const days = Math.max(0, params.olderThanDays ?? 30);
      const cutoff = Date.now() - days * 86_400_000;
      const pruned: string[] = [];
      let skipped = 0;
      for (const summary of await this.summariesForCwd(params.cwd)) {
        const record = this.records.get(summary.id);
        const status = record?.status ?? summary.status;
        const updated = Date.parse(summary.updatedAt);
        if (
          status === 'running' ||
          status === 'awaiting_approval' ||
          !Number.isFinite(updated) ||
          updated > cutoff ||
          record?.writer !== undefined ||
          (record?.observers.size ?? 0) > 0
        ) {
          skipped += 1;
          continue;
        }
        if (params.dryRun) {
          pruned.push(summary.id);
          continue;
        }
        if (!this.store.deleteSession) {
          skipped += 1;
          continue;
        }
        try {
          await this.store.deleteSession(summary.id);
          this.records.delete(summary.id);
          pruned.push(summary.id);
        } catch {
          skipped += 1;
        }
      }
      return { pruned, skipped };
    });
  }

  async list(params: SessionListParams = {}): Promise<SessionListResult> {
    return this.runExclusive(async () => {
      const summaries = await this.summariesForCwd(params.cwd);
      const filtered = summaries.filter((summary) => {
        const record = this.records.get(summary.id);
        const status = record?.status ?? summary.status;
        return params.status === undefined || params.status === status;
      });
      const limit = Math.max(1, Math.min(200, params.limit ?? 20));
      const start = params.cursor ? Math.max(0, filtered.findIndex((summary) => summary.id === params.cursor) + 1) : 0;
      const page = filtered.slice(start, start + limit);
      const items = page.map((summary) => this.listItem(summary));
      const next = start + page.length < filtered.length ? page[page.length - 1]?.id : undefined;
      return {
        sessions: items,
        ...(next ? { nextCursor: next } : {}),
      };
    });
  }

  async get(sessionId: string): Promise<SessionGetResult> {
    return this.runExclusive(async () => {
      const record = await this.ensureRecord(sessionId);
      const summary = await this.summaryFor(record);
      return {
        session: this.listItem(summary),
        lastSeq: record.lastSeq,
        eventCount: record.eventCount,
        ...(record.writer
          ? {
              lease: {
                leaseId: record.writer.id,
                clientId: record.writer.clientId,
                mode: 'write' as const,
                expiresAt: new Date(record.writer.expiresAt).toISOString(),
              },
            }
          : {}),
      };
    });
  }

  private async summariesForCwd(cwd?: string): Promise<SessionSummary[]> {
    const summaries = await this.store.listSessions();
    if (cwd === undefined) return summaries;
    const canonical = await canonicalizePath(cwd);
    const matches = await Promise.all(summaries.map(async (summary) =>
      await canonicalizePath(summary.cwd) === canonical));
    return summaries.filter((_, index) => matches[index]);
  }

  async resolveForCwd(idOrPrefix: string, cwd: string): Promise<string> {
    return this.runExclusive(async () => {
      const record = this.records.get(idOrPrefix);
      if (record) {
        if (await canonicalizePath(record.cwd) !== await canonicalizePath(cwd)) throw notFound(idOrPrefix);
        return record.id;
      }
      const summaries = await this.summariesForCwd(cwd);
      try {
        return resolveSessionId(idOrPrefix, summaries.map((summary) => summary.id));
      } catch {
        throw notFound(idOrPrefix);
      }
    });
  }

  async disconnectClient(clientId: string): Promise<void> {
    return this.runExclusive(async () => {
      for (const record of this.records.values()) {
        if (record.writer?.clientId === clientId) {
          await this.releaseWriter(record, 'client disconnected', true);
        }
        record.observers.delete(clientId);
        for (const subscriber of record.subscribers) {
          if (subscriber.clientId === clientId) record.subscribers.delete(subscriber);
        }
      }
    });
  }

  async shutdown(force = false): Promise<void> {
    return this.runExclusive(async () => {
      const leased = [...this.records.values()].filter((record) => record.writer);
      if (leased.length > 0 && !force) {
        throw new SessiondRpcError(
          'SESSION_BUSY',
          'Cannot shut down while ' + leased.length + ' session lease(s) are active.',
        );
      }
      for (const record of this.records.values()) {
        if (record.writer) await this.releaseWriter(record, 'daemon shutdown', true);
        else if (record.handle) await record.handle.close().catch(() => undefined);
        record.subscribers.clear();
        record.observers.clear();
      }
      this.closed = true;
    });
  }

  private async ensureRecord(sessionIdOrPrefix: string): Promise<SessionRecord> {
    for (const record of this.records.values()) {
      if (record.id === sessionIdOrPrefix) return record;
    }
    const summaries = await this.store.listSessions();
    let id: string;
    try {
      id = resolveSessionId(sessionIdOrPrefix, summaries.map((summary) => summary.id));
    } catch (error) {
      throw notFound(sessionIdOrPrefix);
    }
    const existing = this.records.get(id);
    if (existing) return existing;
    const summary = summaries.find((item) => item.id === id);
    if (!summary) throw notFound(id);
    const events = await this.store.replaySession(id);
    const record: SessionRecord = {
      id,
      filePath: summary.filePath,
      cwd: summary.cwd,
      model: summary.model,
      ...(summary.provider ? { provider: summary.provider } : {}),
      createdAt: summary.createdAt,
      status: deriveSessionStatus(events),
      lastSeq: lastSeq(events),
      eventCount: events.length,
      observers: new Set(),
      subscribers: new Set(),
    };
    this.records.set(id, record);
    return record;
  }

  private recordFromHandle(handle: SessionHandle, events: readonly RolloutEvent[]): SessionRecord {
    return {
      id: handle.id,
      filePath: handle.filePath,
      cwd: handle.meta.cwd,
      model: handle.meta.model,
      ...(handle.meta.provider ? { provider: handle.meta.provider } : {}),
      createdAt: handle.meta.createdAt,
      status: deriveSessionStatus(events),
      lastSeq: lastSeq(events),
      eventCount: events.length,
      observers: new Set(),
      subscribers: new Set(),
    };
  }

  private grantLease(record: SessionRecord, clientId: string): WriterLease {
    const leaseId = randomUUID();
    const lease: WriterLease = {
      id: leaseId,
      clientId,
      sessionId: record.id,
      expiresAt: Date.now() + this.leaseTtlMs,
      timer: this.leaseTimer(record.id, leaseId),
    };
    record.writer = lease;
    return lease;
  }

  private leaseTimer(sessionId: string, leaseId: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      void this.runExclusive(() => this.expireLease(sessionId, leaseId));
    }, this.leaseTtlMs);
    timer.unref();
    return timer;
  }

  private async expireLease(sessionId: string, leaseId: string): Promise<void> {
    const record = this.records.get(sessionId);
    if (!record || record.writer?.id !== leaseId) return;
    await this.releaseWriter(record, 'lease expired', true);
  }

  private async releaseWriter(record: SessionRecord, reason: string, markInterrupted: boolean): Promise<void> {
    const writer = record.writer;
    if (!writer) return;
    clearTimeout(writer.timer);
    record.writer = undefined;
    if (record.handle) {
      if (markInterrupted && isActiveStatus(record.status)) {
        const interrupted = await record.handle.appendSystem?.({
          type: 'session.interrupted',
          reason,
        });
        if (interrupted) this.publishEvent(record, interrupted);
      }
      const events = await record.handle.replay();
      record.status = deriveSessionStatus(events);
      record.lastSeq = lastSeq(events);
      record.eventCount = events.length;
      await record.handle.close().catch(() => undefined);
      record.handle = undefined;
    }
    for (const subscriber of record.subscribers) {
      try {
        subscriber.sink(
          notification('session.lease_revoked', {
            sessionId: record.id,
            leaseId: writer.id,
            reason,
          }),
        );
      } catch {
        // A broken subscriber must not block lease cleanup.
      }
    }
    this.publishStatus(record);
  }

  private async summaryFor(record: SessionRecord): Promise<SessionSummary> {
    return {
      id: record.id,
      filePath: record.filePath,
      status: record.status,
      cwd: record.cwd,
      model: record.model,
      ...(record.provider ? { provider: record.provider } : {}),
      createdAt: record.createdAt,
      updatedAt: new Date().toISOString(),
      eventCount: record.eventCount,
    };
  }

  private listItem(summary: SessionSummary): SessionListItem {
    const record = this.records.get(summary.id);
    const writer = record?.writer?.clientId;
    const clients = (writer ? 1 : 0) + (record?.observers.size ?? 0);
    return {
      id: summary.id,
      filePath: summary.filePath,
      status: record?.status ?? summary.status,
      cwd: summary.cwd,
      model: summary.model,
      ...(summary.provider ? { provider: summary.provider } : {}),
      clients,
      ...(writer ? { writer } : {}),
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      eventCount: record?.eventCount ?? summary.eventCount,
    };
  }

  private publishEvent(record: SessionRecord, events: readonly RolloutEvent[]): void {
    if (events.length === 0) return;
    for (const subscriber of record.subscribers) {
      try {
        subscriber.sink(
          notification('session.event', {
            sessionId: record.id,
            events,
          }),
        );
      } catch {
        // Ignore subscriber failures; the server disconnects slow/dead clients.
      }
    }
  }

  private publishStatus(record: SessionRecord): void {
    for (const subscriber of record.subscribers) {
      try {
        subscriber.sink(
          notification('session.status', {
            sessionId: record.id,
            status: record.status,
            ...(record.writer ? { writer: record.writer.clientId } : {}),
          }),
        );
      } catch {
        // Ignore subscriber failures.
      }
    }
  }

  /** Tell watchers that earlier seqs are gone and replay should restart at 1. */
  private publishCleared(record: SessionRecord): void {
    for (const subscriber of record.subscribers) {
      try {
        subscriber.sink(
          notification('session.cleared', {
            sessionId: record.id,
            lastSeq: record.lastSeq,
            eventCount: record.eventCount,
          }),
        );
      } catch {
        // Ignore subscriber failures.
      }
    }
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private assertOpen(): void {
    if (this.closed) throw new SessiondRpcError('INTERNAL', 'The session registry is closed.');
  }
}
