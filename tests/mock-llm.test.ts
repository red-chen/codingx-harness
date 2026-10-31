import { afterEach, describe, expect, it, vi } from 'vitest';
import { startMockServer } from '../src/mock-llm/server.js';
import { builtinScenarios } from '../src/mock-llm/scenarios.js';
import type { MockScenario, MockServer } from '../src/mock-llm/types.js';
import { AnthropicMessagesProvider } from '../src/providers/index.js';
import type { ModelClient, ModelEvent, ModelRequest } from '../src/providers/types.js';
import { ProviderRouter } from '../src/routing/router.js';
import { summarizeDroppedMessages } from '../src/agent/summarize.js';
import { createBuiltinTools } from '../src/tools/index.js';

const servers: MockServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

async function start(options: Parameters<typeof startMockServer>[0] = {}): Promise<MockServer> {
  const server = await startMockServer(options);
  servers.push(server);
  return server;
}

function request(scenario = 'text'): ModelRequest {
  return {
    model: 'mock-' + scenario, system: 'Local mock test.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
    tools: [{ name: 'Read', description: 'Read', inputSchema: { type: 'object' } }],
    maxOutputTokens: 4096, reasoningEffort: 'high',
  };
}

function provider(server: MockServer, requestTimeoutMs = 2000): AnthropicMessagesProvider {
  return new AnthropicMessagesProvider({ id: 'mock', endpoint: server.url, apiKey: 'mock-only', requestTimeoutMs });
}

async function collect(client: ModelClient, req = request(), signal?: AbortSignal): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of client.stream(req, signal)) events.push(event);
  return events;
}

function router(server: MockServer, scenario: string): ProviderRouter {
  return new ProviderRouter({
    routeName: 'default', providers: { mock: provider(server) }, retryBaseDelayMs: 0,
    route: { strategy: 'failover', affinity: 'session', maxAttempts: 3, failureThreshold: 10, cooldownSeconds: 0,
      targets: [{ provider: 'mock', model: 'mock-' + scenario, weight: 1 }] },
  });
}

function text(events: ModelEvent[]): string {
  return events.filter(event => event.type === 'text.delta').map(event => event.text).join('');
}

