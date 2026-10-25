import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { AppendEventInput, RolloutEvent, SessionStatus } from '../session/types.js';

export const SESSIOND_PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_EVENT_BYTES = 1024 * 1024;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type SessiondErrorKind =
  | 'PROTOCOL_MISMATCH'
  | 'SESSION_BUSY'
  | 'LEASE_REVOKED'
  | 'SESSION_NOT_FOUND'
  | 'FRAME_TOO_LARGE'
  | 'LIMIT_EXCEEDED'
  | 'UNAUTHORIZED'
  | 'METHOD_NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'INTERNAL';

export const SESSIOND_ERROR_CODES: Record<SessiondErrorKind, number> = {
  PROTOCOL_MISMATCH: -32001,
  SESSION_BUSY: -32002,
  LEASE_REVOKED: -32003,
  SESSION_NOT_FOUND: -32004,
  FRAME_TOO_LARGE: -32005,
  LIMIT_EXCEEDED: -32006,
  UNAUTHORIZED: -32007,
  METHOD_NOT_FOUND: JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
  INVALID_PARAMS: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
  INTERNAL: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
};

export class SessiondRpcError extends Error {
  readonly kind: SessiondErrorKind;
  readonly data?: Record<string, unknown>;

  constructor(kind: SessiondErrorKind, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'SessiondRpcError';
    this.kind = kind;
    if (data) this.data = data;
  }
}

export const METHOD = {
  initialize: 'initialize',
  daemonStatus: 'daemon.status',
  daemonShutdown: 'daemon.shutdown',
  sessionCreate: 'session.create',
  sessionList: 'session.list',
  sessionGet: 'session.get',
  sessionAttach: 'session.attach',
  sessionDetach: 'session.detach',
  sessionHeartbeat: 'session.heartbeat',
  sessionAppend: 'session.append',
  sessionClear: 'session.clear',
  sessionReplay: 'session.replay',
  sessionSubscribe: 'session.subscribe',
  sessionFork: 'session.fork',
  sessionEnd: 'session.end',
  sessionPrune: 'session.prune',
} as const;

export type SessiondMethod = (typeof METHOD)[keyof typeof METHOD];

/**
 * Every RPC method this build implements. The daemon advertises this list
 * during initialize so a freshly upgraded CLI can detect a long-lived daemon
 * that predates new methods (for example `session.clear`) and restart it.
 */
export const SESSIOND_METHODS: readonly SessiondMethod[] = Object.values(METHOD);

export const NOTIFICATION = {
  event: 'session.event',
  status: 'session.status',
  cleared: 'session.cleared',
  leaseRevoked: 'session.lease_revoked',
  lagged: 'session.lagged',
} as const;

export type SessiondNotification = (typeof NOTIFICATION)[keyof typeof NOTIFICATION];

export interface InitializeParams {
  protocol: number;
  client: { name: string; version: string; pid?: number };
}

export interface InitializeResult {
  protocol: number;
  version: string;
  pid: number;
  startedAt: string;
  sessionCount: number;
  /**
   * Methods implemented by the daemon. Optional because daemons from older
   * builds do not send it; a missing list means "unknown" and is treated as
   * outdated by clients that know which methods they require.
   */
  methods?: readonly SessiondMethod[];
}

export interface DaemonStatusResult {
  pid: number;
  socket: string;
  protocol: number;
  version: string;
  startedAt: string;
  sessionCount: number;
  connectionCount: number;
}

export interface SessionCreateParams {
  requestId?: string;
  cwd: string;
  model: string;
  provider?: string;
  cliVersion: string;
}

export interface SessionCreateResult {
  sessionId: string;
  filePath: string;
  leaseId: string;
  lastSeq: number;
}

export interface SessionListParams {
  cwd?: string;
  status?: SessionStatus;
  limit?: number;
  cursor?: string;
}

