import { EmbeddedSessionStore } from '../session/embedded-store.js';
import { SessiondRegistry } from './registry.js';
import { SessiondServer } from './server.js';

export interface SessiondDaemonOptions {
  socketPath: string;
  sessionDir: string;
  version?: string;
  /** Exit after this long with no clients; 0 disables idle exit. Defaults to 30 minutes. */
  idleTimeoutMs?: number;
  onReady?: (daemon: SessiondDaemon) => void;
}

/**
 * Owns one daemon instance: embedded persistence, registry recovery, socket
 * server and idle shutdown. The process entry adds signal handling.
 */
export class SessiondDaemon {
  readonly store: EmbeddedSessionStore;
  readonly registry: SessiondRegistry;
  readonly server: SessiondServer;
  private readonly idleTimeoutMs: number;
  private idleTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private stopPromise: Promise<void> | undefined;
  private readonly stoppedPromise: Promise<void>;
  private resolveStopped!: () => void;

  private constructor(
    store: EmbeddedSessionStore,
    registry: SessiondRegistry,
    server: SessiondServer,
    idleTimeoutMs: number,
  ) {
    this.store = store;
    this.registry = registry;
    this.server = server;
    this.idleTimeoutMs = idleTimeoutMs;
    this.stoppedPromise = new Promise<void>((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  static async start(options: SessiondDaemonOptions): Promise<SessiondDaemon> {
    const store = new EmbeddedSessionStore({ directory: options.sessionDir });
    const registry = new SessiondRegistry({ store });
    await registry.recover();
    let daemon: SessiondDaemon | undefined;
    const server = new SessiondServer({
      registry,
      socketPath: options.socketPath,
      ...(options.version ? { version: options.version } : {}),
      onConnectionChange: (count) => daemon?.handleConnectionChange(count),
    });
    await server.listen();
    daemon = new SessiondDaemon(store, registry, server, Math.max(0, options.idleTimeoutMs ?? 30 * 60_000));
    daemon.scheduleIdle();
    options.onReady?.(daemon);
    return daemon;
  }

  get socketPath(): string {
    return this.server.address;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  handleConnectionChange(count: number): void {
    if (count > 0) {
      this.clearIdle();
    } else {
      this.scheduleIdle();
    }
  }

  /** Resolves when idle timeout, signal or close has stopped the daemon. */
  wait(): Promise<void> {
    return this.stoppedPromise;
  }

  async stop(reason = 'requested'): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.clearIdle();
    this.stopPromise = (async () => {
      await this.server.close().catch(() => undefined);
      await this.registry.shutdown(true).catch(() => undefined);
      void reason;
      this.resolveStopped();
    })();
    return this.stopPromise;
  }

  private scheduleIdle(): void {
    if (this.stopped || this.idleTimeoutMs <= 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.stop('idle');
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}
