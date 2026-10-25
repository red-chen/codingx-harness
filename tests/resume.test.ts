import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/index.js';
import { SYNTHETIC_TOOL_RESULT } from '../src/agent/index.js';
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
        id: 'msg_resume',
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
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch {
        bodies.push({});
      }
      const response = responses[bodies.length - 1];
      if (!response) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'no response' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(response);
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'codingx-resume-'));
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

async function runWithInput(
  argv: string[],
  home: string,
  workspace: string,
  input: string,
): Promise<{ code: number; stdout: MemorySink; stderr: MemorySink }> {
  const stdin = new PassThrough();
  stdin.end(input);
  const stdout = new MemorySink();
  const stderr = new MemorySink();
  const code = await runCli(argv, { env: envFor(home, workspace), stdin, stdout, stderr });
  return { code, stdout, stderr };
}

function messagesOf(body: Record<string, unknown>): Array<{ role: string; content: Array<Record<string, unknown>> }> {
  return (body.messages ?? []) as Array<{ role: string; content: Array<Record<string, unknown>> }>;
}

describe('session continuation', () => {
  it('continues the most recent session and sends its history on the next turn', async () => {
    const server = await startServer([textResponse('first answer'), textResponse('second answer')]);
    const { home, workspace } = await setup(server.url);

    const first = await runWithInput(['--cd', workspace], home, workspace, 'first request\n/quit\n');
    expect(first.code).toBe(0);
    expect(first.stdout.value).toContain('first answer');

    const store = new EmbeddedSessionStore({ directory: path.join(home, 'sessions') });
    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe('idle');
    const id = sessions[0]?.id;
    if (!id) throw new Error('missing session');

    const second = await runWithInput(
      ['--continue', '--cd', workspace],
      home,
      workspace,
      'second request\n/quit\n',
    );
    expect(second.code).toBe(0);
    expect(second.stdout.value).toContain('second answer');
    expect(second.stderr.value).toContain('resumed session ' + id);

    expect(server.bodies).toHaveLength(2);
    const firstMessages = messagesOf(server.bodies[0] ?? {});
    expect(firstMessages).toHaveLength(1);
    const secondMessages = messagesOf(server.bodies[1] ?? {});
    expect(secondMessages).toHaveLength(3);
    expect(secondMessages[0]?.content).toEqual([{ type: 'text', text: 'first request' }]);
    expect(secondMessages[1]?.content).toEqual([{ type: 'text', text: 'first answer' }]);
    expect(secondMessages[2]?.content).toEqual([{ type: 'text', text: 'second request' }]);

    const after = await store.listSessions();
    expect(after).toHaveLength(1);
    const events = await store.replaySession(id);
    expect(events.filter((event) => event.type === 'user.message')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'turn.end')).toHaveLength(2);
    expect(events.some((event) => event.type === 'session.end')).toBe(false);
  });

  it('resumes by id/prefix into the same session', async () => {
    const server = await startServer([textResponse('base answer'), textResponse('resumed answer')]);
    const { home, workspace } = await setup(server.url);

    const first = await runWithInput(['--cd', workspace], home, workspace, 'base request\n/quit\n');
    expect(first.code).toBe(0);
    const store = new EmbeddedSessionStore({ directory: path.join(home, 'sessions') });
    const id = (await store.listSessions())[0]?.id;
    if (!id) throw new Error('missing session');

    const second = await runWithInput(
      ['--resume', id.slice(0, 6), '--cd', workspace],
      home,
      workspace,
      'resume request\n/quit\n',
    );
    expect(second.code).toBe(0);
    expect(second.stdout.value).toContain('resumed answer');

    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(id);
    expect(server.bodies).toHaveLength(2);
    expect(messagesOf(server.bodies[1] ?? {})).toHaveLength(3);
  });

  it('forks a session into a new rollout and keeps the source intact', async () => {
    const server = await startServer([textResponse('base answer'), textResponse('forked answer')]);
    const { home, workspace } = await setup(server.url);

    const first = await runWithInput(['--cd', workspace], home, workspace, 'base request\n/quit\n');
    expect(first.code).toBe(0);
    const store = new EmbeddedSessionStore({ directory: path.join(home, 'sessions') });
    const sourceId = (await store.listSessions())[0]?.id;
    if (!sourceId) throw new Error('missing source');

    const second = await runWithInput(
      ['--fork', sourceId, '--cd', workspace],
      home,
      workspace,
      'fork request\n/quit\n',
    );
    expect(second.code).toBe(0);
    expect(second.stdout.value).toContain('forked answer');
    expect(second.stderr.value).toContain('resumed session');

    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(2);
    const forkSummary = sessions.find((session) => session.id !== sourceId);
    if (!forkSummary) throw new Error('missing fork');
    const forkEvents = await store.replaySession(forkSummary.id);
    expect(forkEvents[0]).toMatchObject({ type: 'session.start', forkedFrom: sourceId });
    expect(forkEvents.filter((event) => event.type === 'turn.end')).toHaveLength(2);
    expect(server.bodies).toHaveLength(2);
    expect(messagesOf(server.bodies[1] ?? {})).toHaveLength(3);

    const sourceEvents = await store.replaySession(sourceId);
    expect(sourceEvents.filter((event) => event.type === 'turn.end')).toHaveLength(1);
    expect(sourceEvents.some((event) => event.type === 'session.end')).toBe(false);
  });

  it('repairs a dangling tool call before resuming and merges the new prompt', async () => {
    const server = await startServer([textResponse('after repair')]);
    const { home, workspace } = await setup(server.url);
    const store = new EmbeddedSessionStore({ directory: path.join(home, 'sessions') });
    const session = await store.createSession({
      cwd: workspace,
      model: 'test-model',
      provider: 'primary',
      cliVersion: '0.1.0',
    });
    await session.append({ type: 'user.message', text: 'read it' });
    await session.append({ type: 'turn.start', turnId: 'turn-old' });
    await session.append({
      type: 'assistant.message',
      turnId: 'turn-old',
      text: '',
      calls: [{ id: 'call-x', name: 'ReadFile', input: { path: 'src/a.ts' } }],
    });
    await session.append({
      type: 'tool.call',
      turnId: 'turn-old',
      callId: 'call-x',
      name: 'ReadFile',
      input: { path: 'src/a.ts' },
    });
    await session.append({ type: 'turn.aborted', turnId: 'turn-old', reason: 'interrupted' });
    await session.close();

    const result = await runWithInput(
      ['--resume', session.id, '--cd', workspace],
      home,
      workspace,
      'continue\n/quit\n',
    );
    expect(result.code).toBe(0);
    expect(result.stdout.value).toContain('after repair');

    const events = await store.replaySession(session.id);
    const synthetic = events.find(
      (event) => event.type === 'tool.result' && event.callId === 'call-x' && event.synthetic === true,
    );
    expect(synthetic).toMatchObject({ isError: true, content: SYNTHETIC_TOOL_RESULT });

    expect(server.bodies).toHaveLength(1);
    const messages = messagesOf(server.bodies[0] ?? {});
    expect(messages).toHaveLength(3);
    expect(messages[1]?.content).toEqual([
      { type: 'tool_use', id: 'call-x', name: 'ReadFile', input: { path: 'src/a.ts' } },
    ]);
    expect(messages[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call-x', content: SYNTHETIC_TOOL_RESULT, is_error: true },
      { type: 'text', text: 'continue' },
    ]);
  });

  it('rejects conflicting continuation flags', async () => {
    const stdout = new MemorySink();
    const stderr = new MemorySink();
    const code = await runCli(['--continue', '--resume', 'abc'], { stdout, stderr, env: {} });
    expect(code).toBe(2);
    expect(stderr.value).toMatch(/only one of --continue, --resume or --fork/);

    const execOut = new MemorySink();
    const execErr = new MemorySink();
    const execCode = await runCli(['--continue', 'exec', 'hi'], { stdout: execOut, stderr: execErr, env: {} });
    expect(execCode).toBe(2);
    expect(execErr.value).toMatch(/only supported in interactive mode/);
  });
});