export interface SessionListItem {
  id: string;
  filePath: string;
  status: SessionStatus;
  cwd: string;
  model: string;
  provider?: string;
  clients: number;
  writer?: string;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
}

export interface SessionListResult {
  sessions: SessionListItem[];
  nextCursor?: string;
}

export interface SessionGetParams {
  sessionId: string;
}

export interface SessionGetResult {
  session: SessionListItem;
  lastSeq: number;
  eventCount: number;
  lease?: { leaseId: string; clientId: string; mode: 'write'; expiresAt: string };
}

export interface SessionAttachParams {
  sessionId: string;
  mode: 'write' | 'observe';
}

export interface SessionAttachResult {
  sessionId: string;
  mode: 'write' | 'observe';
  leaseId?: string;
  status: SessionStatus;
  lastSeq: number;
}

export interface SessionDetachParams {
  sessionId: string;
  leaseId?: string;
}

export interface SessionHeartbeatParams {
  sessionId: string;
  leaseId: string;
}

export interface SessionHeartbeatResult {
  ok: true;
  expiresAt: string;
}

export interface SessionAppendParams {
  sessionId: string;
  leaseId?: string;
  events: AppendEventInput[];
}

export interface SessionAppendResult {
  appended: Array<{ seq: number; eventId: string }>;
  events: RolloutEvent[];
  lastSeq: number;
}

export interface SessionClearParams {
  sessionId: string;
  leaseId?: string;
}

export interface SessionClearResult {
  sessionId: string;
  lastSeq: number;
  eventCount: number;
}

export interface SessionReplayParams {
  sessionId: string;
  fromSeq?: number;
  limit?: number;
}

export interface SessionReplayResult {
  events: RolloutEvent[];
  lastSeq: number;
  hasMore: boolean;
}

export interface SessionSubscribeParams {
  sessionId: string;
  fromSeq?: number;
}

export interface SessionSubscribeResult {
  sessionId: string;
  fromSeq: number;
}

export interface SessionForkParams {
  sessionId: string;
  fromSeq?: number;
  /** Version written into the fork's session.start header. */
  cliVersion?: string;
}

export interface SessionForkResult {
  sessionId: string;
  filePath: string;
  leaseId: string;
  lastSeq: number;
}

export interface SessionEndParams {
  sessionId: string;
  leaseId?: string;
  reason?: string;
}

export interface SessionPruneParams {
  /** Delete ended sessions older than this many days; defaults to 30. */
  olderThanDays?: number;
  /** Report candidates without deleting. */
  dryRun?: boolean;
}

export interface SessionPruneResult {
  pruned: string[];
  skipped: number;
}

export interface SessionEventNotification {
  sessionId: string;
  events: RolloutEvent[];
}

export interface SessionStatusNotification {
  sessionId: string;
  status: SessionStatus;
  writer?: string;
}

export interface SessionClearedNotification {
  sessionId: string;
  lastSeq: number;
  eventCount: number;
}

export interface SessionLeaseRevokedNotification {
  sessionId: string;
  leaseId: string;
  reason: string;
}

export interface SessionLaggedNotification {
  sessionId: string;
  lastSeq: number;
  dropped: number;
}

const requestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number()]),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

const notificationSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

const errorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

const successResponseSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]),
    result: z.unknown(),
  })
  .strict()
  .refine((value) => Object.prototype.hasOwnProperty.call(value, 'result'), {
    message: 'result member is required',
  });

const errorResponseSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]),
    error: errorObjectSchema,
  })
  .strict();

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return requestSchema.safeParse(value).success;
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  return notificationSchema.safeParse(value).success;
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return successResponseSchema.safeParse(value).success || errorResponseSchema.safeParse(value).success;
}

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return isJsonRpcRequest(value) || isJsonRpcNotification(value) || isJsonRpcResponse(value);
}

export function parseJsonRpcMessage(value: unknown): JsonRpcMessage | undefined {
  return isJsonRpcMessage(value) ? value : undefined;
}

