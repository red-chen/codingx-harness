import { chmod, mkdir, open, readFile, readdir, rm, stat, truncate, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodingxError, SessionBusyError, SessionError } from '../util/errors.js';
import { generateEventId, generateSessionId, resolveSessionId, sessionFileName } from '../util/ids.js';
import { redactDeep } from '../util/redact.js';
import {
  deriveSessionStatus,
  metaFromHeader,
  RESERVED_EVENT_TYPES,
  type AppendEventInput,
  type CreateSessionOptions,
  type ForkSessionOptions,
  type ReplayOptions,
  type RolloutEvent,
  type SessionAccessMode,
  type SessionHandle,
  type SessionMeta,
  type SessionSummary,
} from './types.js';

const MAX_EVENT_BYTES = 1024 * 1024;
const LOCK_INITIALIZING_GRACE_MS = 10_000;
const SESSION_ID_PATTERN = '(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-z]{12})';
const SESSION_FILE_RE = new RegExp('^(.+)_(' + SESSION_ID_PATTERN + ')[.]jsonl$', 'i');
const SESSION_ID_IN_PATH_RE = new RegExp('_(' + SESSION_ID_PATTERN + ')[.]jsonl$', 'i');

interface LockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

interface LockHandle {
  path: string;
  token: string;
  release(): Promise<void>;
}

interface LoadedSession {
  events: RolloutEvent[];
  meta: SessionMeta;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, 'EPERM');
  }
}

async function writeAll(handle: FileHandle, text: string): Promise<void> {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (bytesWritten <= 0) throw new SessionError('Failed to write rollout event: zero-byte write.');
    offset += bytesWritten;
  }
}

async function ensureSessionDir(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  } catch (error) {
    throw new SessionError('Cannot create session directory ' + directory + ': ' + errorMessage(error), {
      cause: error,
    });
  }
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    if (
      isPlainObject(parsed) &&
      typeof parsed.pid === 'number' &&
      typeof parsed.token === 'string' &&
      typeof parsed.createdAt === 'string'
    ) {
      return { pid: parsed.pid, token: parsed.token, createdAt: parsed.createdAt };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  const owner = await readLockOwner(lockPath);
  if (owner?.token !== token) return;
  await unlink(lockPath).catch(() => undefined);
}

async function acquireLock(sessionFilePath: string): Promise<LockHandle> {
  const lockPath = sessionFilePath + '.lock';
  const token = randomUUID();

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: nowIso() }), 'utf8');
      } finally {
        await handle.close();
      }
      return {
        path: lockPath,
        token,
        release: () => releaseLock(lockPath, token),
      };
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) {
        throw new SessionError('Cannot acquire session lock ' + lockPath + ': ' + errorMessage(error), {
          cause: error,
        });
      }

      const owner = await readLockOwner(lockPath);
      if (owner && owner.pid !== process.pid && isProcessAlive(owner.pid)) {
        throw new SessionBusyError(
          'Session ' +
            path.basename(sessionFilePath) +
            ' is already locked by process ' +
            owner.pid +
            '. Only one writer is allowed.',
        );
      }
      if (owner && owner.pid === process.pid && isProcessAlive(owner.pid)) {
        throw new SessionBusyError('Session ' + path.basename(sessionFilePath) + ' is already locked by this process.');
      }

      if (!owner) {
        const info = await stat(lockPath).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs < LOCK_INITIALIZING_GRACE_MS) {
          throw new SessionBusyError('Session lock ' + lockPath + ' is being initialized by another process.');
        }
      }

      const latest = await readLockOwner(lockPath);
      if (latest?.token === owner?.token) {
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
    }
  }

  throw new SessionBusyError('Unable to acquire session lock for ' + sessionFilePath + '.');
}

