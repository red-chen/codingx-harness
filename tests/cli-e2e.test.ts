import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { PassThrough } from 'node:stream';
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
  it('completes ReadFile -> EditFile -> shell -> final answer and writes a replayable rollout', async () => {
    const server = await startServer([
      toolResponse('toolu_read', 'ReadFile', { path: 'src/util.ts' }),
      toolResponse('toolu_edit', 'EditFile', {
        path: 'src/util.ts',
        old_string: 'const foo',
        new_string: 'const bar',
      }),
      toolResponse('toolu_shell', 'Shell', { command: "grep -q 'const bar' src/util.ts" }),
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
    expect(stderr.value).toContain('• ReadFile: src/util.ts');
    expect(stderr.value).toContain('• EditFile: src/util.ts');
    expect(stderr.value).toContain('• Shell: grep -q');
    expect(stderr.value).toContain('[tokens:');
    expect(stderr.value).toContain('warning: M3.1 enforces the permission profile');

    expect(server.bodies).toHaveLength(4);
    const firstBody = server.bodies[0];
    if (!firstBody) throw new Error('missing first request body');
    expect(firstBody).toMatchObject({ model: 'test-model', stream: true });
    const tools = firstBody.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      'ReadFile',
      'ListDir',
      'Glob',
      'Grep',
      'WriteFile',
      'EditFile',
      'UpdatePlan',
      'ApplyPatch',
      'Shell',
      'Skill',
      'AskUserQuestion',
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

  it('allows repeated --add-dir roots for file tools and lists them in the system prompt', async () => {
    const responses: string[] = [];
    const server = await startServer(responses);
    const { root, home, workspace } = await setupWorkspace(server.url);
    const extra = path.join(root, 'extra');
    const second = path.join(root, 'second');
    const shared = path.join(workspace, 'shared');
    await mkdir(extra, { recursive: true });
    await mkdir(second, { recursive: true });
    await mkdir(shared, { recursive: true });
    const extraFile = path.join(second, 'note.txt');
    responses.push(
      toolResponse('toolu_add_dir', 'WriteFile', { path: extraFile, content: 'written through add-dir\n' }),
      textResponse('Wrote the note in the additional directory.'),
    );

    const stdout = new MemorySink();
    const stderr = new MemorySink();

    const code = await runCli(
      [
        '--cd',
        workspace,
        '--add-dir',
        path.relative(workspace, extra),
        '--add-dir',
        second,
        '--add-dir',
        '~/shared',
        'exec',
        'write a note in the extra directory',
      ],
      { stdout, stderr, env: envFor(home, workspace) },
    );

    expect(code).toBe(0);
    expect(await readFile(extraFile, 'utf8')).toBe('written through add-dir\n');
    expect(stdout.value).toBe('Wrote the note in the additional directory.\n');
    expect(stderr.value).toContain('• WriteFile: ' + extraFile);
    expect(server.bodies).toHaveLength(2);

    const canonicalExtra = await realpath(extra);
    const canonicalSecond = await realpath(second);
    const canonicalShared = await realpath(shared);
    const systemText = (server.bodies[0]?.system as Array<{ text?: string }>)
      .map((block) => block.text ?? '')
      .join('');
    expect(systemText).toContain('additional writable directories');
    expect(systemText).toContain(canonicalExtra);
    expect(systemText).toContain(canonicalSecond);
    expect(systemText).toContain(canonicalShared);
  });

  it('rejects a missing --add-dir before the turn starts', async () => {
    const server = await startServer([]);
    const { root, home, workspace } = await setupWorkspace(server.url);
    const stdout = new MemorySink();
    const stderr = new MemorySink();

    const code = await runCli(
      ['--cd', workspace, '--add-dir', path.join(root, 'missing'), 'exec', 'hello'],
      { stdout, stderr, env: envFor(home, workspace) },
    );

    expect(code).not.toBe(0);
    expect(stderr.value).toContain('Additional directory does not exist');
    expect(server.bodies).toHaveLength(0);
  });

  it('bypasses workspace confinement with --yolo and warns about it', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'codingx-yolo-'));
    roots.push(outside);
    const outsideFile = path.join(outside, 'note.txt');
    const server = await startServer([
      toolResponse('toolu_yolo', 'WriteFile', { path: outsideFile, content: 'written outside\n' }),
      textResponse('Wrote the note outside the workspace.'),
    ]);
    const { home, workspace } = await setupWorkspace(server.url);

    const stdout = new MemorySink();
    const stderr = new MemorySink();
    const code = await runCli(
      ['--cd', workspace, '--yolo', 'exec', 'write a note outside the workspace'],
      { stdout, stderr, env: envFor(home, workspace) },
    );

    expect(code).toBe(0);
    expect(await readFile(outsideFile, 'utf8')).toBe('written outside\n');
    expect(stdout.value).toBe('Wrote the note outside the workspace.\n');
    expect(stderr.value).toContain('warning: --yolo: all permission checks are bypassed');
    expect(stderr.value).not.toContain('M3.1 enforces the permission profile');

    const systemText = (server.bodies[0]?.system as Array<{ text?: string }>)
      .map((block) => block.text ?? '')
      .join('');
    expect(systemText).toContain('Permission checks are disabled for this session (--yolo)');
    expect(systemText).not.toContain('File tools are confined to the workspace');
  });

  it('accepts --allow-dangerously-skip-permissions as an alias for --yolo', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'codingx-yolo-alias-'));
    roots.push(outside);
    const outsideFile = path.join(outside, 'alias.txt');
    const server = await startServer([
      toolResponse('toolu_alias', 'WriteFile', { path: outsideFile, content: 'alias\n' }),
      textResponse('Wrote the alias note.'),
    ]);
    const { home, workspace } = await setupWorkspace(server.url);
    const stdout = new MemorySink();
    const stderr = new MemorySink();

    const code = await runCli(
      ['--cd', workspace, '--allow-dangerously-skip-permissions', 'exec', 'write via the alias'],
      { stdout, stderr, env: envFor(home, workspace) },
    );

    expect(code).toBe(0);
    expect(await readFile(outsideFile, 'utf8')).toBe('alias\n');
    expect(stderr.value).toContain('warning: --yolo: all permission checks are bypassed');
  });

  it('passes --yolo through the plain interactive mode', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'codingx-yolo-interactive-'));
    roots.push(outside);
    const outsideFile = path.join(outside, 'interactive.txt');
    const server = await startServer([
      toolResponse('toolu_interactive_yolo', 'WriteFile', { path: outsideFile, content: 'interactive\n' }),
      textResponse('Wrote the interactive note.'),
    ]);
    const { home, workspace } = await setupWorkspace(server.url);
    const stdin = new PassThrough();
    stdin.end('write a note outside\n/quit\n');
    const stdout = new MemorySink();
    const stderr = new MemorySink();

    const code = await runCli(['--cd', workspace, '--yolo'], {
      stdin,
      stdout,
      stderr,
      env: envFor(home, workspace),
    });

    expect(code).toBe(0);
    expect(await readFile(outsideFile, 'utf8')).toBe('interactive\n');
    expect(stdout.value).toContain('Wrote the interactive note.');
    expect(stderr.value).toContain('warning: --yolo: all permission checks are bypassed');
  });

  it('fails closed for workspace-outside writes without an interactive approver', async () => {
    const responses: string[] = [];
    const server = await startServer(responses);
    const { root, home, workspace } = await setupWorkspace(server.url);
    const tmpDir = path.join(root, 'tmp');
    const outside = path.join(root, 'outside');
    await mkdir(tmpDir, { recursive: true });
    await mkdir(outside, { recursive: true });
    const target = path.join(outside, 'note.txt');
    responses.push(
      toolResponse('toolu_policy_denied', 'WriteFile', { path: target, content: 'outside\n' }),
      textResponse('I could not write outside the workspace.'),
    );

    const stdout = new MemorySink();
    const stderr = new MemorySink();
    const code = await runCli(['--cd', workspace, 'exec', 'write outside the workspace'], {
      stdout,
      stderr,
      env: { ...envFor(home, workspace), TMPDIR: tmpDir },
    });

    expect(code).toBe(0);
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(stdout.value).toContain('I could not write outside the workspace.');
    expect(stderr.value).toContain('Approval required');
    expect(stderr.value).toContain('Permission profile ":workspace"');

    const store = new EmbeddedSessionStore({ directory: path.join(home, 'sessions') });
    const summaries = await store.listSessions();
    const sessionId = summaries[0]?.id;
    if (!sessionId) throw new Error('missing session id');
    const events = await store.replaySession(sessionId);
    const decision = events.find((event) => event.type === 'permission.decision');
    expect(decision).toMatchObject({
      name: 'WriteFile',
      verdict: 'deny',
      code: 'APPROVAL_REQUIRED',
      profile: ':workspace',
      approvalPolicy: 'on-request',
    });
    const result = events.find((event) => event.type === 'tool.result');
    expect(result).toMatchObject({ isError: true });
    expect((result?.meta as Record<string, unknown> | undefined)?.code).toBe('APPROVAL_REQUIRED');
  });

  it('honors --ask-for-approval never for outside writes', async () => {
    const responses: string[] = [];
    const server = await startServer(responses);
    const { root, home, workspace } = await setupWorkspace(server.url);
    const tmpDir = path.join(root, 'tmp');
    const outside = path.join(root, 'outside-never');
    await mkdir(tmpDir, { recursive: true });
    await mkdir(outside, { recursive: true });
    const target = path.join(outside, 'note.txt');
    responses.push(
      toolResponse('toolu_never', 'WriteFile', { path: target, content: 'outside\n' }),
      textResponse('Denied by the never policy.'),
    );

    const stdout = new MemorySink();
    const stderr = new MemorySink();
    const code = await runCli(
      ['--cd', workspace, '--ask-for-approval', 'never', 'exec', 'write outside the workspace'],
      { stdout, stderr, env: { ...envFor(home, workspace), TMPDIR: tmpDir } },
    );

    expect(code).toBe(0);
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(stderr.value).toContain('Permission denied');
    expect(stderr.value).not.toContain('Approval required');

    const store = new EmbeddedSessionStore({ directory: path.join(home, 'sessions') });
    const summaries = await store.listSessions();
    const sessionId = summaries[0]?.id;
    if (!sessionId) throw new Error('missing session id');
    const events = await store.replaySession(sessionId);
    expect(events.find((event) => event.type === 'permission.decision')).toMatchObject({
      verdict: 'deny',
      code: 'PERMISSION_DENIED',
      approvalPolicy: 'never',
    });
  });

  it('honors --sandbox read-only for in-workspace writes', async () => {
    const server = await startServer([
      toolResponse('toolu_read_only', 'WriteFile', { path: 'blocked.txt', content: 'blocked\n' }),
      textResponse('The write was blocked.'),
    ]);
    const { home, workspace } = await setupWorkspace(server.url);
    const stdout = new MemorySink();
    const stderr = new MemorySink();

    const code = await runCli(['--cd', workspace, '--sandbox', 'read-only', 'exec', 'write a file'], {
      stdout,
      stderr,
      env: envFor(home, workspace),
    });

    expect(code).toBe(0);
    await expect(stat(path.join(workspace, 'blocked.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(stderr.value).toContain('Approval required');
    expect(stderr.value).toContain('but not writing');

    const store = new EmbeddedSessionStore({ directory: path.join(home, 'sessions') });
    const summaries = await store.listSessions();
    const sessionId = summaries[0]?.id;
    if (!sessionId) throw new Error('missing session id');
    const events = await store.replaySession(sessionId);
    expect(events.find((event) => event.type === 'permission.decision')).toMatchObject({
      code: 'APPROVAL_REQUIRED',
      profile: ':read-only',
    });
  });

  it('allows a named profile to grant an extra write root', async () => {
    const responses: string[] = [];
    const server = await startServer(responses);
    const { root, home, workspace } = await setupWorkspace(server.url);
    const extra = path.join(root, 'extra');
    await mkdir(extra, { recursive: true });
    const target = path.join(extra, 'note.txt');
    await appendFile(
      path.join(home, 'config.toml'),
      '[permissions.review.filesystem]\n' + JSON.stringify(extra) + ' = "write"\n',
      'utf8',
    );
    responses.push(
      toolResponse('toolu_named_profile', 'WriteFile', { path: target, content: 'custom root\n' }),
      textResponse('Wrote through the custom profile.'),
    );

    const stdout = new MemorySink();
    const stderr = new MemorySink();
    const code = await runCli(
      ['--cd', workspace, '--permission-profile', 'review', 'exec', 'write through the custom profile'],
      { stdout, stderr, env: envFor(home, workspace) },
    );

    expect(code).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('custom root\n');
    expect(stdout.value).toContain('Wrote through the custom profile.');
    expect(stderr.value).toContain('Permission profile "review"');
  });

  it('rejects --add-dir when the selected profile does not allow extra roots', async () => {
    const server = await startServer([]);
    const { root, home, workspace } = await setupWorkspace(server.url);
    const extra = path.join(root, 'extra');
    await mkdir(extra, { recursive: true });
    const stdout = new MemorySink();
    const stderr = new MemorySink();

    const code = await runCli(
      ['--cd', workspace, '--sandbox', 'read-only', '--add-dir', extra, 'exec', 'hello'],
      { stdout, stderr, env: envFor(home, workspace) },
    );

    expect(code).toBe(2);
    expect(stderr.value).toContain('is not allowed by permission profile ":read-only"');
    expect(server.bodies).toHaveLength(0);
  });

  it('loads project skills into the system prompt and the skill tool', async () => {
    const server = await startServer([
      toolResponse('toolu_skill', 'Skill', { name: 'code-review' }),
      textResponse('Followed the skill.'),
    ]);
    const { home, workspace } = await setupWorkspace(server.url);
    const skillDir = path.join(workspace, '.codingx', 'skills', 'code-review');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: code-review\ndescription: Review a diff.\n---\n\n# Review workflow\n\nCheck tests.\n',
      'utf8',
    );

    const stdout = new MemorySink();
    const stderr = new MemorySink();
    const code = await runExec({
      prompt: 'Review the current diff.',
      cwd: workspace,
      env: envFor(home, workspace),
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(stdout.value).toBe('Followed the skill.\n');
    expect(stderr.value).toContain('• Skill: code-review');
    expect(server.bodies).toHaveLength(2);

    const firstBody = server.bodies[0];
    if (!firstBody) throw new Error('missing first request body');
    const systemText = (firstBody.system as Array<{ text?: string }>)
      .map((block) => block.text ?? '')
      .join('');
    expect(systemText).toContain('# Skills');
    expect(systemText).toContain('- code-review: Review a diff.');

    const secondBody = server.bodies[1] as
      | { messages?: Array<{ role: string; content: Array<Record<string, unknown>> }> }
      | undefined;
    const lastUser = secondBody?.messages?.at(-1);
    const toolResult = lastUser?.content.find((block) => block.type === 'tool_result');
    expect(toolResult?.content).toContain('# Review workflow');
    expect(toolResult?.content).toContain('Base directory: ' + skillDir);
  });

  it('loads shared skills from $HOME/.agents/skills', async () => {
    const server = await startServer([textResponse('Done.')]);
    const { home, workspace } = await setupWorkspace(server.url);
    const skillDir = path.join(workspace, '.agents', 'skills', 'shared-lint');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: shared-lint\ndescription: Lint shared code.\n---\n\n# Lint workflow\n\nRun the linter.\n',
      'utf8',
    );

    const stdout = new MemorySink();
    const stderr = new MemorySink();
    const code = await runExec({
      prompt: 'Lint the project.',
      cwd: workspace,
      env: envFor(home, workspace),
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(stdout.value).toBe('Done.\n');
    const firstBody = server.bodies[0];
    if (!firstBody) throw new Error('missing first request body');
    const systemText = (firstBody.system as Array<{ text?: string }>)
      .map((block) => block.text ?? '')
      .join('');
    expect(systemText).toContain('- shared-lint: Lint shared code.');
  });

  it('returns a non-interactive is_error when exec calls AskUserQuestion', async () => {
    const server = await startServer([
      toolResponse('toolu_ask', 'AskUserQuestion', {
        questions: [
          { id: 'approach', question: 'Which approach?', options: [{ label: 'A' }, { label: 'B' }] },
        ],
      }),
      textResponse('I will proceed with A.'),
    ]);
    const { home, workspace } = await setupWorkspace(server.url);
    const stdout = new MemorySink();
    const stderr = new MemorySink();

    const code = await runExec({
      prompt: 'Pick an approach and continue.',
      cwd: workspace,
      env: envFor(home, workspace),
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(stdout.value).toBe('I will proceed with A.\n');
    expect(stderr.value).toContain('• ask: Which approach?');
    expect(stderr.value).toContain('cannot show interactive questions');

    const secondBody = server.bodies[1] as
      | { messages?: Array<{ role: string; content: Array<Record<string, unknown>> }> }
      | undefined;
    const toolResult = secondBody?.messages?.at(-1)?.content.find((block) => block.type === 'tool_result');
    expect(toolResult).toMatchObject({ is_error: true });
    expect(toolResult?.content).toContain('cannot show interactive questions');
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
    expect(helpOut.value).toContain('--add-dir');
    expect(helpOut.value).toContain('--yolo');
    expect(helpOut.value).toContain('--allow-dangerously-skip-permissions');
    expect(helpOut.value).toContain('--sandbox');
    expect(helpOut.value).toContain('--ask-for-approval');
    expect(helpOut.value).toContain('--permission-profile');
    expect(helpOut.value).toContain('--full-auto');
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
