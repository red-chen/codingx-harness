import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import {
  AnthropicMessagesProvider,
  SseParser,
  createProvider,
  estimateMessagesTokens,
  resolveMessagesUrl,
} from '../src/providers/index.js';
import type { ModelEvent, ModelRequest } from '../src/providers/index.js';
import { ProviderError } from '../src/util/errors.js';

interface CapturedRequest {
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface TestServer {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

const openServers: TestServer[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server) await server.close();
  }
});

async function startServer(
  handler: (res: ServerResponse, request: CapturedRequest) => void | Promise<void>,
): Promise<TestServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request: CapturedRequest = {
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(request);
      void Promise.resolve(handler(res, request)).catch(() => {
        if (!res.headersSent) res.statusCode = 500;
        res.end('handler failed');
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  const testServer: TestServer = {
    url: 'http://127.0.0.1:' + address.port,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  openServers.push(testServer);
  return testServer;
}

function sse(type: string, data: unknown): string {
  return 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

async function writeChunks(res: ServerResponse, text: string, size = 17): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (let offset = 0; offset < text.length; offset += size) {
    res.write(text.slice(offset, offset + size));
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  res.end();
}

function messageStart(inputTokens = 10, cacheRead = 0, cacheCreation = 0): string {
  return sse('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [],
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0,
        ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
        ...(cacheCreation > 0 ? { cache_creation_input_tokens: cacheCreation } : {}),
      },
    },
  });
}

const textStream =
  messageStart(10, 5, 2) +
  sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  sse('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello' },
  }) +
  sse('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: ', world' },
  }) +
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 3 },
  }) +
  sse('message_stop', { type: 'message_stop' });

const toolStream =
  messageStart(20) +
  sse('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
  }) +
  sse('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"path":' },
  }) +
  sse('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '"src/a.ts"}' },
  }) +
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 4 },
  }) +
  sse('message_stop', { type: 'message_stop' });

function request(): ModelRequest {
  return {
    model: 'claude-test',
    system: 'You are codingx.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [
      { name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
      { name: 'shell', description: 'run', inputSchema: { type: 'object' } },
    ],
    maxOutputTokens: 123,
    temperature: 0,
    sessionId: 'session-1',
  };
}

async function collect(provider: AnthropicMessagesProvider, req = request(), signal?: AbortSignal): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of provider.stream(req, signal)) events.push(event);
  return events;
}

async function collectError(
  provider: AnthropicMessagesProvider,
  req = request(),
): Promise<ProviderError> {
  try {
    for await (const _event of provider.stream(req)) {
      // consume
    }
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error('expected provider to throw');
}

describe('SseParser', () => {
  it('parses events split across chunks and multi-line data', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a":')).toEqual([]);
    expect(parser.push('1}\n\n')).toEqual([{ data: '{"a":1}' }]);

    const crlf = parser.push(': comment\r\nevent: ping\r\nid: 7\r\nretry: 1500\r\ndata: line1\r\ndata: line2\r\n\r\n');
    expect(crlf).toEqual([{ event: 'ping', id: '7', retry: 1500, data: 'line1\nline2' }]);
  });

  it('flushes a final event without a trailing blank line', () => {
    const parser = new SseParser();
    expect(parser.push('data: last')).toEqual([]);
    expect(parser.end()).toEqual([{ data: 'last' }]);
  });

  it('ignores comments and empty dispatches', () => {
    const parser = new SseParser();
    expect(parser.push(': keepalive\n\n')).toEqual([]);
    expect(parser.end()).toEqual([]);
  });
});