export function successResponse(id: JsonRpcId | null, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: '2.0', id, result };
}

export function errorResponse(
  id: JsonRpcId | null,
  kind: SessiondErrorKind,
  message: string,
  data?: Record<string, unknown>,
): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: SESSIOND_ERROR_CODES[kind],
      message,
      data: { kind, ...(data ?? {}) },
    },
  };
}

export function notification(method: SessiondNotification, params: unknown): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params };
}

export type DecodedFrame =
  | { type: 'message'; message: JsonRpcMessage }
  | {
      type: 'error';
      code: typeof JSON_RPC_ERROR_CODES.PARSE_ERROR | typeof SESSIOND_ERROR_CODES.FRAME_TOO_LARGE;
      message: string;
    };

/**
 * Incremental NDJSON decoder for JSON-RPC frames. Oversized frames are dropped
 * with an error frame, then the decoder resynchronizes at the next newline.
 */
export class NdjsonDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private discardingOversized = false;

  push(chunk: Buffer | string): DecodedFrame[] {
    const input = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.buffer = this.buffer.length === 0 ? Buffer.from(input) : Buffer.concat([this.buffer, input]);
    const frames: DecodedFrame[] = [];

    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > MAX_FRAME_BYTES && !this.discardingOversized) {
          frames.push({
            type: 'error',
            code: SESSIOND_ERROR_CODES.FRAME_TOO_LARGE,
            message: 'Frame exceeds the ' + MAX_FRAME_BYTES + '-byte limit.',
          });
          this.buffer = Buffer.alloc(0);
          this.discardingOversized = true;
        }
        return frames;
      }

      const raw = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (this.discardingOversized) {
        this.discardingOversized = false;
        continue;
      }
      if (raw.length > MAX_FRAME_BYTES) {
        frames.push({
          type: 'error',
          code: SESSIOND_ERROR_CODES.FRAME_TOO_LARGE,
          message: 'Frame exceeds the ' + MAX_FRAME_BYTES + '-byte limit.',
        });
        continue;
      }
      let line = raw.toString('utf8');
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        frames.push({
          type: 'error',
          code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
          message: 'Invalid JSON frame: ' + (error instanceof Error ? error.message : String(error)),
        });
        continue;
      }
      const message = parseJsonRpcMessage(parsed);
      if (!message) {
        frames.push({
          type: 'error',
          code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
          message: 'Frame is not a valid JSON-RPC 2.0 message.',
        });
        continue;
      }
      frames.push({ type: 'message', message });
    }
  }

  /** Flush the decoder; an incomplete trailing frame is reported as an error. */
  end(): DecodedFrame[] {
    const frames: DecodedFrame[] = [];
    if (this.buffer.length > 0 && !this.discardingOversized) {
      frames.push({
        type: 'error',
        code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
        message: 'Incomplete JSON-RPC frame at end of stream.',
      });
    }
    this.buffer = Buffer.alloc(0);
    this.discardingOversized = false;
    return frames;
  }
}

/** Encode one JSON-RPC message as an NDJSON frame. */
export function encodeFrame(message: JsonRpcMessage): Buffer {
  const json = JSON.stringify(message);
  if (json === undefined) throw new Error('JSON-RPC message is not serializable.');
  const frame = Buffer.from(json + '\n', 'utf8');
  if (frame.length - 1 > MAX_FRAME_BYTES) {
    throw new Error('JSON-RPC frame exceeds the ' + MAX_FRAME_BYTES + '-byte limit.');
  }
  return frame;
}

/** Check an event payload against the single-event limit. */
export function validateEventSize(event: unknown): void {
  const size = Buffer.byteLength(JSON.stringify(event), 'utf8');
  if (size > MAX_EVENT_BYTES) {
    throw new Error('Session event exceeds the ' + MAX_EVENT_BYTES + '-byte limit.');
  }
}