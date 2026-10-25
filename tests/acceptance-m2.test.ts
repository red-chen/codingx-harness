import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/index.js';
import { runInteractive } from '../src/cli/commands/interactive.js';
import { SessiondClient } from '../src/session/index.js';
import { SessiondDaemon } from '../src/sessiond/index.js';
import type { TextSink } from '../src/ui/plain.js';

class MemorySink implements TextSink {
  value = '';
  write(text: string): boolean {
    this.value += text;
    return true;
  }
}

interface Provider {
  url: string;
  bodies: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

const providers: Provider[] = [];
const daemons: SessiondDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop('test').catch(() => undefined);
  for (const provider of providers.splice(0)) await provider.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function sse(type: string, data: unknown): string {
  return 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

function textResponse(text: string): string {
  return (
    sse('message_start', {
      type: 'message_start',
      message: { id: 'msg', type: 'message', role: 'assistant', model: 'test-model', content: [], usage: { input_tokens: 5, output_tokens: 0 } },
    }) +
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) +
    sse('message_stop', { type: 'message_stop' })
  );
}

async function startProvider(options: { delayFirstMs?: number } = {}): Promise<Provider> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        body = {};
      }
      bodies.push(body);
      const index = bodies.length - 1;
      const send = (): void => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(textResponse('reply ' + index));
      };
      if (index === 0 && options.delayFirstMs) setTimeout(send, options.delayFirstMs);
      else send();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no provider address');
  const provider: Provider = {
    url: 'http://127.0.0.1:' + address.port,
    bodies,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  providers.push(provider);
  return provider;
}

async function setup(delayFirstMs?: number): Promise<{
  root: string;
  home: string;
  workspace: string;
  socket: string;
  provider: Provider;
}> {
  const provider = await startProvider(delayFirstMs === undefined ? {} : { delayFirstMs });
  const root = await mkdtemp(path.join(os.tmpdir(), 'codingx-accept-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const socket = path.join(root, 'run', 'sessiond.sock');
  const sessions = path.join(root, 'sessions');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const config = `
[provider.primary]
protocol = "anthropic-messages"
endpoint = "${provider.url}"
api_key_env = "TEST_API_KEY"

[model]
route = "default"
max_output_tokens = 512
temperature = 0

[agent]
max_steps = 4

[routes.default]
strategy = "failover"
affinity = "session"
max_attempts = 1

[[routes.default.targets]]
provider = "primary"
model = "test-model"

[session]
dir = "${sessions}"

[sessiond]
enabled = true
socket = "${socket}"
autostart = false
idle_timeout_seconds = 60

[sandbox]
env_passthrough = ["PATH", "HOME", "LANG", "TERM", "TMPDIR"]

[tools]
max_output_chars = 30000
`;
  await writeFile(path.join(home, 'config.toml'), config);
  const daemon = await SessiondDaemon.start({ socketPath: socket, sessionDir: sessions, idleTimeoutMs: 0 });
  daemons.push(daemon);
  return { root, home, workspace, socket, provider };
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

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('waitFor timed out');
}

describe('M2 acceptance', () => {
  it('Ctrl+C aborts a turn and --continue sends the interrupted history to the next turn', async () => {
    const { home, workspace, provider } = await setup(800);
    const aInput = new PassThrough();
    const aOut = new MemorySink();
    const aErr = new MemorySink();
    const a = runInteractive({
      cwd: workspace,
      env: envFor(home, workspace),
      stdin: aInput,
      stdout: aOut,
      stderr: aErr,
      initialPrompt: 'slow request',
    });
    await waitFor(() => provider.bodies.length === 1);
    process.emit('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 150));
    aInput.write('/quit\n');
    expect(await a).toBe(0);

    const bInput = new PassThrough();
    const bOut = new MemorySink();
    const bErr = new MemorySink();
    bInput.write('/quit\n');
    const bCode = await runCli(['--cd', workspace, '--continue', 'next request'], {
      env: envFor(home, workspace),
      stdin: bInput,
      stdout: bOut,
      stderr: bErr,
    });
    expect(bCode).toBe(0);
    expect(bErr.value).toContain('resumed session');
    expect(provider.bodies).toHaveLength(2);
    const history = JSON.stringify(provider.bodies[1]?.messages ?? []);
    expect(history).toContain('slow request');
    expect(history).toContain('next request');
  });

  it('shows one shared session to a second CLI and enforces the write lease', async () => {
    const { home, workspace, socket } = await setup();
    const aInput = new PassThrough();
    const aOut = new MemorySink();
    const aErr = new MemorySink();
    const a = runInteractive({
      cwd: workspace,
      env: envFor(home, workspace),
      stdin: aInput,
      stdout: aOut,
      stderr: aErr,
      initialPrompt: 'first session',
    });

    const observer = await SessiondClient.connect({ socketPath: socket });
    try {
      await waitFor(async () => {
        const list = await observer.list({ limit: 10 });
        return list.sessions.some((session) => session.writer !== undefined && session.status === 'idle');
      });
      const list = await observer.list({ limit: 10 });
      const session = list.sessions[0];
      if (!session) throw new Error('missing session');
      expect(session.clients).toBeGreaterThanOrEqual(1);

      const bInput = new PassThrough();
      bInput.write('/quit\n');
      const bOut = new MemorySink();
      const bErr = new MemorySink();
      const busyCode = await runCli(['--cd', workspace, '--resume', session.id], {
        env: envFor(home, workspace),
        stdin: bInput,
        stdout: bOut,
        stderr: bErr,
      });
      expect(busyCode).not.toBe(0);
      expect(bErr.value).toMatch(/leased|busy/i);

      aInput.write('/quit\n');
      expect(await a).toBe(0);

      const retryInput = new PassThrough();
      retryInput.write('/quit\n');
      const retryOut = new MemorySink();
      const retryErr = new MemorySink();
      const retryCode = await runCli(['--cd', workspace, '--resume', session.id], {
        env: envFor(home, workspace),
        stdin: retryInput,
        stdout: retryOut,
        stderr: retryErr,
      });
      expect(retryCode).toBe(0);
      expect(retryErr.value).toContain('resumed session');
    } finally {
      observer.close();
    }
  });
});