describe('AnthropicMessagesProvider streaming', () => {
  it('streams text, usage and stop reason with a properly formed request', async () => {
    const server = await startServer(async (res) => {
      await writeChunks(res, textStream);
    });
    const provider = new AnthropicMessagesProvider({
      id: 'primary',
      endpoint: server.url,
      apiKey: 'test-key',
      requestTimeoutMs: 5_000,
    });
    const events = await collect(provider);

    expect(events.filter((event) => event.type === 'text.delta').map((event) => (event as { text: string }).text).join('')).toBe(
      'Hello, world',
    );
    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 5,
      cacheCreationTokens: 2,
    });
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end_turn' });

    const captured = server.requests[0];
    expect(captured?.url).toBe('/v1/messages');
    expect(captured?.headers['x-api-key']).toBe('test-key');
    expect(captured?.headers['anthropic-version']).toBe('2023-06-01');
    expect(captured?.headers.accept).toBe('text/event-stream');
    const body = JSON.parse(captured?.body ?? '{}');
    expect(body).toMatchObject({ model: 'claude-test', max_tokens: 123, stream: true, temperature: 0 });
    expect(body.system).toEqual([
      { type: 'text', text: 'You are codingx.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.tools).toHaveLength(2);
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools[0].input_schema).toEqual({ type: 'object' });
    expect(captured?.body).not.toContain('test-key');
  });

  it('assembles streamed tool_use input across deltas', async () => {
    const server = await startServer(async (res) => {
      await writeChunks(res, toolStream, 11);
    });
    const provider = new AnthropicMessagesProvider({ id: 'primary', endpoint: server.url, apiKey: 'k' });
    const events = await collect(provider);
    expect(events).toContainEqual({
      type: 'tool.call',
      id: 'toolu_1',
      name: 'read_file',
      input: { path: 'src/a.ts' },
    });
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'tool_use' });
    expect(events.some((event) => event.type === 'usage')).toBe(true);
  });

  it('maps HTTP errors to retryable provider errors', async () => {
    const responses: Array<{ status: number; headers?: Record<string, string>; body: string }> = [
      {
        status: 401,
        body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }),
      },
      {
        status: 429,
        headers: { 'retry-after': '2' },
        body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }),
      },
      {
        status: 500,
        body: JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'oops' } }),
      },
      {
        status: 400,
        body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long' } }),
      },
      {
        status: 400,
        body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'content policy violation' } }),
      },
    ];

    let index = 0;
    const server = await startServer((res) => {
      const current = responses[index++] ?? responses[0];
      if (!current) return;
      res.writeHead(current.status, { 'content-type': 'application/json', ...(current.headers ?? {}) });
      res.end(current.body);
    });

    const provider = new AnthropicMessagesProvider({ id: 'primary', endpoint: server.url, apiKey: 'k' });
    const auth = await collectError(provider);
    expect(auth).toMatchObject({ category: 'auth', status: 401, retryable: false });

    const rate = await collectError(provider);
    expect(rate).toMatchObject({ category: 'rate_limit', status: 429, retryable: true, retryAfterMs: 2_000 });

    const serverError = await collectError(provider);
    expect(serverError).toMatchObject({ category: 'server', status: 500, retryable: true });

    const context = await collectError(provider);
    expect(context).toMatchObject({ category: 'context_overflow', status: 400, retryable: false });

    const policy = await collectError(provider);
    expect(policy).toMatchObject({ category: 'content_policy', status: 400, retryable: false });
  });

  it('throws a provider error from an in-stream error event after yielding text', async () => {
    const server = await startServer(async (res) => {
      await writeChunks(
        res,
        messageStart() +
          sse('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }) +
          sse('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'partial' },
          }) +
          sse('error', {
            type: 'error',
            error: { type: 'overloaded_error', message: 'overloaded' },
          }),
      );
    });
    const provider = new AnthropicMessagesProvider({ id: 'primary', endpoint: server.url, apiKey: 'k' });
    const events: ModelEvent[] = [];
    let caught: ProviderError | undefined;
    try {
      for await (const event of provider.stream(request())) events.push(event);
    } catch (error) {
      caught = error as ProviderError;
    }
    expect(events).toContainEqual({ type: 'text.delta', text: 'partial' });
    expect(caught).toMatchObject({ category: 'server', retryable: true });
  });

  it('fails with a protocol error when message_stop is missing', async () => {
    const server = await startServer(async (res) => {
      await writeChunks(
        res,
        messageStart() +
          sse('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: 'waiting' },
          }) +
          sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
          sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      );
    });
    const provider = new AnthropicMessagesProvider({ id: 'primary', endpoint: server.url, apiKey: 'k' });
    const error = await collectError(provider);
    expect(error).toMatchObject({ category: 'protocol' });
    expect(error.message).toMatch(/message_stop/);
  });

  it('rejects malformed SSE JSON', async () => {
    const server = await startServer(async (res) => {
      await writeChunks(res, 'data: {not-json}\n\n');
    });
    const provider = new AnthropicMessagesProvider({ id: 'primary', endpoint: server.url, apiKey: 'k' });
    const error = await collectError(provider);
    expect(error).toMatchObject({ category: 'protocol' });
  });

  it('aborts the stream on external abort', async () => {
    const server = await startServer((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(messageStart());
    });
    const provider = new AnthropicMessagesProvider({ id: 'primary', endpoint: server.url, apiKey: 'k' });
    const controller = new AbortController();
    const consume = collect(provider, request(), controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(consume).rejects.toMatchObject({ code: 'ABORTED' });
    expect(server.requests).toHaveLength(1);
  });

  it('times out stalled streams', async () => {
    const server = await startServer((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
    });
    const provider = new AnthropicMessagesProvider({
      id: 'primary',
      endpoint: server.url,
      apiKey: 'k',
      requestTimeoutMs: 100,
    });
    const error = await collectError(provider);
    expect(error).toMatchObject({ category: 'timeout', retryable: true });
  });

  it('maps network failures to retryable provider errors', async () => {
    const probe = await startServer((res) => {
      res.end();
    });
    const deadUrl = probe.url;
    await probe.close();
    openServers.splice(openServers.indexOf(probe), 1);
    const provider = new AnthropicMessagesProvider({ id: 'primary', endpoint: deadUrl, apiKey: 'k' });
    const error = await collectError(provider);
    expect(error).toMatchObject({ category: 'network', retryable: true });
  });

  it('estimates tokens locally without a network call', async () => {
    const provider = new AnthropicMessagesProvider({ id: 'primary', endpoint: 'http://127.0.0.1:1', apiKey: 'k' });
    const tokens = await provider.countTokens([{ role: 'user', content: [{ type: 'text', text: 'hello world' }] }]);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('provider factory and endpoint resolution', () => {
  it('resolves /v1/messages endpoints', () => {
    expect(resolveMessagesUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages');
    expect(resolveMessagesUrl('https://api.anthropic.com/')).toBe('https://api.anthropic.com/v1/messages');
    expect(resolveMessagesUrl('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1/messages');
    expect(resolveMessagesUrl('https://api.anthropic.com/v1/messages')).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(resolveMessagesUrl('https://proxy.example.com/anthropic')).toBe(
      'https://proxy.example.com/anthropic/v1/messages',
    );
  });

  it('builds anthropic providers and rejects unsupported protocols', () => {
    const provider = createProvider(
      'primary',
      { protocol: 'anthropic-messages', endpoint: 'https://api.anthropic.com', apiKeyEnv: 'API_KEY' },
      'secret',
    );
    expect(provider).toMatchObject({ id: 'primary', protocol: 'anthropic-messages' });

    expect(() =>
      createProvider(
        'secondary',
        { protocol: 'openai-responses', endpoint: 'https://api.example.com', apiKeyEnv: 'SECONDARY_API_KEY' },
        'secret',
      ),
    ).toThrow(/M4/);

    expect(() =>
      createProvider(
        'primary',
        { protocol: 'anthropic-messages', endpoint: 'https://api.anthropic.com', apiKeyEnv: 'API_KEY' },
        '',
      ),
    ).toThrow(/API key/);
  });

  it('estimates message tokens', () => {
    expect(estimateMessagesTokens([{ role: 'user', content: [{ type: 'text', text: 'hello world' }] }])).toBeGreaterThan(0);
  });
});
