import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  bodies: Array<Record<string, unknown>>;
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
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      bodies.push(parsed);
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
    bodies,
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
    expect(stdout.value).toContain('Commands: /help, /session, /model, /clear, /quit');
    expect(stdout.value).toContain('session: ');
    expect(server.requests).toBe(0);
    const store = new EmbeddedSessionStore({ directory: path.join(home, 'sessions') });
    const sessions = await store.listSessions();
    expect(sessions[0]?.status).toBe('idle');
  });

  it('clears the conversation and rewrites the JSONL rollout on /clear', async () => {
    const server = await startServer([textResponse('First answer.')]);
    const { home, workspace } = await setup(server.url);
    const input = new PassThrough();
    input.end('hello\n/clear\n/quit\n');
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
    expect(server.requests).toBe(1);
    expect(stdout.value).toContain('First answer.');
    expect(stdout.value).toContain('Session cleared');
    const store = new EmbeddedSessionStore({ directory: path.join(home, 'sessions') });
    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ status: 'idle', eventCount: 1 });
    const id = sessions[0]?.id;
    if (!id) throw new Error('missing session');
    const events = await store.replaySession(id);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('session.start');
    const raw = await readFile(sessions[0]!.filePath, 'utf8');
    expect(raw).not.toContain('First answer.');
    expect(raw).not.toContain('hello');
  });

  it('changes model and effort with /model and restores them on resume', async () => {
    const server = await startServer([textResponse('First answer.'), textResponse('Second answer.')]);
    const { home, workspace } = await setup(server.url);
    const env = envFor(home, workspace);

    const firstInput = new PassThrough();
    firstInput.end('first\n/model model-b high\n/quit\n');
    const firstStdout = new MemorySink();
    const firstStderr = new MemorySink();
    const firstCode = await runInteractive({
      cwd: workspace,
      env,
      stdin: firstInput,
      stdout: firstStdout,
      stderr: firstStderr,
    });

    expect(firstCode).toBe(0);
    expect(server.requests).toBe(1);
    expect(firstStdout.value).toContain('First answer.');
    expect(firstStdout.value).toContain('model: model-b');
    expect(firstStdout.value).toContain('effort: high');
    expect(server.bodies[0]).toMatchObject({ model: 'test-model' });
    expect(server.bodies[0]).not.toHaveProperty('output_config');

    const store = new EmbeddedSessionStore({ directory: path.join(home, 'sessions') });
    const sessions = await store.listSessions();
    const id = sessions[0]?.id;
    if (!id) throw new Error('missing session');
    const events = await store.replaySession(id);
    expect(events.find((event) => event.type === 'model.changed')).toMatchObject({
      model: 'model-b',
      reasoningEffort: 'high',
    });

    const secondInput = new PassThrough();
    secondInput.end('second\n/quit\n');
    const secondStdout = new MemorySink();
    const secondStderr = new MemorySink();
    const secondCode = await runInteractive({
      cwd: workspace,
      env,
      resumeSessionId: id,
      stdin: secondInput,
      stdout: secondStdout,
      stderr: secondStderr,
    });

    expect(secondCode).toBe(0);
    expect(server.requests).toBe(2);
    expect(secondStdout.value).toContain('Second answer.');
    expect(server.bodies[1]).toMatchObject({
      model: 'model-b',
      output_config: { effort: 'high' },
    });
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
    expect(stderr.value).toContain('Commands: /help, /session, /model, /clear, /quit');
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
      calls: [{ id: 'call-1', name: 'ReadFile', input: { path: 'a.ts' } }],
    });
    await session.append({
      type: 'tool.call',
      turnId: 'turn-1',
      callId: 'call-1',
      name: 'ReadFile',
      input: { path: 'a.ts' },
    });
    await session.append({
      type: 'tool.result',
      turnId: 'turn-1',
      callId: 'call-1',
      name: 'ReadFile',
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
    expect(humanOut.value).toContain('ReadFile');
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