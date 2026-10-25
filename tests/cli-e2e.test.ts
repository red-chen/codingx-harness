import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runExec } from '../src/cli/commands/exec.js';
import { runCli } from '../src/cli/index.js';
import { EmbeddedSessionStore } from '../src/session/index.js';
import { VERSION } from '../src/version.js';
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

const openServers: FakeServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
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

function messageStart(): string {
  return sse('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_e2e',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [],
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  });
}

function toolResponse(id: string, name: string, input: unknown): string {
  return (
    messageStart() +
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name, input: {} },
    }) +
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    }) +
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }) +
    sse('message_stop', { type: 'message_stop' })
  );
}

function textResponse(text: string): string {
  return (
    messageStart() +
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }) +
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }) +
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
      const index = bodies.length - 1;
      const body = responses[index];
      if (!body) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'no scripted response' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
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
    bodies,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  openServers.push(fake);
  return fake;
}

async function setupWorkspace(serverUrl: string): Promise<{ root: string; home: string; workspace: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codingx-e2e-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src', 'util.ts'), 'const foo = 1;\nexport { foo };\n');
  const config = `
[provider.primary]
protocol = "anthropic-messages"
endpoint = "${serverUrl}"
api_key_env = "TEST_API_KEY"

[model]
route = "default"
max_output_tokens = 1024
temperature = 0

[agent]
max_steps = 8

[routes.default]
strategy = "failover"
affinity = "session"
max_attempts = 1

[[routes.default.targets]]
provider = "primary"
model = "test-model"

[sessiond]
enabled = false

[sandbox]
env_passthrough = ["PATH", "HOME", "LANG", "TERM", "TMPDIR"]

[tools]
max_output_chars = 30000
`;
  await writeFile(path.join(home, 'config.toml'), config);
  return { root, home, workspace };
}

function envFor(home: string, workspace: string): NodeJS.ProcessEnv {
  return {
    CODINGX_HOME: home,
    TEST_API_KEY: 'test-key',
    PATH: process.env.PATH ?? '',
    HOME: workspace,
    LANG: process.env.LANG ?? 'C',
    TERM: process.env.TERM ?? 'dumb',
    TMPDIR: os.tmpdir(),
  };
}

describe('codingx exec end-to-end', () => {
  it('completes read_file -> edit_file -> shell -> final answer and writes a replayable rollout', async () => {
    const server = await startServer([
      toolResponse('toolu_read', 'read_file', { path: 'src/util.ts' }),
      toolResponse('toolu_edit', 'edit_file', {
        path: 'src/util.ts',
        old_string: 'const foo',
        new_string: 'const bar',
      }),
      toolResponse('toolu_shell', 'shell', { command: "grep -q 'const bar' src/util.ts" }),
      textResponse('Renamed foo to bar and verified.'),
    ]);
    const { home, workspace } = await setupWorkspace(server.url);
    const stdout = new MemorySink();
    const stderr = new MemorySink();

    const code = await runExec({
      prompt: 'Rename foo to bar in src/util.ts and verify it.',
      cwd: workspace,
      env: envFor(home, workspace),
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(await readFile(path.join(workspace, 'src', 'util.ts'), 'utf8')).toContain('const bar = 1;');
    expect(stdout.value).toBe('Renamed foo to bar and verified.\n');
    expect(stderr.value).toContain('• read_file: src/util.ts');
    expect(stderr.value).toContain('• edit_file: src/util.ts');
    expect(stderr.value).toContain('• shell: grep -q');
    expect(stderr.value).toContain('[tokens:');
    expect(stderr.value).toContain('warning: M1 has no approval prompts');

    expect(server.bodies).toHaveLength(4);
    const firstBody = server.bodies[0];
    if (!firstBody) throw new Error('missing first request body');
    expect(firstBody).toMatchObject({ model: 'test-model', stream: true });
    const tools = firstBody.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'list_dir',
      'glob',
      'grep',
      'write_file',
      'edit_file',
      'update_plan',
      'apply_patch',
      'shell',
    ]);
    expect((firstBody.system as Array<{ cache_control?: unknown }>)[0]?.cache_control).toBeDefined();
    const lastMessages = server.bodies[3]?.messages as Array<{ role: string; content: unknown[] }>;
    expect(lastMessages.some((message) => message.role === 'user')).toBe(true);

    const store = new EmbeddedSessionStore({ directory: path.join(home, 'sessions') });
    const summaries = await store.listSessions();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ status: 'ended', model: 'test-model', provider: 'primary' });
    const sessionId = summaries[0]?.id;
    if (!sessionId) throw new Error('missing session id');
    const events = await store.replaySession(sessionId);
    const types = events.map((event) => event.type);
    for (const expected of [
      'session.start',
      'turn.start',
      'user.message',
      'provider.selected',
      'turn.status',
      'assistant.message',
      'tool.call',
      'tool.result',
      'turn.end',
      'session.end',
    ]) {
      expect(types).toContain(expected);
    }
    expect(events.find((event) => event.type === 'turn.end')).toMatchObject({ status: 'done' });
    expect(events.find((event) => event.type === 'session.end')).toBeDefined();
    await expect(store.attachSession(sessionId, 'write')).rejects.toThrow(/ended/);
  });

  it('runs through the CLI parser with --json and keeps stdout machine-readable', async () => {
    const server = await startServer([textResponse('All good.')]);
    const { home, workspace } = await setupWorkspace(server.url);
    const stdout = new MemorySink();
    const stderr = new MemorySink();

    const code = await runCli(['--cd', workspace, 'exec', '--json', 'say hi'], {
      env: envFor(home, workspace),
      stdout,
      stderr,
    });

    expect(code).toBe(0);
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
    expect(lines.find((line) => line.type === 'text.delta')).toMatchObject({ type: 'text.delta', text: 'All good.' });
    expect(lines.at(-1)).toMatchObject({ type: 'turn.finished', status: 'done' });
    expect(stdout.value).not.toContain('•');
    expect(stderr.value).toContain('[tokens:');
  });

  it('returns 2 for missing configuration and maps CLI errors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codingx-e2e-empty-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const stdout = new MemorySink();
    const stderr = new MemorySink();

    const code = await runCli(['--cd', workspace, 'exec', 'do something'], {
      env: { CODINGX_HOME: home, PATH: process.env.PATH ?? '' },
      stdout,
      stderr,
    });
    expect(code).toBe(2);
    expect(stderr.value).toMatch(/Route "default" is not configured/);
  });
});

describe('CLI parsing', () => {
  it('prints version and help', async () => {
    const versionOut = new MemorySink();
    const versionErr = new MemorySink();
    expect(await runCli(['--version'], { stdout: versionOut, stderr: versionErr })).toBe(0);
    expect(versionOut.value.trim()).toBe(VERSION);

    const helpOut = new MemorySink();
    const helpErr = new MemorySink();
    expect(await runCli(['--help'], { stdout: helpOut, stderr: helpErr })).toBe(0);
    expect(helpOut.value).toContain('Usage: codingx');
    expect(helpOut.value).toContain('exec');
  });

  it('returns 2 for a missing prompt and a bad working directory', async () => {
    const stdout = new MemorySink();
    const stderr = new MemorySink();
    expect(await runCli(['exec'], { stdout, stderr })).toBe(2);
    expect(stderr.value).toMatch(/missing required argument/i);

    const bad = new MemorySink();
    expect(await runCli(['--cd', '/definitely/not/here', 'exec', 'hi'], { stdout, stderr: bad })).toBe(2);
    expect(bad.value).toMatch(/Working directory does not exist/);
  });
});