describe('standalone mock LLM protocol', () => {
  it('streams UTF-8 split at single bytes, CRLF, cache usage and reasoning diagnostics without recording secrets', async () => {
    const server = await start({ chunkBytes: 1, crlf: true });
    const req = request();
    req.messages[0]!.content = [{ type: 'text', text: 'private prompt secret-value' }];
    const events = await collect(provider(server), req);
    expect(text(events)).toContain('中文流式输出 🧪');
    expect(events).toContainEqual({ type: 'usage', inputTokens: 120, outputTokens: 32, cacheReadTokens: 80, cacheCreationTokens: 20 });
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end_turn' });
    const stats = await fetch(server.url + '/stats').then(res => res.json());
    expect(stats).toMatchObject({ requests: 1, recent: [{ effort: 'high', systemCache: true, toolsCache: true }] });
    expect(JSON.stringify(stats)).not.toMatch(/secret-value|mock-only|private prompt/);
    expect(await fetch(server.url + '/health').then(res => res.json())).toMatchObject({ ok: true });
  });

  it('lists scenarios and covers every currently registered tool name', async () => {
    const server = await start();
    expect(await fetch(server.url + '/scenarios').then(res => res.json())).toHaveLength(builtinScenarios.length);
    const names = new Set(builtinScenarios.flatMap(scenario => scenario.steps.flatMap(step => step.tools?.map(tool => tool.name) ?? [])));
    for (const tool of createBuiltinTools()) expect(names.has(tool.name), tool.name).toBe(true);
  });

  it.each([['retry', 3], ['rate-limit', 2]] as const)('retries %s before content and recovers', async (scenario, requests) => {
    const server = await start();
    expect(text(await collect(router(server, scenario), request(scenario)))).toContain('recovered');
    expect(server.records).toHaveLength(requests);
    expect(server.records.at(-1)?.status).toBe(200);
  });

  it.each([
    ['auth', 'auth'], ['overflow', 'context_overflow'],
    ['stream-error', 'server'], ['disconnect', 'protocol'], ['malformed-json', 'protocol'],
  ])('classifies %s without inappropriate retries', async (scenario, category) => {
    const server = await start();
    await expect(collect(router(server, scenario!), request(scenario))).rejects.toMatchObject({ category });
    expect(server.records).toHaveLength(1);
  });

  it.each([['max-tokens', 'max_tokens'], ['refusal', 'refusal']])('emits %s stop reason', async (scenario, reason) => {
    const server = await start();
    expect((await collect(provider(server), request(scenario))).at(-1)).toEqual({ type: 'stop', reason });
  });

  it('cancels delayed responses, enforces idle timeouts and can shut down with a pending response', async () => {
    const server = await start();
    await expect(collect(provider(server, 30), request('slow'))).rejects.toMatchObject({ category: 'timeout' });
    const controller = new AbortController();
    const pending = collect(provider(server), request('slow'), controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    await vi.waitFor(() => expect(server.records).toHaveLength(2));
    controller.abort();
    await assertion;
    await server.close();
  });

  it('supports summary requests separately from a tool scenario', async () => {
    const server = await start();
    const outcome = await summarizeDroppedMessages({
      router: provider(server), messages: request().messages, model: 'mock-files', sessionId: 'summary',
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.summary).toContain('## Open questions');
    expect(server.records[0]?.scenario).toBe('summary');
  });

  it('rejects invalid requests and unknown scenarios without advancing any script', async () => {
    const server = await start();
    expect((await fetch(server.url + '/v1/messages', { method: 'POST', body: '{bad' })).status).toBe(400);
    expect((await fetch(server.url + '/v1/messages', { method: 'POST', body: JSON.stringify({ stream: false }) })).status).toBe(400);
    expect((await fetch(server.url + '/wrong')).status).toBe(404);
    await expect(collect(provider(server), request('missing'))).rejects.toMatchObject({ category: 'bad_request' });
    expect(server.records).toHaveLength(0);
  });

  it('rejects an image scenario without an image', async () => {
    const server = await start();
    await expect(collect(provider(server), request('image'))).rejects.toThrow('requires an image');
    expect(server.records[0]?.status).toBe(409);
  });

  it('bounds request bodies with an explicit 413 response', async () => {
    const server = await start({ maxBodyBytes: 64 });
    const response = await fetch(server.url + '/v1/messages', { method: 'POST', body: 'x'.repeat(1024) });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ type: 'error' });
    expect(server.records).toHaveLength(0);
  });

  it('keeps independent histories deterministic and requires correct tool results before PASS', async () => {
    const scenario: MockScenario = { id: 'custom', description: 'Result checking', steps: [
      { tools: [{ name: 'Read', input: { path: 'hello.txt' }, expect: { isError: false, contains: 'expected-content' } }] },
      { text: 'custom done' },
    ] };
    const server = await start({ scenarios: [scenario] });
    const req = request('custom');
    const first = await collect(provider(server), req);
    const call = first.find(event => event.type === 'tool.call');
    if (!call || call.type !== 'tool.call') throw new Error('missing call');
    expect(await collect(provider(server), req)).toEqual(first);
    req.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }] });
    await expect(collect(provider(server), req)).rejects.toThrow('Expected one tool_result');
    req.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'wrong', is_error: true }] });
    await expect(collect(provider(server), req)).rejects.toThrow('expected is_error=false');
    req.messages.at(-1)!.content = [{ type: 'tool_result', tool_use_id: call.id, content: 'wrong' }];
    await expect(collect(provider(server), req)).rejects.toThrow('expected text');
    req.messages.at(-1)!.content = [{ type: 'tool_result', tool_use_id: call.id, content: 'expected-content' }];
    expect(text(await collect(provider(server), req))).toBe('custom done');
    // A new user message starts a fresh turn; old tools do not advance it.
    req.messages.push({ role: 'user', content: [{ type: 'text', text: '[mock:custom] again' }] });
    expect((await collect(provider(server), req)).some(event => event.type === 'tool.call')).toBe(true);
  });

  it('validates custom scenario files and options before listening', async () => {
    await expect(startMockServer({ scenarios: [builtinScenarios[0]!] })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(startMockServer({ chunkBytes: 0 })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(startMockServer({ scenarios: [{ id: 'bad', description: 'bad', steps: [{ text: 'stop too early' }, { text: 'never' }] }] })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });
});
