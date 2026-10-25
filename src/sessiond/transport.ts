import type { Duplex } from 'node:stream';
import {
  JSON_RPC_ERROR_CODES,
  NdjsonDecoder,
  SESSIOND_ERROR_CODES,
  SessiondRpcError,
  encodeFrame,
  errorResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  successResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type SessiondErrorKind,
} from './protocol.js';

export interface RequestContext {
  peer: JsonRpcPeer;
}

export type RequestHandler = (
  request: JsonRpcRequest,
  context: RequestContext,
) => Promise<unknown> | unknown;

export type NotificationHandler = (
  notification: JsonRpcNotification,
  context: RequestContext,
) => void;

export interface JsonRpcPeerOptions {
  stream: Duplex;
  /** Handler for requests received by this peer (server and client peers can both have one). */
  onRequest?: RequestHandler;
  onNotification?: NotificationHandler;
  /** Maximum concurrently executing inbound requests. Defaults to 64. */
  maxInFlight?: number;
  /** Default timeout for outbound requests. Defaults to 10s; session.append uses 30s. */
  requestTimeoutMs?: number;
}

export class RpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super('JSON-RPC request "' + method + '" timed out after ' + timeoutMs + 'ms.');
    this.name = 'RpcTimeoutError';
  }
}

export class RpcResponseError extends Error {
  readonly code: number;
  readonly kind?: SessiondErrorKind;
  readonly data?: unknown;

  constructor(code: number, message: string, kind?: SessiondErrorKind, data?: unknown) {
    super(message);
    this.name = 'RpcResponseError';
    this.code = code;
    if (kind) this.kind = kind;
    if (data !== undefined) this.data = data;
  }
}

function idKey(id: JsonRpcId): string {
  return typeof id + ':' + String(id);
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  method: string;
}

/**
 * Bidirectional JSON-RPC peer over a Duplex stream. The sessiond daemon uses
 * one peer per connection; the CLI uses the same class as a client.
 */
export class JsonRpcPeer {
  private readonly stream: Duplex;
  private readonly decoder = new NdjsonDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly onRequest: RequestHandler | undefined;
  private readonly onNotification: NotificationHandler | undefined;
  private readonly maxInFlight: number;
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private inFlight = 0;
  private closed = false;

  constructor(options: JsonRpcPeerOptions) {
    this.stream = options.stream;
    this.onRequest = options.onRequest;
    this.onNotification = options.onNotification;
    this.maxInFlight = options.maxInFlight ?? 64;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;

    this.stream.on('data', this.handleData);
    this.stream.on('error', this.handleStreamError);
    this.stream.on('close', this.handleStreamClose);
    this.stream.on('end', this.handleStreamClose);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Send a request and await its result. */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('JSON-RPC peer is closed.'));
    const id = this.nextId++;
    const message: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(idKey(id));
        reject(new RpcTimeoutError(method, effectiveTimeout));
      }, effectiveTimeout);
      timer.unref();
      this.pending.set(idKey(id), { resolve, reject, timer, method });
      this.write(message);
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  /** Send an untyped JSON-RPC message (used by tests and daemon internals). */
  send(message: JsonRpcMessage): void {
    if (this.closed) return;
    this.write(message);
  }

  close(): void {
    this.dispose(new Error('JSON-RPC peer closed.'));
    try {
      this.stream.end();
    } catch {
      // Already ended.
    }
  }

  private write(message: JsonRpcMessage): void {
    try {
      this.stream.write(encodeFrame(message));
    } catch (error) {
      this.dispose(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private readonly handleData = (chunk: Buffer): void => {
    if (this.closed) return;
    for (const frame of this.decoder.push(chunk)) {
      if (frame.type === 'error') {
        this.writeRawError(null, frame.code, frame.message);
        continue;
      }
      this.dispatch(frame.message);
    }
  };

  private dispatch(message: JsonRpcMessage): void {
    if (isJsonRpcRequest(message)) {
      void this.dispatchRequest(message);
      return;
    }
    if (isJsonRpcNotification(message)) {
      try {
        this.onNotification?.(message, { peer: this });
      } catch {
        // Notifications are fire-and-forget; a handler bug must not kill the peer.
      }
      return;
    }
    if (isJsonRpcResponse(message)) {
      this.dispatchResponse(message);
    }
  }

  private dispatchResponse(response: JsonRpcResponse): void {
    const key = idKey(response.id as JsonRpcId);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    if ('error' in response) {
      const data = response.error.data;
      const kind =
        typeof data === 'object' && data !== null && typeof (data as { kind?: unknown }).kind === 'string'
          ? ((data as { kind: string }).kind as SessiondErrorKind)
          : undefined;
      pending.reject(new RpcResponseError(response.error.code, response.error.message, kind, data));
      return;
    }
    pending.resolve(response.result);
  }

  private async dispatchRequest(request: JsonRpcRequest): Promise<void> {
    if (this.inFlight >= this.maxInFlight) {
      this.writeRawError(request.id, SESSIOND_ERROR_CODES.LIMIT_EXCEEDED, 'Too many concurrent requests.');
      return;
    }
    if (!this.onRequest) {
      this.writeRawError(request.id, JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND, 'Method not found: ' + request.method);
      return;
    }
    this.inFlight += 1;
    try {
      const result = await this.onRequest(request, { peer: this });
      this.send(successResponse(request.id, result === undefined ? null : result));
    } catch (error) {
      if (error instanceof SessiondRpcError) {
        this.send(errorResponse(request.id, error.kind, error.message, error.data));
      } else {
        this.writeRawError(
          request.id,
          JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      this.inFlight -= 1;
    }
  }

  private writeRawError(
    id: JsonRpcId | null,
    code: number,
    message: string,
  ): void {
    this.write({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  }

  private readonly handleStreamError = (): void => {
    this.dispose(new Error('JSON-RPC stream error.'));
  };

  private readonly handleStreamClose = (): void => {
    this.dispose(new Error('JSON-RPC stream closed.'));
  };

  private dispose(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.removeListener('data', this.handleData);
    this.stream.removeListener('error', this.handleStreamError);
    this.stream.removeListener('close', this.handleStreamClose);
    this.stream.removeListener('end', this.handleStreamClose);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}
