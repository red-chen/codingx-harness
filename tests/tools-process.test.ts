import { afterEach, describe, expect, it } from 'vitest';
import { ProcessManager, buildChildEnv } from '../src/exec/index.js';
import { createPolicyRuntime, parsePermissions } from '../src/policy/index.js';
import type { SandboxBackend } from '../src/sandbox/types.js';
import { createBuiltinTools, ReadFileTracker, ToolRegistry, type ToolContext } from '../src/tools/index.js';

const managers: ProcessManager[] = [];
const registry = new ToolRegistry(createBuiltinTools());
async function context(profile = ':workspace'): Promise<ToolContext> {
  const processes = new ProcessManager({ killGraceMs: 50 });
  managers.push(processes);
  return {
    processes, cwd: process.cwd(), signal: new AbortController().signal,
    readTracker: new ReadFileTracker(), maxOutputChars: 20_000,
    shell: { env: buildChildEnv(['PATH', 'API_KEY'], { PATH: process.env.PATH, API_KEY: 'private-key' }), timeoutMs: 1000 },
    policy: await createPolicyRuntime({
      cwd: process.cwd(), additionalDirs: [], env: process.env,
      config: parsePermissions({}, profile), approvalPolicy: 'on-request', reviewer: 'user',
    }),
  };
}
afterEach(async () => { await Promise.allSettled(managers.splice(0).map((pm) => pm.close())); });

describe('Process tools', () => {
  it('uses Shell policy, presents the actual tool name, and does not spawn when approval is unavailable', async () => {
    const ctx = await context(':read-only');
    const input = { command: 'python3 -m http.server 8000 --bind 127.0.0.1' };
    const shell = await ctx.policy!.evaluate('Shell', input);
    const proc = await ctx.policy!.evaluate('ProcessStart', input);
    expect(proc.verdict).toBe(shell.verdict);
    expect(proc.action).toEqual({ ...shell.action, tool: 'ProcessStart' });
    expect((await registry.execute('ProcessStart', input, ctx)).isError).toBe(true);
    expect(ctx.processes!.list()).toEqual([]);
    const hardDenied = await registry.execute('ProcessStart', { command: 'rm -rf /' }, ctx);
    expect(hardDenied).toMatchObject({ isError: true, meta: { code: 'POLICY_FORBIDDEN' } });
  });

  it('fails closed when required sandbox is unavailable and uses the wrapper when available', async () => {
    const ctx = await context();
    const capabilities = { fileSystem: 'enforced', network: 'deny', unixSockets: false } as const;
    const backend: SandboxBackend = {
      kind: 'seatbelt', capabilities,
      status: { kind: 'seatbelt', platform: 'darwin', available: false, required: true, capabilities, warnings: [] },
      available: async () => false,
      wrapShell: () => ({ file: '/bin/bash', args: ['-c', 'echo wrapped; echo "key:${API_KEY-unset}"'] }),
    };
    ctx.sandbox = backend;
    const denied = await registry.execute('ProcessStart', { command: 'echo hello' }, ctx);
    expect(denied).toMatchObject({ isError: true, meta: { code: 'SANDBOX_UNAVAILABLE' } });
    expect(ctx.processes!.list()).toEqual([]);
    backend.status.available = true;
    const started = await registry.execute('ProcessStart', { command: 'echo hello' }, ctx);
    expect(started.isError).toBeUndefined();
    const id = JSON.parse(started.content).processId;
    const read = await registry.execute('ProcessRead', { process_id: id, wait_ms: 3000 }, ctx);
    expect(JSON.parse(read.content).output).toBe('wrapped\nkey:unset\n');
    const listed = await registry.execute('ProcessList', {}, ctx);
    expect(JSON.parse(listed.content)[0].processId).toBe(id);
    expect((await registry.execute('ProcessStop', { process_id: id }, ctx)).isError).toBeUndefined();
  });

  it('validates handles, cwd and input without exposing arbitrary OS process control', async () => {
    const ctx = await context();
    expect(await registry.execute('ProcessStop', { process_id: String(process.pid) }, ctx))
      .toMatchObject({ isError: true, meta: { code: 'PROCESS_NOT_FOUND' } });
    expect((await registry.execute('ProcessStart', { command: 'echo hello', cwd: '/private' }, ctx)).isError).toBe(true);
    expect((await registry.execute('ProcessRead', { process_id: 'unknown', wait_ms: 30_001 }, ctx)).isError).toBe(true);
    expect(ctx.processes!.list()).toEqual([]);
  });
});
