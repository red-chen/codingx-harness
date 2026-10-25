/** Rollout is the append-only JSONL source of truth. */
export interface RolloutEvent {
  seq: number;
  ts: string;
  type: string;
  eventId: string;
  [key: string]: unknown;
}

export interface AppendEventInput {
  type: string;
  eventId?: string;
  [key: string]: unknown;
}

export type SessionStatus = 'idle' | 'running' | 'awaiting_approval' | 'interrupted' | 'ended';

export type SessionAccessMode = 'read' | 'write';

export interface SessionMeta {
  id: string;
  cwd: string;
  model: string;
  provider?: string;
  createdAt: string;
  cliVersion: string;
  requestId?: string;
  forkedFrom?: string;
}

export interface CreateSessionOptions {
  cwd: string;
  model: string;
  provider?: string;
  cliVersion: string;
  requestId?: string;
  forkedFrom?: string;
}

export interface ForkSessionOptions {
  /** Copy events with seq <= upToSeq. Defaults to the source's last seq. */
  upToSeq?: number;
  cwd?: string;
  model?: string;
  provider?: string;
  cliVersion: string;
  requestId?: string;
}

export interface SessionSummary {
  id: string;
  filePath: string;
  status: SessionStatus;
  cwd: string;
  model: string;
  provider?: string;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
}

export interface ReplayOptions {
  fromSeq?: number;
  limit?: number;
}

export interface SessionStoreApi {
  createSession(options: CreateSessionOptions): Promise<SessionHandle>;
  attachSession(idOrPrefix: string, mode?: SessionAccessMode): Promise<SessionHandle>;
  forkSession(idOrPrefix: string, options: ForkSessionOptions): Promise<SessionHandle>;
  replaySession(idOrPrefix: string, options?: ReplayOptions): Promise<RolloutEvent[]>;
  listSessions(): Promise<SessionSummary[]>;
  deleteSession?(idOrPrefix: string): Promise<void>;
  /** Optional transport cleanup for remote stores. */
  close?(): Promise<void>;
}

export interface SessionHandle {
  readonly id: string;
  readonly filePath: string;
  readonly meta: SessionMeta;
  readonly writable: boolean;
  append(events: AppendEventInput | AppendEventInput[]): Promise<RolloutEvent[]>;
  /** Authority-only append for reserved events (session.resumed/interrupted/end). */
  appendSystem?(events: AppendEventInput | AppendEventInput[]): Promise<RolloutEvent[]>;
  replay(options?: ReplayOptions): Promise<RolloutEvent[]>;
  end(reason?: string): Promise<RolloutEvent>;
  close(): Promise<void>;
}

/** Events reserved for the session authority (sessiond in the target design). */
export const RESERVED_EVENT_TYPES = new Set([
  'session.start',
  'session.end',
  'session.interrupted',
  'session.resumed',
]);

export function deriveSessionStatus(events: readonly RolloutEvent[]): SessionStatus {
  let status: SessionStatus = 'idle';
  for (const event of events) {
    switch (event.type) {
      case 'session.end':
        status = 'ended';
        break;
      case 'session.interrupted':
        status = 'interrupted';
        break;
      case 'session.resumed':
        status = 'idle';
        break;
      case 'turn.start':
        status = 'running';
        break;
      case 'turn.status': {
        const value = event.status;
        if (value === 'awaiting_approval') status = 'awaiting_approval';
        else if (value === 'streaming' || value === 'executing' || value === 'running') status = 'running';
        break;
      }
      case 'turn.end':
      case 'turn.aborted':
        status = 'idle';
        break;
      default:
        break;
    }
  }
  return status;
}

export function metaFromHeader(filePath: string, header: RolloutEvent): SessionMeta {
  const match = /^(.*)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-z]{12})\.jsonl$/i.exec(
    filePath,
  );
  const id = match?.[2] ?? '';
  const createdAt = typeof header.createdAt === 'string' ? header.createdAt : header.ts;
  const meta: SessionMeta = {
    id,
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    model: typeof header.model === 'string' ? header.model : '',
    createdAt,
    cliVersion: typeof header.cliVersion === 'string' ? header.cliVersion : '',
  };
  if (typeof header.provider === 'string') meta.provider = header.provider;
  if (typeof header.requestId === 'string') meta.requestId = header.requestId;
  if (typeof header.forkedFrom === 'string') meta.forkedFrom = header.forkedFrom;
  return meta;
}