function validateRolloutEvent(parsed: unknown, filePath: string, lineNumber: number): RolloutEvent {
  if (!isPlainObject(parsed)) {
    throw new SessionError('Corrupt rollout ' + filePath + ' at line ' + lineNumber + ': expected an object.');
  }
  if (typeof parsed.seq !== 'number' || !Number.isInteger(parsed.seq) || parsed.seq <= 0) {
    throw new SessionError('Corrupt rollout ' + filePath + ' at line ' + lineNumber + ': invalid seq.');
  }
  if (typeof parsed.type !== 'string' || parsed.type.length === 0) {
    throw new SessionError('Corrupt rollout ' + filePath + ' at line ' + lineNumber + ': invalid type.');
  }
  if (typeof parsed.ts !== 'string' || parsed.ts.length === 0) {
    throw new SessionError('Corrupt rollout ' + filePath + ' at line ' + lineNumber + ': invalid ts.');
  }
  if (typeof parsed.eventId !== 'string' || parsed.eventId.length === 0) {
    throw new SessionError('Corrupt rollout ' + filePath + ' at line ' + lineNumber + ': invalid eventId.');
  }
  return parsed as RolloutEvent;
}

/** Read a JSONL rollout, ignoring only an incomplete trailing line. */
export async function readRollout(filePath: string): Promise<RolloutEvent[]> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new SessionError('Session file not found: ' + filePath);
    throw new SessionError('Cannot read session file ' + filePath + ': ' + errorMessage(error), { cause: error });
  }

  const lines = text.split('\n');
  const events: RolloutEvent[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const incompleteTail = index === lines.length - 1 && !text.endsWith('\n');
      if (incompleteTail) break;
      throw new SessionError('Corrupt rollout ' + filePath + ' at line ' + (index + 1) + ': invalid JSON.');
    }
    const event = validateRolloutEvent(parsed, filePath, index + 1);
    const previous = events[events.length - 1];
    if (previous && event.seq <= previous.seq) {
      throw new SessionError(
        'Corrupt rollout ' + filePath + ' at line ' + (index + 1) + ': seq must increase monotonically.',
      );
    }
    events.push(event);
  }
  return events;
}

async function loadSessionFile(filePath: string): Promise<LoadedSession> {
  const events = await readRollout(filePath);
  if (events.length === 0) throw new SessionError('Session file ' + filePath + ' contains no events.');
  const header = events[0];
  if (header && header.type === 'session.start') {
    return { events, meta: metaFromHeader(filePath, header) };
  }
  const id = SESSION_ID_IN_PATH_RE.exec(filePath)?.[1] ?? '';
  return {
    events,
    meta: {
      id,
      cwd: '',
      model: '',
      createdAt: header?.ts ?? nowIso(),
      cliVersion: '',
    },
  };
}

async function truncateIncompleteTail(filePath: string): Promise<void> {
  const text = await readFile(filePath, 'utf8');
  if (text.length === 0 || text.endsWith('\n')) return;
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) {
    await truncate(filePath, 0);
    throw new SessionError('Session file ' + filePath + ' has no complete event line.');
  }
  await truncate(filePath, Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8'));
}

function filterEvents(events: RolloutEvent[], options: ReplayOptions): RolloutEvent[] {
  const fromSeq = options.fromSeq ?? 1;
  const selected = events.filter((event) => event.seq >= fromSeq);
  return options.limit === undefined ? selected : selected.slice(0, options.limit);
}

class EmbeddedSessionHandle implements SessionHandle {
  readonly id: string;
  readonly filePath: string;
  readonly meta: SessionMeta;
  readonly writable: boolean;

