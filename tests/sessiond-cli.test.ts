import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/index.js';
import { SessiondClient, type SessiondStore } from '../src/session/index.js';
import { SessiondDaemon } from '../src/sessiond/index.js';
import type { TextSink } from '../src/ui/plain.js';

class MemorySink implements TextSink {
  value = '';
  write(text: string): boolean {
    this.value += text;
    return true;
  }
}

interface FakeProvider {
  url: string;
  close(): Promise<void>;
}

const providers: FakeProvider[] = [];
const roots: string[] = [];
const daemons: SessiondDaemon[] = [];
const clients: SessiondClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const daemon of daemons.splice(0)) await daemon.stop('test cleanup').catch(() => undefined);
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
      message: {
        id: 'msg_sd',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [],
        usage: { input_tokens: 5, output_tokens: 0 },
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
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }) +
    sse('message_stop', { type: 'message_stop' })
  );
}

async function startProvider(): Promise<FakeProvider> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end(textResponse('Sessiond says hi.'));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no provider address');
  const provider: FakeProvider = {
    url: 'http://127.0.0.1:' + address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  providers.push(provider);
  return provider;
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

async function setup(): Promise<{ root: string; home: string; workspace: string; socket: string }> {
  const provider = await startProvider();
  const root = await mkdtemp(path.join(os.tmpdir(), 'codingx-sessiond-cli-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const socket = path.join(root, 'run', 'sessiond.sock');
  const sessionDir = path.join(root, 'sessions');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const config = `
[provider.primary]
protocol = "anthropic-messages"
endpoint = "${provider.url}"
api_key_env = "TEST_API_KEY"

[model]
route = "default"
max_output_tokens = 1024
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
dir = "${sessionDir}"
retention_days = 0

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
  const daemon = await SessiondDaemon.start({ socketPath: socket, sessionDir, idleTimeoutMs: 0 });
  daemons.push(daemon);
  return { root, home, workspace, socket };
}

describe('CLI over sessiond', () => {
  it('runs exec through the daemon and exposes sessions list/show', async () => {
    const { home, workspace, socket } = await setup();
    const stdout = new MemorySink();
    const stderr = new MemorySink();

    const code = await runCli(['--cd', workspace, 'exec', '--json', 'say hi'], {
      env: envFor(home, workspace),
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    const events = stdout.value.trimEnd().split('\n').map((line) => JSON.parse(line));
    const info = events.find((event) => event.type === 'session.info');
    expect(info).toMatchObject({ type: 'session.info' });
    const sessionId = info.session.sessionId as string;
    expect(sessionId).toBeTruthy();
    expect(events.at(-1)).toMatchObject({ type: 'turn.finished', status: 'done' });

    const client = await SessiondClient.connect({ socketPath: socket });
    clients.push(client);
    const listed = await client.list({ limit: 10 });
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({ id: sessionId, status: 'ended' });
    expect(listed.sessions[0]?.eventCount).toBeGreaterThan(0);

    const listOut = new MemorySink();
    const listErr = new MemorySink();
    const listCode = await runCli(['--cd', workspace, 'sessions', 'list', '--json'], {
      env: envFor(home, workspace),
      stdout: listOut,
      stderr: listErr,
    });
    expect(listCode).toBe(0);
    expect(listOut.value).toContain(sessionId);
    expect(listErr.value).toBe('');

    const showOut = new MemorySink();
    const showCode = await runCli(['--cd', workspace, 'sessions', 'show', sessionId, '--json'], {
      env: envFor(home, workspace),
      stdout: showOut,
      stderr: listErr,
    });
    expect(showCode).toBe(0);
    const shown = JSON.parse(showOut.value.trim());
    expect(shown.session.session.id).toBe(sessionId);
    expect(shown.events.some((event: { type: string }) => event.type === 'session.end')).toBe(true);

    const dryOut = new MemorySink();
    const dryCode = await runCli(['--cd', workspace, 'sessions', 'prune', '--older-than', '0', '--dry-run', '--json'], {
      env: envFor(home, workspace),
      stdout: dryOut,
      stderr: listErr,
    });
    expect(dryCode).toBe(0);
    const dry = JSON.parse(dryOut.value.trim());
    expect(dry.pruned).toContain(sessionId);
    const stillThere = await client.list({ limit: 10 });
    expect(stillThere.sessions.map((session) => session.id)).toContain(sessionId);

    const pruneOut = new MemorySink();
    const pruneCode = await runCli(['--cd', workspace, 'sessions', 'prune', '--older-than', '0', '--json'], {
      env: envFor(home, workspace),
      stdout: pruneOut,
      stderr: listErr,
    });
    expect(pruneCode).toBe(0);
    expect(JSON.parse(pruneOut.value.trim()).pruned).toContain(sessionId);
    const afterPrune = await client.list({ limit: 10 });
    expect(afterPrune.sessions.map((session) => session.id)).not.toContain(sessionId);
  });

  it('uses session.retention_days when --older-than is omitted', async () => {
    const { home, workspace } = await setup();
    const execOut = new MemorySink();
    const execErr = new MemorySink();
    expect(
      await runCli(['--cd', workspace, 'exec', '--json', 'say hi'], {
        env: envFor(home, workspace),
        stdout: execOut,
        stderr: execErr,
      }),
    ).toBe(0);
    const info = execOut.value
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'session.info');
    const sessionId = info.session.sessionId as string;

    const dryOut = new MemorySink();
    const dryErr = new MemorySink();
    const dryCode = await runCli(['--cd', workspace, 'sessions', 'prune', '--dry-run', '--json'], {
      env: envFor(home, workspace),
      stdout: dryOut,
      stderr: dryErr,
    });
    expect(dryCode).toBe(0);
    expect(JSON.parse(dryOut.value.trim()).pruned).toContain(sessionId);
  });

  it('reports and stops the daemon through the CLI', async () => {
    const { home, workspace } = await setup();
    const statusOut = new MemorySink();
    const statusErr = new MemorySink();
    expect(
      await runCli(['--cd', workspace, 'sessiond', 'status', '--json'], {
        env: envFor(home, workspace),
        stdout: statusOut,
        stderr: statusErr,
      }),
    ).toBe(0);
    const status = JSON.parse(statusOut.value.trim());
    expect(status.ok).toBe(true);
    expect(status.sessiond.socket).toContain('sessiond.sock');

    const stopOut = new MemorySink();
    expect(
      await runCli(['--cd', workspace, 'sessiond', 'stop', '--json'], {
        env: envFor(home, workspace),
        stdout: stopOut,
        stderr: statusErr,
      }),
    ).toBe(0);
    expect(JSON.parse(stopOut.value.trim())).toEqual({ ok: true, stopped: true });

    const missingOut = new MemorySink();
    expect(
      await runCli(['--cd', workspace, 'sessiond', 'status', '--json'], {
        env: envFor(home, workspace),
        stdout: missingOut,
        stderr: statusErr,
      }),
    ).toBe(1);
    expect(JSON.parse(missingOut.value.trim())).toMatchObject({ ok: false, running: false });
  });
});