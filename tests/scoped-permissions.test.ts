import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createPolicyRuntime, parsePermissions } from '../src/policy/index.js';
import { createSeatbeltBackend } from '../src/sandbox/index.js';
import { prepareSandboxedShell, runSandboxedShell } from '../src/tools/shell-exec.js';
import { abortError } from '../src/util/errors.js';
import { ToolRegistry, createBuiltinTools, ReadFileTracker, type ToolContext } from '../src/tools/index.js';
import { ProcessManager } from '../src/exec/index.js';
import type { ApprovalRequest } from '../src/policy/types.js';
import { parseRules } from '../src/policy/rules/index.js';

let root: string;
let cwd: string;
let home: string;
let backend: ReturnType<typeof createSeatbeltBackend>;
const registry = new ToolRegistry(createBuiltinTools());
const managers: ProcessManager[] = [];
const servers: Server[] = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codingx-scoped-')));
  cwd = path.join(root, 'workspace'); home = path.join(root, 'home');
  await mkdir(cwd); await mkdir(home);
  backend = createSeatbeltBackend();
  await backend.available();
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
  await Promise.all(servers.splice(0).map((s) => { s.closeAllConnections(); return new Promise<void>((resolve) => s.close(() => resolve())); }));
  await rm(root, { recursive: true, force: true });
});
async function context(profile = ':read-only', approvalPolicy: 'never' | 'on-request' = 'on-request', profiles: Record<string, unknown> = {}): Promise<ToolContext> {
  const policy = await createPolicyRuntime({ cwd, additionalDirs: [], env: { HOME: home }, config: parsePermissions(profiles, profile), approvalPolicy, reviewer: 'user' });
  return { cwd, signal: new AbortController().signal, readTracker: new ReadFileTracker(), maxOutputChars: 20000,
    policy, sandbox: backend, escalationBudget: { remaining: 3 }, shell: { env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeoutMs: 5000 } };
}
const scoped = (command: string, write: string[]) => ({ command, sandbox_permissions: 'require_escalated', justification: 'Write only the requested output directory.', additional_permissions: { filesystem: { write } } });
async function server(): Promise<number> {
  const s = createServer((_req, res) => { res.end('proxy-ok'); }); servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return (s.address() as { port: number }).port;
}

