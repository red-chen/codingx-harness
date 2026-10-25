import type { RouteConfig, TargetConfig } from '../config/types.js';
import { abortError, ConfigError, ProviderError, UnsupportedError } from '../util/errors.js';
import type { Message, ModelClient, ModelEvent, ModelRequest, Provider, TokenUsage } from '../providers/types.js';

export interface RouterPins {
  provider?: string;
  model?: string;
}

export interface RouterSelection {
  routeName: string;
  providerId: string;
  model: string;
  strategy: RouteConfig['strategy'];
  affinity: RouteConfig['affinity'];
  target: TargetConfig;
}

export interface RouterRetryInfo {
  attempt: number;
  providerId: string;
  model: string;
  delayMs: number;
  error: ProviderError;
}

export type SleepFunction = (delayMs: number, signal?: AbortSignal) => Promise<void>;

export interface ProviderRouterOptions {
  routeName: string;
  route: RouteConfig;
  providers: Record<string, Provider>;
  pins?: RouterPins;
  /** Test hook; defaults to a 250ms exponential backoff. */
  retryBaseDelayMs?: number;
  maxRetryDelayMs?: number;
  sleep?: SleepFunction;
  onRetry?: (info: RouterRetryInfo) => void;
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function selectRouteTarget(routeName: string, route: RouteConfig, pins: RouterPins | undefined): TargetConfig {
  let candidates = [...route.targets];
  if (candidates.length === 0) {
    throw new ConfigError('Route "' + routeName + '" has no targets.');
  }

  if (pins?.provider) {
    candidates = candidates.filter((target) => target.provider === pins.provider);
    if (candidates.length === 0) {
      throw new ConfigError(
        'Provider "' + pins.provider + '" is not a target of route "' + routeName + '". ' +
          'Available providers: ' + route.targets.map((target) => target.provider).join(', ') + '.',
      );
    }
  }

  if (pins?.model) {
    const exact = candidates.filter((target) => target.model === pins.model);
    if (exact.length === 1) {
      candidates = exact;
    } else if (exact.length > 1) {
      candidates = exact;
    }
  }

  if (candidates.length > 1) {
    throw new UnsupportedError(
      'M1 supports a single provider target, but route "' + routeName + '" resolves to ' + candidates.length +
        ' targets (' + candidates.map((target) => target.provider + '/' + target.model).join(', ') + '). ' +
        'Pin one with --provider or --model, or configure a single [[routes.' + routeName + '.targets]]. ' +
        'Full failover/weighted/round-robin routing arrives in M5.',
    );
  }

  const target = candidates[0];
  if (!target) throw new ConfigError('Route "' + routeName + '" has no usable targets.');
  return target;
}

/**
 * Single-target router with retry-before-content. Multi-target selection is
 * intentionally rejected until M5 so M1 never silently ignores configured
 * failover/weights.
 */
export class ProviderRouter implements ModelClient {
  readonly selection: RouterSelection;
  private readonly provider: Provider;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly sleep: SleepFunction;
  private readonly onRetry: ((info: RouterRetryInfo) => void) | undefined;

  constructor(options: ProviderRouterOptions) {
    const target = selectRouteTarget(options.routeName, options.route, options.pins);
    const provider = options.providers[target.provider];
    if (!provider) {
      throw new ConfigError(
        'Provider "' + target.provider + '" is referenced by route "' + options.routeName + '" but was not constructed.',
      );
    }
    this.provider = provider;
    this.selection = {
      routeName: options.routeName,
      providerId: target.provider,
      model: options.pins?.model ?? target.model,
      strategy: options.route.strategy,
      affinity: options.route.affinity,
      target,
    };
    this.maxAttempts = Math.max(1, options.route.maxAttempts);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 250);
    this.maxRetryDelayMs = Math.max(0, options.maxRetryDelayMs ?? 30_000);
    this.sleep = options.sleep ?? defaultSleep;
    this.onRetry = options.onRetry;
  }

  get providerId(): string {
    return this.selection.providerId;
  }

  get model(): string {
    return this.selection.model;
  }

  async countTokens(messages: Message[]): Promise<number> {
    return this.provider.countTokens(messages);
  }

  async *stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    if (signal?.aborted) throw abortError();
    const targetRequest: ModelRequest = { ...req, model: this.selection.model };
    let contentEmitted = false;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (signal?.aborted) throw abortError();
      const pending: ModelEvent[] = [];
      const iterator = this.provider.stream(targetRequest, signal)[Symbol.asyncIterator]();
      try {
        for (;;) {
          if (signal?.aborted) throw abortError();
          const next = await iterator.next();
          if (next.done) break;
          const event = next.value;
          if (event.type === 'text.delta' || event.type === 'tool.call') {
            contentEmitted = true;
            yield event;
          } else {
            pending.push(event);
          }
        }
        for (const event of pending) yield event;
        return;
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (contentEmitted) throw error;
        const providerError =
          error instanceof ProviderError
            ? error
            : new ProviderError('Provider stream failed: ' + (error instanceof Error ? error.message : String(error)), {
                category: 'protocol',
                retryable: false,
                cause: error,
              });
        if (!providerError.retryable) throw providerError;
        if (attempt >= this.maxAttempts) throw providerError;

        const delayMs = Math.min(
          providerError.retryAfterMs ?? this.retryBaseDelayMs * 2 ** (attempt - 1),
          this.maxRetryDelayMs,
        );
        try {
          this.onRetry?.({
            attempt,
            providerId: this.selection.providerId,
            model: this.selection.model,
            delayMs,
            error: providerError,
          });
        } catch {
          // Audit callbacks must not break routing.
        }
        await this.sleep(delayMs, signal);
      } finally {
        await iterator.return?.().catch(() => undefined);
      }
    }
  }
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}
