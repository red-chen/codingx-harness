import { describe, expect, it } from 'vitest';
import type { RouteConfig, TargetConfig } from '../src/config/types.js';
import type { ModelEvent, ModelRequest, Provider } from '../src/providers/types.js';
import { ProviderRouter } from '../src/routing/index.js';
import { ProviderError } from '../src/util/errors.js';

interface Attempt {
  events: ModelEvent[];
  error?: Error;
}

class FakeProvider implements Provider {
  readonly id: string;
  readonly protocol = 'anthropic-messages' as const;
  attempts = 0;
  readonly requests: ModelRequest[] = [];
  countCalls = 0;
  private readonly script: Attempt[];

  constructor(id: string, script: Attempt[]) {
    this.id = id;
    this.script = script;
  }

  async countTokens(): Promise<number> {
    this.countCalls += 1;
    return 42;
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
    this.attempts += 1;
    this.requests.push(req);
    const attempt = this.script[Math.min(this.attempts - 1, this.script.length - 1)];
    if (!attempt) return;
    for (const event of attempt.events) yield event;
    if (attempt.error) throw attempt.error;
  }
}

function route(targets: TargetConfig[], overrides: Partial<RouteConfig> = {}): RouteConfig {
  return {
    strategy: 'failover',
    affinity: 'session',
    maxAttempts: 3,
    failureThreshold: 3,
    cooldownSeconds: 30,
    targets,
    ...overrides,
  };
}

function target(provider: string, model: string): TargetConfig {
  return { provider, model, weight: 1 };
}

function request(): ModelRequest {
  return {
    model: 'ignored-by-router',
    system: 'system',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    maxOutputTokens: 100,
  };
}

async function collect(router: ProviderRouter, signal?: AbortSignal): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of router.stream(request(), signal)) events.push(event);
  return events;
}

describe('ProviderRouter selection', () => {
  it('selects a single target and overrides the request model', async () => {
    const primary = new FakeProvider('primary', [{ events: [] }]);
    const router = new ProviderRouter({
      routeName: 'default',
      route: route([target('primary', 'model-a')]),
      providers: { primary },
    });
    expect(router.selection).toMatchObject({
      routeName: 'default',
      providerId: 'primary',
      model: 'model-a',
      strategy: 'failover',
      affinity: 'session',
    });
    await collect(router);
    expect(primary.requests[0]?.model).toBe('model-a');
  });

  it('respects --provider and --model pins', () => {
    const primary = new FakeProvider('primary', [{ events: [] }]);
    const secondary = new FakeProvider('secondary', [{ events: [] }]);
    const multi = route([target('primary', 'model-a'), target('secondary', 'model-b')]);
    const byProvider = new ProviderRouter({
      routeName: 'default',
      route: multi,
      providers: { primary, secondary },
      pins: { provider: 'secondary' },
    });
    expect(byProvider.selection).toMatchObject({ providerId: 'secondary', model: 'model-b' });

    const byModel = new ProviderRouter({
      routeName: 'default',
      route: multi,
      providers: { primary, secondary },
      pins: { model: 'model-b' },
    });
    expect(byModel.selection).toMatchObject({ providerId: 'secondary', model: 'model-b' });

    const override = new ProviderRouter({
      routeName: 'default',
      route: route([target('primary', 'model-a')]),
      providers: { primary },
      pins: { model: 'model-override' },
    });
    expect(override.selection.model).toBe('model-override');
  });

  it('rejects multi-target routes until M5 instead of silently ignoring routing', () => {
    const primary = new FakeProvider('primary', [{ events: [] }]);
    const secondary = new FakeProvider('secondary', [{ events: [] }]);
    expect(
      () =>
        new ProviderRouter({
          routeName: 'weighted',
          route: route([target('primary', 'a'), target('secondary', 'b')], { strategy: 'weighted' }),
          providers: { primary, secondary },
        }),
    ).toThrow(/M1 supports a single provider target/);
  });

  it('rejects unknown pins and missing provider instances', () => {
    const primary = new FakeProvider('primary', [{ events: [] }]);
    expect(
      () =>
        new ProviderRouter({
          routeName: 'default',
          route: route([target('primary', 'a')]),
          providers: { primary },
          pins: { provider: 'nope' },
        }),
    ).toThrow(/not a target/);

    expect(
      () =>
        new ProviderRouter({
          routeName: 'default',
          route: route([target('primary', 'a')]),
          providers: {},
        }),
    ).toThrow(/was not constructed/);
  });
});