  private fileHandle: FileHandle | undefined;
  private lock: LockHandle | undefined;
  private nextSeq: number;
  private closed = false;
  private ended = false;
  private readonly seen = new Map<string, RolloutEvent>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string, meta: SessionMeta, events: readonly RolloutEvent[], options: {
    fileHandle?: FileHandle;
    lock?: LockHandle;
    writable: boolean;
  }) {
    this.filePath = filePath;
    this.meta = meta;
    this.id = meta.id;
    this.fileHandle = options.fileHandle;
    this.lock = options.lock;
    this.writable = options.writable;
    for (const event of events) this.seen.set(event.eventId, event);
    this.nextSeq = (events[events.length - 1]?.seq ?? 0) + 1;
    this.ended = events.some((event) => event.type === 'session.end');
  }

  append(events: AppendEventInput | AppendEventInput[]): Promise<RolloutEvent[]> {
    const list = Array.isArray(events) ? events : [events];
    const run = this.queue.then(() => this.appendInternal(list, false));
    this.queue = run.catch(() => undefined);
    return run;
  }

  appendSystem(events: AppendEventInput | AppendEventInput[]): Promise<RolloutEvent[]> {
    const list = Array.isArray(events) ? events : [events];
    const run = this.queue.then(() => this.appendInternal(list, true));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async replay(options: ReplayOptions = {}): Promise<RolloutEvent[]> {
    return filterEvents(await readRollout(this.filePath), options);
  }

  end(reason = 'completed'): Promise<RolloutEvent> {
    const run = this.queue.then(() => this.endInternal(reason));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.queue.catch(() => undefined);
    this.closed = true;
    await this.releaseResources();
  }

  private async appendInternal(inputs: readonly AppendEventInput[], allowReserved: boolean): Promise<RolloutEvent[]> {
    if (this.ended) throw new SessionError('Session ' + this.id + ' has ended and cannot be appended to.');
    if (this.closed) throw new SessionError('Session handle ' + this.id + ' is closed.');
    if (!this.writable || !this.fileHandle) throw new SessionError('Session ' + this.id + ' is read-only.');
    if (inputs.length === 0) return [];

    const written: RolloutEvent[] = [];
    for (const input of inputs) {
      if (!isPlainObject(input) || typeof input.type !== 'string' || input.type.length === 0) {
        throw new SessionError('Invalid rollout event: type is required.');
      }
      if (input.type.length > 200) throw new SessionError('Invalid rollout event: type is too long.');
      if (!allowReserved && RESERVED_EVENT_TYPES.has(input.type)) {
        throw new SessionError('Event type "' + input.type + '" is reserved for the session authority.');
      }

      const eventId =
        typeof input.eventId === 'string' && input.eventId.length > 0 ? input.eventId : generateEventId();
      const existing = this.seen.get(eventId);
      if (existing) {
        written.push(existing);
        continue;
      }

      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input)) {
        if (key === 'type' || key === 'eventId' || key === 'seq' || key === 'ts') continue;
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        payload[key] = value;
      }
      const redacted = redactDeep(payload);
      const seq = this.nextSeq;
      const event: RolloutEvent = {
        seq,
        ts: nowIso(),
        type: input.type,
        eventId,
        ...redacted.value,
        ...(redacted.redacted ? { redacted: true } : {}),
      };

      let line: string;
      try {
        line = JSON.stringify(event) + '\n';
      } catch (error) {
        throw new SessionError('Rollout event is not JSON-serializable: ' + errorMessage(error), { cause: error });
      }
      if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) {
        throw new SessionError('Rollout event exceeds the 1 MiB limit (type: ' + input.type + ').');
      }

      await writeAll(this.fileHandle, line);
      this.nextSeq = seq + 1;
      this.seen.set(eventId, event);
      written.push(event);
    }
    await this.fileHandle.sync();
    return written;
  }

  private async endInternal(reason: string): Promise<RolloutEvent> {
    if (this.ended) throw new SessionError('Session ' + this.id + ' has already ended.');
    if (!this.writable) throw new SessionError('Session ' + this.id + ' is read-only.');
    const [event] = await this.appendInternal([{ type: 'session.end', reason }], true);
    if (!event) throw new SessionError('Failed to write session.end event.');
    this.ended = true;
    await this.releaseResources();
    return event;
  }

  private async releaseResources(): Promise<void> {
    const fileHandle = this.fileHandle;
    this.fileHandle = undefined;
    if (fileHandle) await fileHandle.close().catch(() => undefined);
    const lock = this.lock;
    this.lock = undefined;
    if (lock) await lock.release().catch(() => undefined);
  }
}

export interface SessionStoreOptions {
  /** Absolute session directory. */
  directory: string;
}

/** Process-local store with a single-writer file lock. Replaced by sessiond in M2. */
export class EmbeddedSessionStore {
  readonly directory: string;

  constructor(options: SessionStoreOptions) {
    this.directory = path.resolve(options.directory);
  }

