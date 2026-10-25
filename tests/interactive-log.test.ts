import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { runInteractive } from '../src/cli/commands/interactive.js';
import { runLog } from '../src/cli/commands/log.js';
import { runCli } from '../src/cli/index.js';
import { EmbeddedSessionStore } from '../src/session/index.js';
import type { TextSink } from '../src/ui/plain.js';

class MemorySink implements TextSink {
  value = '';
  write(text: string): boolean {
    this.value += text;
    return true;
  }
}

interface FakeServer {
  url: string;
  requests: number;
  close(): Promise<void>;
}

const servers: FakeServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await server.close();
  }
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

function sse(type: string, data: unknown): string {
  return 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

function textResponse(text: string): string {
  return (
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_t14',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [],
        usage: { input_tokens: 4, output_tokens: 0 },
      },
    }) +
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }) +
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }) +
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    }) +
    sse('message_stop', { type: 'message_stop' })
  );
}

async function startServer(responses: string[]): Promise<FakeServer> {
  let requestCount = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const index = requestCount++;
      const body = responses[index];
      if (!body) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'unexpected request' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  const fake: FakeServer = {
    url: 'http://127.0.0.1:' + address.port,
    get requests() {
      return requestCount;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  servers.push(fake);
  return fake;
}

async function setup(serverUrl: string): Promise<{ home: string; workspace: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codingx-t14-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(home, 'config.toml'),
    `
[provider.primary]
protocol = "anthropic-messages"
endpoint = "${serverUrl}"
api_key_env = "TEST_API_KEY"

[model]
route = "default"
max_output_tokens = 1024
temperature = 0

[routes.default]
strategy = "failover"
affinity = "session"
max_attempts = 1
[[routes.default.targets]]
provider = "primary"
model = "test-model"

[sessiond]
enabled = false

[tools]
max_output_chars = 30000
`,
  );
  return { home, workspace };
}

function envFor(home: string, workspace: string): NodeJS.ProcessEnv {
  return {
    CODINGX_HOME: home,
    TEST_API_KEY: 'test-key',
    PATH: process.env.PATH ?? '',
    HOME: workspace,
    LANG: process.env.LANG ?? 'C',
    TERM: process.env.TERM ?? 'dumb',
  };
}

describe('interactive mode', () => {
  it('runs multiple turns and keeps the session open for replay', async () => {
    const server = await startServer([textResponse('First answer.'), textResponse('Second answer.')]);
    const { home, workspace } = await setup(server.url);
    const input = new PassThrough();
    input.end('hello\nsecond\n');
    const stdout = new MemorySink();
    const stderr = new MemorySink();

    const code = await runInteractive({
      cwd: workspace,
      env: envFor(home, workspace),
      stdin: input,
      stdout,
      stderr,
      json: false,
    });

    expect(code).toBe(0);
    expect(stdout.value).toContain('First answer.');
    expect(stdout.value).toContain('Second answer.');
    expect(stdout.value).toContain('› ');
    expect(server.requests).toBe(2);

    const store = new EmbeddedSessionStore({ directory: path.join(home, 'sessions') });
    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe('idle');
    const id = sessions[0]?.id;
    if (!id) throw new Error('missing session');
    const events = await store.replaySession(id);
    expect(events.some((event) => event.type === 'session.end')).toBe(false);
    expect(events.filter((event) => event.type === 'turn.end')).toHaveLength(2);

    const reopened = await store.attachSession(id, 'write');
    await reopened.close();
  });

  it('supports /help, /session and /quit without calling the provider', async () => {
    const server = await startServer([]);
    const { home, workspace } = await setup(server.url);
    const input = new PassThrough();
    input.end('/help\n/session\n/quit\n');
    const stdout = new MemorySink();
    const stderr = new MemorySink();

    const code = await runInteractive({
      cwd: workspace,
      env: envFor(home, workspace),
      stdin: input,
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(stdout.value).toContain('Commands: /help, /session, /quit');
    expect(stdout.value).toContain('session: ');
    expect(server.requests).toBe(0);
    const store = new EmbeddedSessionStore({ directory: path.join(home, 'sessions') });
    const sessions = await store.listSessions();
    expect(sessions[0]?.status).toBe('idle');
  });

  it('keeps JSON stdout machine-readable for slash commands', async () => {
    const server = await startServer([]);
    const { home, workspace } = await setup(server.url);
    const input = new PassThrough();
    input.end('/help\n/session\n/quit\n');
    const stdout = new MemorySink();
    const stderr = new MemorySink();

    const code = await runInteractive({
      cwd: workspace,
      env: envFor(home, workspace),
      stdin: input,
      stdout,
      stderr,
      json: true,
    });

    expect(code).toBe(0);
    expect(server.requests).toBe(0);
    const lines = stdout.value.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: 'session.info' });
    expect(stderr.value).toContain('Commands: /help, /session, /quit');
    expect(stderr.value).toContain('session: ');
  });

  it('runs an initial prompt and supports JSON event output', async () => {
    const server = await startServer([textResponse('Initial answer.')]);
    const { home, workspace } = await setup(server.url);
    const input = new PassThrough();
    input.end();
    const stdout = new MemorySink();
    const stderr = new MemorySink();

    const code = await runInteractive({
      cwd: workspace,
      initialPrompt: 'start working',
      env: envFor(home, workspace),
      stdin: input,
      stdout,
      stderr,
      json: true,
    });

    expect(code).toBe(0);
    expect(server.requests).toBe(1);
    const lines = stdout.value.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toEqual([
      'session.info',
      'turn.started',
      'context.updated',
      'text.delta',
      'llm.finished',
      'usage.updated',
      'turn.finished',
    ]);
    expect(lines.find((line) => line.type === 'text.delta')).toMatchObject({ type: 'text.delta', text: 'Initial answer.' });
    expect(stderr.value).toContain('› ');
  });
});

describe('log replay', () => {
  async function createRecordedSession(): Promise<{ home: string; workspace: string; id: string }> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codingx-log-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const store = new EmbeddedSessionStore({ directory: path.join(home, 'sessions') });
    const session = await store.createSession({
      cwd: workspace,
      model: 'test-model',
      provider: 'primary',
      cliVersion: '0.1.0',
    });
    await session.append({ type: 'user.message', text: 'hello log' });
    await session.append({ type: 'turn.start', turnId: 'turn-1' });
    await session.append({
      type: 'assistant.message',
      turnId: 'turn-1',
      text: 'reading a file',
      calls: [{ id: 'call-1', name: 'read_file', input: { path: 'a.ts' } }],
    });
    await session.append({
      type: 'tool.call',
      turnId: 'turn-1',
      callId: 'call-1',
      name: 'read_file',
      input: { path: 'a.ts' },
    });
    await session.append({
      type: 'tool.result',
      turnId: 'turn-1',
      callId: 'call-1',
      name: 'read_file',
      content: '1\tconst a = 1;',
      isError: false,
    });
    await session.append({
      type: 'turn.end',
      turnId: 'turn-1',
      status: 'done',
      usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
      steps: 1,
    });
    await session.close();
    return { home, workspace, id: session.id };
  }

  it('replays events in human and JSON forms and resolves prefixes', async () => {
    const { home, workspace, id } = await createRecordedSession();
    const humanOut = new MemorySink();
    const code = await runLog({
      sessionId: id.slice(0, 6),
      cwd: workspace,
      env: { CODINGX_HOME: home },
      stdout: humanOut,
      stderr: new MemorySink(),
    });
    expect(code).toBe(0);
    expect(humanOut.value).toContain('session.start');
    expect(humanOut.value).toContain('hello log');
    expect(humanOut.value).toContain('reading a file');
    expect(humanOut.value).toContain('tool.call');
    expect(humanOut.value).toContain('read_file');
    expect(humanOut.value).toContain('status=done');

    const jsonOut = new MemorySink();
    const jsonCode = await runCli(['--cd', workspace, '--json', 'log', '--session', id.slice(0, 6)], {
      env: { CODINGX_HOME: home },
      stdout: jsonOut,
      stderr: new MemorySink(),
    });
    expect(jsonCode).toBe(0);
    const events = jsonOut.value.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ type: 'session.start', model: 'test-model' });
    expect(events.map((event: { type: string }) => event.type)).toContain('tool.result');
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', status: 'done' });
  });
});