import { connect } from 'node:net';
import type { Socket } from 'node:net';
import {
  SESSIOND_PROTOCOL_VERSION,
  type DaemonStatusResult,
  type InitializeResult,
  type JsonRpcNotification,
  type SessionAppendParams,
  type SessionAppendResult,
  type SessionAttachParams,
  type SessionAttachResult,
  type SessionClearParams,
  type SessionClearResult,
  type SessionCreateParams,
  type SessionCreateResult,
  type SessionEndParams,
  type SessionForkParams,
  type SessionForkResult,
  type SessionGetResult,
  type SessionHeartbeatParams,
  type SessionHeartbeatResult,
  type SessionListParams,
  type SessionListResult,
  type SessionPruneParams,
  type SessionPruneResult,
  type SessionReplayParams,
  type SessionReplayResult,
  type SessionSubscribeParams,
  type SessionSubscribeResult,
} from '../sessiond/protocol.js';
import { JsonRpcPeer } from '../sessiond/transport.js';

export interface SessiondClientOptions {
  socketPath: string;
  clientName?: string;
  clientVersion?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

type SessionNotificationListener = (message: JsonRpcNotification) => void;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectSocket(socketPath: string, timeoutMs: number): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  for (;;) {
    try {
      const socket = await new Promise<Socket>((resolve, reject) => {
        const candidate = connect(socketPath);
        const onConnect = (): void => {
          candidate.off('error', onError);
          resolve(candidate);
        };
        const onError = (error: Error): void => {
          candidate.off('connect', onConnect);
          candidate.destroy();
          reject(error);
        };
        candidate.once('connect', onConnect);
        candidate.once('error', onError);
      });
      socket.setNoDelay(true);
      return socket;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (Date.now() >= deadline) break;
      await delay(50);
    }
  }
  throw new Error(
    'Cannot connect to sessiond at ' + socketPath + ': ' + (lastError?.message ?? 'unknown error'),
  );
}

/** Typed JSON-RPC client for the local sessiond (Unix socket). */
export class SessiondClient {
  readonly socketPath: string;
  private readonly peer: JsonRpcPeer;
  private readonly listeners = new Map<string, Set<SessionNotificationListener>>();
  private readonly requestTimeoutMs: number;
  private closed = false;

  private constructor(socket: Socket, options: SessiondClientOptions) {
    this.socketPath = options.socketPath;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.peer = new JsonRpcPeer({
      stream: socket,
      requestTimeoutMs: this.requestTimeoutMs,
      onNotification: (message) => this.dispatchNotification(message),
    });
  }

  static async connect(options: SessiondClientOptions): Promise<SessiondClient> {
    const socket = await connectSocket(options.socketPath, options.connectTimeoutMs ?? 3_000);
    const client = new SessiondClient(socket, options);
    try {
      await client.initialize(options.clientName ?? 'codingx-cli', options.clientVersion ?? '0.1.0');
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async initialize(name = 'codingx-cli', version = '0.1.0'): Promise<InitializeResult> {
    return this.request<InitializeResult>('initialize', {
      protocol: SESSIOND_PROTOCOL_VERSION,
      client: { name, version, pid: process.pid },
    });
  }

  async status(): Promise<DaemonStatusResult> {
    return this.request<DaemonStatusResult>('daemon.status');
  }

  async shutdown(force = false): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('daemon.shutdown', { force }, 30_000);
  }

  async create(params: SessionCreateParams): Promise<SessionCreateResult> {
    return this.request<SessionCreateResult>('session.create', params, 30_000);
  }

  async list(params: SessionListParams = {}): Promise<SessionListResult> {
    return this.request<SessionListResult>('session.list', params);
  }

  async get(sessionId: string): Promise<SessionGetResult> {
    return this.request<SessionGetResult>('session.get', { sessionId });
  }

  async attach(params: SessionAttachParams): Promise<SessionAttachResult> {
    return this.request<SessionAttachResult>('session.attach', params, 30_000);
  }

  async detach(sessionId: string, leaseId?: string): Promise<void> {
    await this.request('session.detach', {
      sessionId,
      ...(leaseId === undefined ? {} : { leaseId }),
    });
  }

  async heartbeat(params: SessionHeartbeatParams): Promise<SessionHeartbeatResult> {
    return this.request<SessionHeartbeatResult>('session.heartbeat', params);
  }

  async append(params: SessionAppendParams): Promise<SessionAppendResult> {
    return this.request<SessionAppendResult>('session.append', params, 30_000);
  }

  async clear(params: SessionClearParams): Promise<SessionClearResult> {
    return this.request<SessionClearResult>('session.clear', params, 30_000);
  }

  async replay(params: SessionReplayParams): Promise<SessionReplayResult> {
    return this.request<SessionReplayResult>('session.replay', params, 30_000);
  }

  async subscribe(
    params: SessionSubscribeParams,
    listener: SessionNotificationListener,
  ): Promise<SessionSubscribeResult & { unsubscribe(): void }> {
    const listeners = this.listeners.get(params.sessionId) ?? new Set<SessionNotificationListener>();
    listeners.add(listener);
    this.listeners.set(params.sessionId, listeners);
    try {
      const result = await this.request<SessionSubscribeResult>('session.subscribe', params, 30_000);
      return {
        ...result,
        unsubscribe: () => {
          listeners.delete(listener);
          if (listeners.size === 0) this.listeners.delete(params.sessionId);
        },
      };
    } catch (error) {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(params.sessionId);
      throw error;
    }
  }

  async prune(params: SessionPruneParams = {}): Promise<SessionPruneResult> {
    return this.request<SessionPruneResult>('session.prune', params, 30_000);
  }

  async fork(params: SessionForkParams): Promise<SessionForkResult> {
    return this.request<SessionForkResult>('session.fork', params, 30_000);
  }

  async end(params: SessionEndParams): Promise<void> {
    await this.request('session.end', params, 30_000);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.peer.close();
  }

  private request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error('sessiond client is closed.'));
    return this.peer.request(method, params, timeoutMs) as Promise<T>;
  }

  private dispatchNotification(message: JsonRpcNotification): void {
    const params = message.params;
    if (typeof params !== 'object' || params === null) return;
    const sessionId = (params as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== 'string') return;
    const listeners = this.listeners.get(sessionId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(message);
      } catch {
        // Subscriber errors must not break the connection.
      }
    }
  }
}

/** Convenience for tests/CLI: connect and return undefined when no daemon is listening. */
export async function tryConnectSessiond(options: SessiondClientOptions): Promise<SessiondClient | undefined> {
  try {
    return await SessiondClient.connect(options);
  } catch {
    return undefined;
  }
}
