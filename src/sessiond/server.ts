import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import type { Server, Socket } from 'node:net';
import path from 'node:path';
import { canonicalizePath } from '../util/paths.js';
import {
  METHOD,
  NOTIFICATION,
  SESSIOND_METHODS,
  SESSIOND_PROTOCOL_VERSION,
  SessiondRpcError,
  type InitializeParams,
  type InitializeResult,
  type DaemonStatusResult,
  type SessionAppendParams,
  type SessionAttachParams,
  type SessionClearParams,
  type SessionCreateParams,
  type SessionEndParams,
  type SessionForkParams,
  type SessionHeartbeatParams,
  type SessionListParams,
  type SessionPruneParams,
  type SessionReplayParams,
  type SessionSubscribeParams,
} from './protocol.js';
import { JsonRpcPeer } from './transport.js';
import type { SessiondRegistry, Subscription } from './registry.js';

export interface SessiondServerOptions {
  registry: SessiondRegistry;
  socketPath: string;
  version?: string;
  /** Maximum simultaneous connections; defaults to 64. */
  maxConnections?: number;
  onConnectionChange?: (count: number) => void;
}

interface PeerState {
  clientId: string;
  initialized: boolean;
  cwd?: string;
  closed: boolean;
  clientName?: string;
  subscriptions: Subscription[];
  peer?: JsonRpcPeer;
}

function objectParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessiondRpcError('INVALID_PARAMS', 'Method params must be an object.');
  }
  return value as Record<string, unknown>;
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new SessiondRpcError('INVALID_PARAMS', 'Parameter "' + key + '" must be a non-empty string.');
  }
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new SessiondRpcError('INVALID_PARAMS', 'Parameter "' + key + '" must be a string.');
  return value;
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SessiondRpcError('INVALID_PARAMS', 'Parameter "' + key + '" must be a number.');
  }
  return value;
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const active = await new Promise<boolean>((resolve) => {
    const probe = connect(socketPath);
    const done = (value: boolean): void => {
      probe.destroy();
      resolve(value);
    };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
  });
  if (active) {
    throw new SessiondRpcError('SESSION_BUSY', 'Another sessiond is already listening on ' + socketPath + '.');
  }
  await unlink(socketPath).catch(() => undefined);
}

/**
 * Unix-socket JSON-RPC daemon shell. Transport/authorization details stay in
 * JsonRpcPeer; session state and leases live in SessiondRegistry.
 */
export class SessiondServer {
  private readonly registry: SessiondRegistry;
  private readonly socketPath: string;
  private readonly version: string;
  private readonly maxConnections: number;
  private readonly onConnectionChange: ((count: number) => void) | undefined;
  private readonly startedAt = new Date().toISOString();
  private readonly peers = new Map<Socket, PeerState>();
  private server: Server | undefined;
  private listening = false;
  private closing = false;

  constructor(options: SessiondServerOptions) {
    this.registry = options.registry;
    this.socketPath = path.resolve(options.socketPath);
    this.version = options.version ?? '0.1.0';
    this.maxConnections = Math.max(1, options.maxConnections ?? 64);
    this.onConnectionChange = options.onConnectionChange;
  }

  get address(): string {
    return this.socketPath;
  }

  get isListening(): boolean {
    return this.listening;
  }

  get connectionCount(): number {
    return this.peers.size;
  }