describe('ProviderRouter retry semantics', () => {
  it('retries a retryable error before any content and yields terminal events once', async () => {
    const primary = new FakeProvider('primary', [
      { events: [], error: new ProviderError('temporary', { category: 'server', status: 500 }) },
      {
        events: [
          { type: 'text.delta', text: 'recovered' },
          { type: 'usage', inputTokens: 3, outputTokens: 1 },
          { type: 'stop', reason: 'end_turn' },
        ],
      },
    ]);
    const delays: number[] = [];
    const retries: string[] = [];
    const router = new ProviderRouter({
      routeName: 'default',
      route: route([target('primary', 'a')], { maxAttempts: 3 }),
      providers: { primary },
      retryBaseDelayMs: 10,
      sleep: async (delay) => {
        delays.push(delay);
      },
      onRetry: (info) => retries.push(info.providerId + ':' + info.attempt),
    });
    const events = await collect(router);
    expect(primary.attempts).toBe(2);
    expect(delays).toEqual([10]);
    expect(retries).toEqual(['primary:1']);
    expect(events).toEqual([
      { type: 'text.delta', text: 'recovered' },
      { type: 'usage', inputTokens: 3, outputTokens: 1 },
      { type: 'stop', reason: 'end_turn' },
    ]);
  });

  it('does not retry non-retryable errors', async () => {
    const primary = new FakeProvider('primary', [
      { events: [], error: new ProviderError('bad key', { category: 'auth', status: 401 }) },
    ]);
    const router = new ProviderRouter({
      routeName: 'default',
      route: route([target('primary', 'a')]),
      providers: { primary },
      retryBaseDelayMs: 1,
    });
    await expect(collect(router)).rejects.toMatchObject({ category: 'auth' });
    expect(primary.attempts).toBe(1);
  });

  it('never retries after visible content was emitted', async () => {
    const primary = new FakeProvider('primary', [
      {
        events: [{ type: 'text.delta', text: 'partial' }],
        error: new ProviderError('mid-stream failure', { category: 'server' }),
      },
    ]);
    const router = new ProviderRouter({
      routeName: 'default',
      route: route([target('primary', 'a')]),
      providers: { primary },
      retryBaseDelayMs: 1,
    });
    const events: ModelEvent[] = [];
    await expect(
      (async () => {
        for await (const event of router.stream(request())) events.push(event);
      })(),
    ).rejects.toMatchObject({ category: 'server' });
    expect(events).toEqual([{ type: 'text.delta', text: 'partial' }]);
    expect(primary.attempts).toBe(1);
  });

  it('stops after the max attempt budget and does not double-count usage from failed attempts', async () => {
    const primary = new FakeProvider('primary', [
      {
        events: [{ type: 'usage', inputTokens: 100, outputTokens: 1 }],
        error: new ProviderError('first', { category: 'server' }),
      },
      {
        events: [{ type: 'usage', inputTokens: 2, outputTokens: 3 }],
        error: new ProviderError('second', { category: 'server' }),
      },
    ]);
    const delays: number[] = [];
    const router = new ProviderRouter({
      routeName: 'default',
      route: route([target('primary', 'a')], { maxAttempts: 2 }),
      providers: { primary },
      retryBaseDelayMs: 5,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });
    await expect(collect(router)).rejects.toMatchObject({ category: 'server' });
    expect(primary.attempts).toBe(2);
    expect(delays).toEqual([5]);
  });

  it('honors Retry-After and delivers only the successful attempt terminal events', async () => {
    const primary = new FakeProvider('primary', [
      {
        events: [{ type: 'usage', inputTokens: 999, outputTokens: 0 }],
        error: new ProviderError('slow down', { category: 'rate_limit', retryAfterMs: 1_234 }),
      },
      {
        events: [
          { type: 'text.delta', text: 'ok' },
          { type: 'usage', inputTokens: 4, outputTokens: 2 },
          { type: 'stop', reason: 'end_turn' },
        ],
      },
    ]);
    const delays: number[] = [];
    const router = new ProviderRouter({
      routeName: 'default',
      route: route([target('primary', 'a')]),
      providers: { primary },
      retryBaseDelayMs: 99,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });
    const events = await collect(router);
    expect(delays).toEqual([1_234]);
    expect(events.filter((event) => event.type === 'usage')).toEqual([
      { type: 'usage', inputTokens: 4, outputTokens: 2 },
    ]);
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end_turn' });
  });

  it('aborts while waiting to retry', async () => {
    const primary = new FakeProvider('primary', [
      { events: [], error: new ProviderError('temporary', { category: 'server' }) },
      { events: [{ type: 'text.delta', text: 'never' }] },
    ]);
    const router = new ProviderRouter({
      routeName: 'default',
      route: route([target('primary', 'a')], { maxAttempts: 3 }),
      providers: { primary },
      retryBaseDelayMs: 100,
    });
    const controller = new AbortController();
    const consume = collect(router, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await expect(consume).rejects.toMatchObject({ code: 'ABORTED' });
    expect(primary.attempts).toBe(1);
  });

  it('delegates countTokens to the selected provider', async () => {
    const primary = new FakeProvider('primary', [{ events: [] }]);
    const router = new ProviderRouter({
      routeName: 'default',
      route: route([target('primary', 'a')]),
      providers: { primary },
    });
    await expect(router.countTokens([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).resolves.toBe(42);
    expect(primary.countCalls).toBe(1);
  });

  it('yields a successful usage/stop-only stream in order', async () => {
    const primary = new FakeProvider('primary', [
      {
        events: [
          { type: 'usage', inputTokens: 1, outputTokens: 0 },
          { type: 'stop', reason: 'max_tokens' },
        ],
      },
    ]);
    const router = new ProviderRouter({
      routeName: 'default',
      route: route([target('primary', 'a')]),
      providers: { primary },
    });
    await expect(collect(router)).resolves.toEqual([
      { type: 'usage', inputTokens: 1, outputTokens: 0 },
      { type: 'stop', reason: 'max_tokens' },
    ]);
  });
});