describe.skipIf(process.platform !== 'darwin')('scoped permissions with real Seatbelt', () => {
  it('closes the denial → approval → retry loop and never changes the base profile', async () => {
    expect(backend.status.available).toBe(true);
    const ctx = await context();
    const approvals: ApprovalRequest[] = [];
    ctx.approve = async (req) => { approvals.push(req); return { decision: 'allow', scope: 'once' }; };
    const command = 'printf approved > ./output.txt';
    const first = await registry.execute('Shell', { command }, ctx);
    expect(first).toMatchObject({ isError: true, meta: { code: 'SANDBOX_DENIED' } });
    const retried = await registry.execute('Shell', scoped(command, [cwd]), ctx);
    expect(retried.isError, retried.content).toBeUndefined();
    expect(await readFile(path.join(cwd, 'output.txt'), 'utf8')).toBe('approved');
    expect(approvals.at(-1)?.action.additionalPermissions?.filesystem?.write).toEqual([cwd]);
    expect(ctx.policy?.writeRoots).toEqual([]);
    expect(await registry.execute('Shell', { command: 'printf nope > ./later.txt' }, ctx)).toMatchObject({ isError: true, meta: { code: 'SANDBOX_DENIED' } });
    await expect(readFile(path.join(cwd, 'later.txt'))).rejects.toThrow();
  });

  it('canonicalizes grants, denies secrets and stops symlink escapes beyond the granted root', async () => {
    const ctx = await context(); ctx.approve = async () => ({ decision: 'allow', scope: 'once' });
    const granted = path.join(cwd, 'out'); await mkdir(granted);
    const other = path.join(root, 'other'); await mkdir(other);
    await symlink(other, path.join(granted, 'escape'));
    const result = await registry.execute('Shell', scoped('printf no > ./out/escape/file', [granted]), ctx);
    expect(result).toMatchObject({ isError: true, meta: { code: 'SANDBOX_DENIED' } });
    const secret = await registry.execute('Shell', scoped('printf no > .env', [cwd]), ctx);
    expect(secret.isError).toBe(true);
    const deniedGrant = await registry.execute('Shell', scoped('true', [path.join(home, '.ssh')]), { ...ctx, escalationBudget: { remaining: 3 } });
    expect(deniedGrant).toMatchObject({ isError: true, meta: { code: 'PERMISSION_DENIED' } });
  });

  it('does not execute on refusal, absent approval, never, invalid scopes or exhausted budget', async () => {
    const ctx = await context();
    const input = scoped('printf no > ./never.txt', [cwd]);
    expect(await registry.execute('Shell', input, ctx)).toMatchObject({ isError: true, meta: { code: 'APPROVAL_REQUIRED' } });
    expect(await registry.execute('Shell', input, { ...ctx, approve: async () => ({ decision: 'deny', reason: 'No.' }) })).toMatchObject({ isError: true, meta: { code: 'PERMISSION_DENIED' } });
    expect(await registry.execute('Shell', input, { ...ctx, approve: async () => ({ decision: 'allow', scope: 'session' }) })).toMatchObject({ isError: true });
    let asked = false;
    expect(await registry.execute('Shell', input, { ...ctx, approve: async () => { asked = true; return { decision: 'allow', scope: 'once' }; } })).toMatchObject({ isError: true });
    expect(asked).toBe(false);
    const never = await context(':read-only', 'never');
    never.approve = async () => { throw new Error('Must not ask'); };
    expect(await registry.execute('Shell', input, never)).toMatchObject({ isError: true, meta: { code: 'PERMISSION_DENIED' } });
    expect(await registry.execute('Shell', { ...input, justification: undefined }, await context())).toMatchObject({ isError: true });
    await expect(readFile(path.join(cwd, 'never.txt'))).rejects.toThrow();
  });

  it('enforces forbidden rules even during escalation', async () => {
    const ctx = await context();
    ctx.policy = await createPolicyRuntime({ cwd, additionalDirs: [], env: { HOME: home }, config: parsePermissions({}, ':read-only'),
      approvalPolicy: 'on-request', reviewer: 'user', execRules: parseRules("prefix_rule(pattern=['printf'],decision='forbidden')") });
    ctx.approve = async () => { throw new Error('Must not ask'); };
    expect(await registry.execute('Shell', scoped('printf blocked', [cwd]), ctx)).toMatchObject({ isError: true, meta: { code: 'POLICY_FORBIDDEN' } });
  });

  it('cancels approval without starting a command and keeps read grants read-only', async () => {
    const ctx = await context();
    ctx.approve = async () => { throw abortError(); };
    await expect(registry.execute('Shell', scoped('printf no > cancelled.txt', [cwd]), ctx)).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(readFile(path.join(cwd, 'cancelled.txt'))).rejects.toThrow();
    ctx.approve = async () => ({ decision: 'allow', scope: 'once' });
    expect(await registry.execute('Shell', { ...scoped('printf no > readonly.txt', []), additional_permissions: { filesystem: { read: [cwd] } } }, ctx))
      .toMatchObject({ isError: true, meta: { code: 'SANDBOX_DENIED' } });
  });

  it.each(['timeout', 'abort'])('closes Shell proxy connections on %s', async (mode) => {
    const ctx = await context('net', 'never', { net: { extends: ':workspace', network: { enabled: true, domains: { '127.0.0.1': 'allow' } } } });
    const controller = new AbortController();
    const pending = runSandboxedShell({ command: "printf '%s\\n' \"$HTTP_PROXY\"; printf ready > proxy-started; sleep 30", cwd,
      env: ctx.shell.env, policy: ctx.policy, sandbox: backend, signal: controller.signal, timeoutMs: mode === 'timeout' ? 1000 : 10000, maxOutputChars: 5000 });
    try {
      if (mode === 'abort') {
        await expect.poll(async () => readFile(path.join(cwd, 'proxy-started'), 'utf8').catch(() => ''), { timeout: 5000 }).toBe('ready');
        controller.abort();
      }
      const outcome = await pending;
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(mode === 'timeout' ? outcome.execution.result.timedOut : outcome.execution.result.aborted).toBe(true);
        const url = outcome.execution.result.stdout.trim();
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/);
        await expect(fetch(url)).rejects.toThrow();
      }
    } finally { controller.abort(); await pending.catch(() => undefined); }
  });

  it('allows approved HTTP through the proxy, blocks direct sockets and revokes the next invocation', async () => {
    const port = await server();
    const ctx = await context(':workspace'); ctx.approve = async () => ({ decision: 'allow', scope: 'once' });
    const input = { command: 'curl -fsS --max-time 2 http://127.0.0.1:' + port, network: 'inherit',
      sandbox_permissions: 'require_escalated', justification: 'Read the specified test endpoint.', additional_permissions: { network: { domains: ['127.0.0.1'] } } };
    const allowed = await registry.execute('Shell', input, ctx);
    expect(allowed.isError, allowed.content).toBeUndefined(); expect(allowed.content).toContain('proxy-ok');
    const bypass = await registry.execute('Shell', { ...input, command: input.command.replace('curl ', "curl --noproxy '*' ") }, ctx);
    expect(bypass.isError, bypass.content).toBe(true);
    const next = await registry.execute('Shell', { command: input.command, network: 'inherit' }, ctx);
    expect(next.isError).toBe(true);
    expect(ctx.policy?.sandboxPolicy.network.enabled).toBe(false);
  });

  it('enforces a configured whitelist for normal commands without requiring approval', async () => {
    const port = await server();
    const ctx = await context('net', 'never', { net: { extends: ':workspace', network: { enabled: true, domains: { '127.0.0.1': 'allow', localhost: 'deny' } } } });
    const good = await registry.execute('Shell', { command: 'curl -fsS --max-time 2 http://127.0.0.1:' + port, network: 'inherit' }, ctx);
    expect(good.isError, good.content).toBeUndefined();
    expect(await registry.execute('Shell', { command: 'curl -fsS http://localhost:' + port }, ctx)).toMatchObject({ isError: true });
    const envCopy = { ...ctx.shell.env };
    const prepared = await prepareSandboxedShell({ command: 'true', env: ctx.shell.env, policy: ctx.policy, sandbox: backend });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(prepared.env.NO_PROXY).toBe('');
      await prepared.cleanup();
    }
    expect(ctx.shell.env).toEqual(envCopy);
  });

  it('denies UDP and listening sockets under a proxy-only profile', async () => {
    const ctx = await context('net', 'never', { net: { extends: ':workspace', network: { enabled: true, domains: { '127.0.0.1': 'allow' } } } });
    for (const script of [
      'import socket; socket.socket().bind(("127.0.0.1",0))',
      'import socket; socket.socket(socket.AF_INET,socket.SOCK_DGRAM).sendto(b"x",("127.0.0.1",12345))',
    ]) {
      const outcome = await runSandboxedShell({ command: "/usr/bin/python3 -c '" + script + "'", cwd, env: ctx.shell.env,
        policy: ctx.policy, sandbox: backend, timeoutMs: 5000, maxOutputChars: 5000 });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.execution.result.exitCode).not.toBe(0);
        expect(outcome.execution.result.stderr).toMatch(/Operation not permitted/);
      }
    }
  });

  it('reports proxy refusals from managed process reads', async () => {
    const ctx = await context('net', 'never', { net: { extends: ':workspace', network: { enabled: true, domains: { '127.0.0.1': 'allow' } } } });
    const manager = new ProcessManager({ killGraceMs: 50 }); managers.push(manager); ctx.processes = manager;
    const started = await registry.execute('ProcessStart', { command: "target=http://unlisted.test; curl -fsS --max-time 2 \"$target\"", network: 'inherit' }, ctx);
    expect(started.isError, started.content).toBeUndefined();
    const id = JSON.parse(started.content).processId as string;
    const read = await registry.execute('ProcessRead', { process_id: id, wait_ms: 2000 }, ctx);
    expect(read).toMatchObject({ isError: true, meta: { code: 'SANDBOX_DENIED' } });
    expect(read.content).toContain('unlisted.test');
  });

  it('retains scoped permissions for a managed process and closes its proxy on stop', async () => {
    const ctx = await context(':workspace'); ctx.approve = async () => ({ decision: 'allow', scope: 'once' });
    const manager = new ProcessManager({ killGraceMs: 50 }); managers.push(manager); ctx.processes = manager;
    const start = await registry.execute('ProcessStart', { command: "printf '%s\\n' \"$HTTP_PROXY\"; sleep 30", sandbox_permissions: 'require_escalated',
      justification: 'Run with the approved endpoint.', additional_permissions: { network: { domains: ['127.0.0.1'] } } }, ctx);
    expect(start.isError, start.content).toBeUndefined();
    const id = JSON.parse(start.content).processId as string;
    let output = '';
    await expect.poll(async () => { output = (await manager.read(id)).output; return output; }, { timeout: 5000 }).toMatch(/http:\/\/127\.0\.0\.1:/);
    const url = output.trim();
    await manager.stop(id);
    await expect(fetch(url)).rejects.toThrow();
  });
});