  async listen(): Promise<void> {
    if (this.listening) return;
    const directory = path.dirname(this.socketPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    await removeStaleSocket(this.socketPath);

    const server = createServer((socket) => this.accept(socket));
    server.maxConnections = this.maxConnections;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(
          new SessiondRpcError(
            'SESSION_BUSY',
            'Cannot listen on ' + this.socketPath + ': ' + error.message,
            { cause: error.message },
          ),
        );
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.socketPath);
    });
    await chmod(this.socketPath, 0o600).catch(() => undefined);
    server.on('error', () => undefined);
    this.listening = true;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const [socket, state] of this.peers) {
      this.cleanupPeer(socket, state);
    }
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.listening = false;
    await unlink(this.socketPath).catch(() => undefined);
  }

  private accept(socket: Socket): void {
    if (this.closing) {
      socket.destroy();
      return;
    }
    if (this.peers.size >= this.maxConnections) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    const state: PeerState = {
      clientId: randomUUID(),
      initialized: false,
      closed: false,
      subscriptions: [],
    };
    const peer = new JsonRpcPeer({
      stream: socket,
      onRequest: (request) => this.handleRequest(state, request.method, request.params),
      onNotification: () => {
        // Clients currently have no notifications the daemon must handle.
      },
    });
    state.peer = peer;
    this.peers.set(socket, state);
    this.notifyConnectionChange();
    socket.on('close', () => this.cleanupPeer(socket, state));
  }

  private cleanupPeer(socket: Socket, state: PeerState): void {
    if (state.closed) return;
    state.closed = true;
    this.peers.delete(socket);
    this.notifyConnectionChange();
    for (const subscription of state.subscriptions) {
      subscription.unsubscribe();
    }
    state.subscriptions = [];
    void this.registry.disconnectClient(state.clientId).catch(() => undefined);
    state.peer?.close();
  }

  private async handleRequest(state: PeerState, method: string, rawParams: unknown): Promise<unknown> {
    if (method === METHOD.initialize) {
      return this.initialize(state, rawParams);
    }
    if (!state.initialized) {
      throw new SessiondRpcError('PROTOCOL_MISMATCH', 'Client must call initialize before other methods.');
    }
    const params = objectParams(rawParams);

    if (state.cwd !== undefined && method.startsWith('session.')) {
      if (method === METHOD.sessionCreate && await canonicalizePath(requireString(params, 'cwd')) !== state.cwd) {
        throw new SessiondRpcError('INVALID_PARAMS', 'Session cwd does not match the current workspace.');
      }
      if (typeof params.sessionId === 'string') {
        params.sessionId = await this.registry.resolveForCwd(params.sessionId, state.cwd);
      }
      if (method === METHOD.sessionList || method === METHOD.sessionPrune) params.cwd = state.cwd;
    }

    switch (method) {
      case METHOD.daemonStatus:
        return this.daemonStatus();
      case METHOD.daemonShutdown: {
        const force = params.force === true;
        await this.registry.shutdown(force);
        setImmediate(() => {
          void this.close();
        });
        return { ok: true };
      }
      case METHOD.sessionCreate: {
        const createParams: SessionCreateParams = {
          cwd: requireString(params, 'cwd'),
          model: requireString(params, 'model'),
          cliVersion: requireString(params, 'cliVersion'),
          ...(optionalString(params, 'provider') ? { provider: optionalString(params, 'provider') } : {}),
          ...(optionalString(params, 'requestId') ? { requestId: optionalString(params, 'requestId') } : {}),
        };
        return this.registry.create(state.clientId, createParams);
      }
      case METHOD.sessionList: {
        const listParams: SessionListParams = {
          ...(optionalString(params, 'cwd') ? { cwd: optionalString(params, 'cwd') } : {}),
          ...(optionalString(params, 'status') ? { status: optionalString(params, 'status') as SessionListParams['status'] } : {}),
          ...(optionalNumber(params, 'limit') === undefined ? {} : { limit: optionalNumber(params, 'limit') }),
          ...(optionalString(params, 'cursor') ? { cursor: optionalString(params, 'cursor') } : {}),
        };
        return this.registry.list(listParams);
      }
      case METHOD.sessionGet:
        return this.registry.get(requireString(params, 'sessionId'));
      case METHOD.sessionAttach: {
        const mode = requireString(params, 'mode');
        if (mode !== 'write' && mode !== 'observe') {
          throw new SessiondRpcError('INVALID_PARAMS', 'mode must be "write" or "observe".');
        }
        const attachParams: SessionAttachParams = { sessionId: requireString(params, 'sessionId'), mode };
        return this.registry.attach(state.clientId, attachParams);
      }
      case METHOD.sessionDetach:
        await this.registry.detach(
          state.clientId,
          requireString(params, 'sessionId'),
          optionalString(params, 'leaseId'),
        );
        return { ok: true };
      case METHOD.sessionHeartbeat: {
        const heartbeatParams: SessionHeartbeatParams = {
          sessionId: requireString(params, 'sessionId'),
          leaseId: requireString(params, 'leaseId'),
        };
        return this.registry.heartbeat(state.clientId, heartbeatParams);
      }
      case METHOD.sessionAppend: {
        const events = params.events;
        if (!Array.isArray(events)) {
          throw new SessiondRpcError('INVALID_PARAMS', 'events must be an array.');
        }
        const appendParams: SessionAppendParams = {
          sessionId: requireString(params, 'sessionId'),
          ...(optionalString(params, 'leaseId') ? { leaseId: optionalString(params, 'leaseId') } : {}),
          events: events as SessionAppendParams['events'],
        };
        return this.registry.append(state.clientId, appendParams);
      }
      case METHOD.sessionClear: {
        const clearParams: SessionClearParams = {
          sessionId: requireString(params, 'sessionId'),
          ...(optionalString(params, 'leaseId') ? { leaseId: optionalString(params, 'leaseId') } : {}),
        };
        return this.registry.clear(state.clientId, clearParams);
      }
      case METHOD.sessionReplay: {
        const replayParams: SessionReplayParams = {
          sessionId: requireString(params, 'sessionId'),
          ...(optionalNumber(params, 'fromSeq') === undefined ? {} : { fromSeq: optionalNumber(params, 'fromSeq') }),
          ...(optionalNumber(params, 'limit') === undefined ? {} : { limit: optionalNumber(params, 'limit') }),
        };
        return this.registry.replay(replayParams);
      }
      case METHOD.sessionSubscribe: {
        const subscribeParams: SessionSubscribeParams = {
          sessionId: requireString(params, 'sessionId'),
          ...(optionalNumber(params, 'fromSeq') === undefined ? {} : { fromSeq: optionalNumber(params, 'fromSeq') }),
        };
        const subscription = await this.registry.subscribe(
          state.clientId,
          subscribeParams,
          (message) => {
            state.peer?.notify(message.method, message.params);
          },
        );
        state.subscriptions.push(subscription);
        if (subscription.backlog.length > 0) {
          state.peer?.notify(NOTIFICATION.event, {
            sessionId: subscription.sessionId,
            events: subscription.backlog,
          });
        }
        state.peer?.notify(NOTIFICATION.status, {
          sessionId: subscription.sessionId,
          status: subscription.status,
        });
        return {
          sessionId: subscription.sessionId,
          fromSeq: subscribeParams.fromSeq ?? 1,
        };
      }
      case METHOD.sessionFork: {
        const forkParams: SessionForkParams = {
          sessionId: requireString(params, 'sessionId'),
          ...(optionalNumber(params, 'fromSeq') === undefined ? {} : { fromSeq: optionalNumber(params, 'fromSeq') }),
          ...(optionalString(params, 'cliVersion') ? { cliVersion: optionalString(params, 'cliVersion') } : {}),
        };
        return this.registry.fork(state.clientId, forkParams);
      }
      case METHOD.sessionEnd: {
        const endParams: SessionEndParams = {
          sessionId: requireString(params, 'sessionId'),
          ...(optionalString(params, 'leaseId') ? { leaseId: optionalString(params, 'leaseId') } : {}),
          ...(optionalString(params, 'reason') ? { reason: optionalString(params, 'reason') } : {}),
        };
        await this.registry.end(state.clientId, endParams);
        return { ok: true };
      }
      case METHOD.sessionPrune: {
        const pruneParams: SessionPruneParams = {
          ...(optionalString(params, 'cwd') ? { cwd: optionalString(params, 'cwd') } : {}),
          ...(optionalNumber(params, 'olderThanDays') === undefined ? {} : { olderThanDays: optionalNumber(params, 'olderThanDays') }),
          ...(params.dryRun === true ? { dryRun: true } : {}),
        };
        return this.registry.prune(pruneParams);
      }
      default:
        throw new SessiondRpcError('METHOD_NOT_FOUND', 'Unknown method: ' + method);
    }
  }

  private notifyConnectionChange(): void {
    try {
      this.onConnectionChange?.(this.peers.size);
    } catch {
      // Lifecycle callbacks must not break the transport.
    }
  }

  private async initialize(state: PeerState, rawParams: unknown): Promise<InitializeResult> {
    const params = objectParams(rawParams);
    const protocol = optionalNumber(params, 'protocol');
    if (protocol === undefined) {
      throw new SessiondRpcError('INVALID_PARAMS', 'initialize requires a numeric protocol version.');
    }
    if (protocol !== SESSIOND_PROTOCOL_VERSION) {
      throw new SessiondRpcError(
        'PROTOCOL_MISMATCH',
        'Protocol mismatch: client ' + protocol + ', daemon ' + SESSIOND_PROTOCOL_VERSION + '.',
        { expected: SESSIOND_PROTOCOL_VERSION, actual: protocol },
      );
    }
    const client = params.client;
    if (typeof client === 'object' && client !== null && !Array.isArray(client)) {
      const name = (client as Record<string, unknown>).name;
      if (typeof name === 'string') state.clientName = name;
    }
    const cwd = optionalString(params, 'cwd');
    if (cwd !== undefined) state.cwd = await canonicalizePath(cwd);
    state.initialized = true;
    return {
      protocol: SESSIOND_PROTOCOL_VERSION,
      version: this.version,
      pid: process.pid,
      startedAt: this.startedAt,
      sessionCount: await this.registry.countSessions(),
      methods: SESSIOND_METHODS,
      cwdIsolation: true,
      workspaceLayout: 'readable-v1',
    };
  }

  private async daemonStatus(): Promise<DaemonStatusResult> {
    return {
      pid: process.pid,
      socket: this.socketPath,
      protocol: SESSIOND_PROTOCOL_VERSION,
      version: this.version,
      startedAt: this.startedAt,
      sessionCount: await this.registry.countSessions(),
      connectionCount: this.peers.size,
    };
  }
}