  async createSession(options: CreateSessionOptions): Promise<SessionHandle> {
    await ensureSessionDir(this.directory);

    for (let attempt = 0; attempt < 5; attempt++) {
      const id = generateSessionId();
      const filePath = path.join(this.directory, sessionFileName(id));
      let lock: LockHandle | undefined;
      let fileHandle: FileHandle | undefined;
      let created = false;
      try {
        lock = await acquireLock(filePath);
        fileHandle = await open(filePath, 'wx', 0o600);
        created = true;
        await chmod(filePath, 0o600).catch(() => undefined);

        const ts = nowIso();
        const header: RolloutEvent = {
          seq: 1,
          ts,
          type: 'session.start',
          eventId: generateEventId(),
          cwd: options.cwd,
          model: options.model,
          createdAt: ts,
          cliVersion: options.cliVersion,
          ...(options.provider ? { provider: options.provider } : {}),
          ...(options.requestId ? { requestId: options.requestId } : {}),
          ...(options.forkedFrom ? { forkedFrom: options.forkedFrom } : {}),
        };
        const meta = metaFromHeader(filePath, header);
        const line = JSON.stringify(header) + '\n';
        if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) {
          throw new SessionError('session.start event exceeds the 1 MiB limit.');
        }
        await writeAll(fileHandle, line);
        await fileHandle.sync();

        return new EmbeddedSessionHandle(filePath, meta, [header], {
          fileHandle,
          lock,
          writable: true,
        });
      } catch (error) {
        if (fileHandle) await fileHandle.close().catch(() => undefined);
        if (lock) await lock.release().catch(() => undefined);
        if (created) await unlink(filePath).catch(() => undefined);
        if (isErrno(error, 'EEXIST')) continue;
        if (error instanceof CodingxError) throw error;
        throw new SessionError('Cannot create session: ' + errorMessage(error), { cause: error });
      }
    }
    throw new SessionError('Cannot allocate a unique session id after 5 attempts.');
  }

  async attachSession(idOrPrefix: string, mode: SessionAccessMode = 'read'): Promise<SessionHandle> {
    const filePath = await this.resolveFilePath(idOrPrefix);
    if (mode === 'read') {
      const loaded = await loadSessionFile(filePath);
      return new EmbeddedSessionHandle(filePath, loaded.meta, loaded.events, { writable: false });
    }

    const lock = await acquireLock(filePath);
    try {
      await truncateIncompleteTail(filePath);
      const loaded = await loadSessionFile(filePath);
      if (loaded.events.some((event) => event.type === 'session.end')) {
        throw new SessionError(
          'Session ' + loaded.meta.id + ' has ended and cannot be reopened for writing; use --fork to branch from it.',
        );
      }
      const fileHandle = await open(filePath, 'a', 0o600);
      await chmod(filePath, 0o600).catch(() => undefined);
      return new EmbeddedSessionHandle(filePath, loaded.meta, loaded.events, {
        fileHandle,
        lock,
        writable: true,
      });
    } catch (error) {
      await lock.release().catch(() => undefined);
      throw error;
    }
  }


  /**
   * Copy a session up to a sequence number into a new session. The source is
   * locked for the duration of the copy so an active writer cannot interleave.
   * Only idle / interrupted / ended sessions may be forked.
   */
  async forkSession(idOrPrefix: string, options: ForkSessionOptions): Promise<SessionHandle> {
    const sourcePath = await this.resolveFilePath(idOrPrefix);
    const sourceLock = await acquireLock(sourcePath);
    let created: SessionHandle | undefined;
    try {
      const source = await loadSessionFile(sourcePath);
      const status = deriveSessionStatus(source.events);
      if (status === 'running' || status === 'awaiting_approval') {
        throw new SessionBusyError(
          'Session ' + source.meta.id + ' is ' + status + '; fork is only allowed for idle, interrupted or ended sessions.',
        );
      }
      const lastSeq = source.events[source.events.length - 1]?.seq ?? 0;
      const cut = options.upToSeq ?? lastSeq;
      if (!Number.isInteger(cut) || cut < 1 || cut > lastSeq) {
        throw new SessionError('upToSeq must be between 1 and ' + lastSeq + ' (got ' + String(cut) + ').');
      }
      const selected = source.events.filter((event) => event.seq <= cut);

      created = await this.createSession({
        cwd: options.cwd ?? source.meta.cwd,
        model: options.model ?? source.meta.model,
        ...(options.provider ?? source.meta.provider
          ? { provider: options.provider ?? source.meta.provider }
          : {}),
        cliVersion: options.cliVersion,
        ...(options.requestId ? { requestId: options.requestId } : {}),
        forkedFrom: source.meta.id,
      });

      const copies: AppendEventInput[] = [];
      for (const event of selected) {
        if (event.type.startsWith('session.')) continue;
        const payload: AppendEventInput = { type: event.type };
        for (const [key, value] of Object.entries(event)) {
          if (key === 'seq' || key === 'ts' || key === 'type' || key === 'eventId') continue;
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
          payload[key] = value;
        }
        if (typeof event.eventId === 'string') payload.eventId = event.eventId;
        copies.push(payload);
      }

      // A fork can be cut in the middle of a turn. Converge the copied history
      // so the new session does not appear to be running forever.
      const selectedStatus = deriveSessionStatus(selected);
      if (selectedStatus === 'running' || selectedStatus === 'awaiting_approval' || selectedStatus === 'interrupted') {
        let lastTurnId = 'fork';
        for (let index = selected.length - 1; index >= 0; index -= 1) {
          const turnId = selected[index]?.turnId;
          if (typeof turnId === 'string' && turnId.length > 0) {
            lastTurnId = turnId;
            break;
          }
        }
        copies.push({ type: 'turn.aborted', turnId: lastTurnId, reason: 'forked from an unfinished turn' });
      }

      if (copies.length > 0) await created.append(copies);
      const result = created;
      created = undefined;
      return result;
    } catch (error) {
      if (created) {
        await created.end('fork-failed').catch(() => undefined);
        await created.close().catch(() => undefined);
      }
      if (error instanceof CodingxError) throw error;
      throw new SessionError('Cannot fork session: ' + errorMessage(error), { cause: error });
    } finally {
      await sourceLock.release();
    }
  }

  async replaySession(idOrPrefix: string, options: ReplayOptions = {}): Promise<RolloutEvent[]> {
    const filePath = await this.resolveFilePath(idOrPrefix);
    return filterEvents(await readRollout(filePath), options);
  }

  /** Delete one session file under the same single-writer lock. */
  async deleteSession(idOrPrefix: string): Promise<void> {
    const filePath = await this.resolveFilePath(idOrPrefix);
    const lock = await acquireLock(filePath);
    try {
      await unlink(filePath);
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    const files = await this.sessionFiles();
    const summaries: SessionSummary[] = [];
    for (const file of files) {
      try {
        const loaded = await loadSessionFile(file.filePath);
        const last = loaded.events[loaded.events.length - 1];
        const summary: SessionSummary = {
          id: loaded.meta.id,
          filePath: file.filePath,
          status: deriveSessionStatus(loaded.events),
          cwd: loaded.meta.cwd,
          model: loaded.meta.model,
          createdAt: loaded.meta.createdAt,
          updatedAt: last?.ts ?? loaded.meta.createdAt,
          eventCount: loaded.events.length,
        };
        if (loaded.meta.provider) summary.provider = loaded.meta.provider;
        summaries.push(summary);
      } catch {
        // A corrupt session must not make the whole list unusable.
      }
    }
    summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return summaries;
  }

  async resolveFilePath(idOrPrefix: string): Promise<string> {
    const files = await this.sessionFiles();
    if (files.length === 0) throw new SessionError('No sessions found in ' + this.directory + '.');
    let id: string;
    try {
      id = resolveSessionId(idOrPrefix, files.map((file) => file.id));
    } catch (error) {
      throw new SessionError(errorMessage(error), { cause: error });
    }
    const match = files.find((file) => file.id === id);
    if (!match) throw new SessionError('Session ' + id + ' not found.');
    return match.filePath;
  }

  private async sessionFiles(): Promise<Array<{ id: string; filePath: string }>> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return [];
      throw new SessionError('Cannot list session directory ' + this.directory + ': ' + errorMessage(error), {
        cause: error,
      });
    }
    const files: Array<{ id: string; filePath: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = SESSION_FILE_RE.exec(entry.name);
      if (!match) continue;
      const id = match[2];
      if (!id) continue;
      files.push({ id, filePath: path.join(this.directory, entry.name) });
    }
    return files;
  }
}