it.skipIf(process.platform !== 'darwin')('keeps Seatbelt and the network proxy active for interactive PTY processes', async()=>{
  const ctx=await context('net','never',{net:{extends:':workspace',network:{enabled:true,domains:{'127.0.0.1':'allow'}}}});
  const manager=new ProcessManager({killGraceMs:80});managers.push(manager);ctx.processes=manager;
  const started=await registry.execute('ProcessStart',{command:`stty -echo; printf 'PROXY:%s\\n' "$HTTP_PROXY"; read line; printf 'GOT:%s\\n' "$line"; node -e 'require("fs").writeFileSync(".env","nope")'`,pty:true},ctx);
  expect(started.isError,started.content).toBeUndefined();const id=JSON.parse(started.content).processId as string;
  let output='';await expect.poll(async()=>{output=(await manager.read(id)).output;return output;},{timeout:5000}).toMatch(/PROXY:http:\/\/127\.0\.0\.1:/);
  const proxy=/PROXY:(http:\/\/127\.0\.0\.1:\d+)/.exec(output)![1]!;
  await manager.write(id,{text:'hello\n'});
  await expect.poll(async()=> (await manager.read(id)).process.state,{timeout:5000}).toBe('exited');
  expect((await manager.read(id)).output).toContain('GOT:hello');await expect(readFile(path.join(cwd,'.env'))).rejects.toThrow();await expect(fetch(proxy)).rejects.toThrow();
});
