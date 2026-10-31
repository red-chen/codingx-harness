import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../src/cli/index.js';
import { EmbeddedSessionStore } from '../src/session/index.js';
import { startMockServer } from '../src/mock-llm/server.js';
import { createMockPlayground } from '../src/mock-llm/playground.js';
import type { MockServer } from '../src/mock-llm/types.js';
import type { TextSink } from '../src/ui/plain.js';

class Sink implements TextSink {
  value = '';
  write(text: string): boolean { this.value += text; return true; }
}

const roots: string[] = [];
const servers: MockServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const server = await startMockServer(); servers.push(server);
  const root = await mkdtemp(path.join(os.tmpdir(), 'codingx-mock-')); roots.push(root);
  const playground = await createMockPlayground(path.join(root, 'playground'), server.url);
  const env = { CODINGX_HOME: playground.home, MOCK_LLM_API_KEY: 'mock-local-only',
    HOME: playground.workspace, PATH: process.env.PATH ?? '', LANG: 'en_US.UTF-8', TERM: 'dumb', TMPDIR: os.tmpdir() };
  const run = async (scenario: string, flags: string[] = [], execFlags: string[] = []) => {
    const stdout = new Sink(); const stderr = new Sink();
    const code = await runCli(['-C', playground.workspace, ...flags, 'exec', ...execFlags, `[mock:${scenario}]`], { env, stdout, stderr });
    return { code, stdout: stdout.value, stderr: stderr.value };
  };
  const events = async () => {
    const store = new EmbeddedSessionStore({ directory: path.join(playground.home, 'sessions') });
    const sessions = await store.listSessions();
    return (await Promise.all(sessions.map(session => store.replaySession(session.id)))).flat();
  };
  return { ...playground, server, run, events };
}

describe('mock LLM with the real codingx CLI', () => {
  it('runs file tools, plan and Shell, verifies disk changes, checkpoints, usage and rollout', async () => {
    const f = await fixture();
    const result = await f.run('files', ['--reasoning-effort', 'high']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('MOCK PASS: files');
    expect(await readFile(path.join(f.workspace, 'mock-output/hello.txt'), 'utf8')).toBe('hello codingx\nverified\n');
    const events = await f.events();
    const types = events.map(event => event.type);
    for (const type of ['session.start', 'turn.start', 'assistant.message', 'tool.call', 'tool.result', 'permission.decision', 'file.change', 'usage.recorded', 'turn.end', 'session.end']) expect(types).toContain(type);
    expect(events.filter(event => event.type === 'turn.end')).toEqual([expect.objectContaining({ status: 'done' })]);
    expect(f.server.records[0]).toMatchObject({ effort: 'high', systemCache: true, toolsCache: true, tools: 17 });
    expect(f.server.records.at(-1)?.step).toBe(9);
    // Re-running reads the existing file first, satisfying the read-before-write rule.
    expect((await f.run('files')).code).toBe(0);
  });

  it.each(['skill', 'errors', 'process', 'pty', 'shell-errors', 'conflict', 'ask', 'approval'])(
    'drives %s and checks real tool results', async scenario => {
      const f = await fixture();
      const result = await f.run(scenario);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('MOCK PASS: ' + scenario);
      const events = await f.events();
      expect(events.some(event => event.type === 'tool.result')).toBe(true);
      if (scenario === 'conflict') {
        expect(await readFile(path.join(f.workspace, 'mock-conflict.txt'), 'utf8')).toBe('external\n');
        expect(JSON.stringify(events)).toContain('FILE_CHANGED');
      }
      if (scenario === 'ask') expect(JSON.stringify(events)).toContain('cannot show interactive questions');
      if (scenario === 'approval') expect(JSON.stringify(events)).toContain('APPROVAL_REQUIRED');
    },
  );

  it('verifies read-only rejection and leaves the target absent', async () => {
    const f = await fixture();
    const result = await f.run('permission', ['--sandbox', 'read-only', '--ask-for-approval', 'never']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('MOCK PASS: permission');
    await expect(stat(path.join(f.workspace, 'mock-denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(await f.events())).toContain('PERMISSION_DENIED');
  });

  it('transports images and emits parseable --json events', async () => {
    const f = await fixture();
    const result = await f.run('image', [], ['--image', 'image.png', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const output = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { type: string });
    expect(output.some(event => event.type === 'turn.finished')).toBe(true);
    expect(f.server.records[0]?.images).toBe(1);
  });

  it('terminates repeat scenarios at the configured step limit', async () => {
    const f = await fixture();
    const config = await readFile(path.join(f.home, 'config.toml'), 'utf8');
    await writeFile(path.join(f.home, 'config.toml'), config.replace('max_steps = 16', 'max_steps = 3'));
    const result = await f.run('loop');
    expect(result.code).toBe(1);
    expect(f.server.records).toHaveLength(3);
    expect(JSON.stringify(await f.events())).toContain('STEP_LIMIT');
  });

  it('fails the scenario if hooks block an expected-success tool and persists the hook audit', async () => {
    const f = await fixture();
    await appendFile(path.join(f.home, 'config.toml'), '\n[[hooks]]\nevent = "pre_tool_use"\nmatcher = "Skill"\ncommand = "exit 2"\n');
    const result = await f.run('skill');
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('MOCK PASS');
    expect(f.server.records.at(-1)?.status).toBe(409);
    expect(JSON.stringify(await f.events())).toContain('HOOK_BLOCKED');
  });

  it('refuses to initialize over an existing directory', async () => {
    const f = await fixture();
    const before = await readFile(path.join(f.home, 'config.toml'), 'utf8');
    await expect(createMockPlayground(f.root, f.server.url)).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    expect(await readFile(path.join(f.home, 'config.toml'), 'utf8')).toBe(before);
  });
});
