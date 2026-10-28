import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { buildChildEnv, runShellCommand } from '../src/exec/index.js';
import { createPolicyRuntime, parsePermissions } from '../src/policy/index.js';
import type { PolicyRuntime } from '../src/policy/types.js';
import {
  buildSeatbeltProfile,
  createSandboxBackend,
  createSeatbeltBackend,
} from '../src/sandbox/index.js';
import type { SandboxBackend } from '../src/sandbox/types.js';
import { ReadFileTracker, ToolRegistry, createBuiltinTools, type ToolContext } from '../src/tools/index.js';

let root: string;
let workspace: string;
let home: string;
let tmpdir: string;
const servers: Server[] = [];
const execFileAsync = promisify(execFile);

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codingx-sandbox-'));
  workspace = path.join(root, 'workspace');
  home = path.join(root, 'home');
  tmpdir = path.join(root, 'tmp');
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(tmpdir, { recursive: true });
});

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  await rm(root, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return { HOME: home, TMPDIR: tmpdir, PATH: process.env.PATH ?? '' };
}

async function policy(
  profile = ':workspace',
  approvalPolicy: 'on-request' | 'never' = 'on-request',
  profiles: Record<string, unknown> = {},
): Promise<PolicyRuntime> {
  return createPolicyRuntime({
    cwd: workspace,
    additionalDirs: [],
    env: env(),
    config: parsePermissions(profiles, profile),
    approvalPolicy,
    reviewer: 'user',
  });
}

function shellEnv(): Record<string, string> {
  return buildChildEnv(['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR'], {
    ...process.env,
    HOME: home,
    TMPDIR: tmpdir,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
  });
}

async function runSandboxed(
  command: string,
  backend: SandboxBackend,
  runtime: PolicyRuntime,
  cwd = workspace,
  envOverrides: Record<string, string> = {},
): Promise<Awaited<ReturnType<typeof runShellCommand>>> {
  const invocation = backend.wrapShell(command, runtime.sandboxPolicy);
  return runShellCommand({
    command,
    invocation,
    cwd,
    timeoutMs: 10_000,
    env: { ...shellEnv(), ...envOverrides, CODINGX_SANDBOX: backend.kind },
    maxOutputChars: 20_000,
  });
}

function ctxFor(runtime: PolicyRuntime, backend: SandboxBackend): ToolContext {
  return {
    cwd: workspace,
    signal: new AbortController().signal,
    readTracker: new ReadFileTracker(),
    maxOutputChars: 20_000,
    policy: runtime,
    sandbox: backend,
    shell: { env: shellEnv(), timeoutMs: 5_000 },
  };
}

async function startServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('sandbox-network-ok');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  return { server, port: address.port };
}

describe('Seatbelt profile generation', () => {
  it('denies by default, grants profile writes, and scopes secret denies', async () => {
    const runtime = await policy();
    const canonicalWorkspace = await realpath(workspace);
    const profile = buildSeatbeltProfile(runtime.sandboxPolicy);
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(allow process-exec)');
    expect(profile).toContain('(allow file-write* (subpath "' + canonicalWorkspace + '"))');
    expect(profile).not.toContain('(allow network*)');
    expect(profile).toContain('(deny file-read* (subpath "' + path.join(await realpath(home), '.ssh') + '"))');
    expect(profile).toContain('(deny file-read* (regex ');
    expect(profile).toContain('\\.env');
    expect(profile).not.toContain('^/private/etc/');
  });

  it('allows network only when the profile enables it', async () => {
    const runtime = await policy('net', 'on-request', {
      net: {
        extends: ':workspace',
        network: { enabled: true, domains: { 'example.com': 'allow' } },
      },
    });
    expect(buildSeatbeltProfile(runtime.sandboxPolicy)).toContain('(allow network*)');
  });

  it('returns explicit degraded backends for other platforms', async () => {
    const linux = await createSandboxBackend({ platform: 'linux' });
    expect(linux).toMatchObject({ kind: 'none', status: { available: false, required: false } });
    const windows = await createSandboxBackend({ platform: 'win32' });
    expect(windows).toMatchObject({ kind: 'none', status: { available: false, required: true } });
    const runtime = await policy();
    expect(() => windows.wrapShell('echo hi', runtime.sandboxPolicy)).toThrow(/Windows sandboxing|SANDBOX_UNAVAILABLE/i);
  });
});

describe.skipIf(process.platform !== 'darwin')('Seatbelt execution', () => {
  async function seatbelt(): Promise<SandboxBackend | undefined> {
    const backend = createSeatbeltBackend();
    if (!(await backend.available())) return undefined;
    return backend;
  }

  it('fails Shell closed when the platform requires a sandbox but none is available', async () => {
    const unavailable = await createSandboxBackend({ platform: 'win32' });
    const runtime = await policy();
    const registry = new ToolRegistry(createBuiltinTools());
    const result = await registry.execute('Shell', { command: 'echo hi' }, ctxFor(runtime, unavailable));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Sandbox unavailable for Shell');
    expect(result.meta).toMatchObject({ code: 'SANDBOX_UNAVAILABLE', sandbox: { active: false } });
  });

  it('allows workspace writes and blocks writes outside the profile', async () => {
    const backend = await seatbelt();
    if (!backend) return;
    const runtime = await policy();
    await writeFile(path.join(workspace, 'inside.txt'), 'before\n');
    const inside = await runSandboxed('echo after > inside.txt && cat inside.txt', backend, runtime);
    expect(inside.exitCode, inside.stderr).toBe(0);
    expect(inside.stdout).toContain('after');

    const outside = path.join(root, 'outside.txt');
    const blocked = await runSandboxed('echo nope > ' + JSON.stringify(outside), backend, runtime);
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderr + blocked.stdout).toMatch(/Operation not permitted|not permitted/i);
    await expect(readFile(outside)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('honors the read-only profile for workspace writes', async () => {
    const backend = await seatbelt();
    if (!backend) return;
    const runtime = await policy(':read-only');
    const target = path.join(workspace, 'read-only-write.txt');
    const result = await runSandboxed('echo nope > ' + JSON.stringify(target), backend, runtime);
    expect(result.exitCode).not.toBe(0);
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs the Node/npm toolchain inside the sandbox', async () => {
    const backend = await seatbelt();
    if (!backend) return;
    const runtime = await policy();
    const marker = await runSandboxed('printenv CODINGX_SANDBOX', backend, runtime);
    expect(marker.exitCode, marker.stderr).toBe(0);
    expect(marker.stdout.trim()).toBe('seatbelt');
    const result = await runSandboxed('node --version && npm --version', backend, runtime);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('v');
  });

  it('blocks credential and secret-file reads', async () => {
    const backend = await seatbelt();
    if (!backend) return;
    const runtime = await policy();
    await mkdir(path.join(home, '.ssh'), { recursive: true });
    await writeFile(path.join(home, '.ssh', 'id_rsa'), 'PRIVATE KEY\n');
    await writeFile(path.join(workspace, '.env'), 'SECRET=1\n');

    const ssh = await runSandboxed('cat ' + JSON.stringify(path.join(home, '.ssh', 'id_rsa')), backend, runtime);
    expect(ssh.exitCode).not.toBe(0);
    expect(ssh.stderr + ssh.stdout).toMatch(/not permitted/i);

    const dotenv = await runSandboxed('cat .env', backend, runtime);
    expect(dotenv.exitCode).not.toBe(0);
    expect(dotenv.stderr + dotenv.stdout).toMatch(/not permitted/i);
  });

  it('blocks symlink escapes from the workspace', async () => {
    const backend = await seatbelt();
    if (!backend) return;
    const runtime = await policy();
    const outside = path.join(root, 'symlink-target.txt');
    await writeFile(outside, 'outside secret\n');
    const link = path.join(workspace, 'escape-link');
    await symlink(outside, link);
    const result = await runSandboxed('cat ' + JSON.stringify(link), backend, runtime);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/not permitted/i);
  });

  it('keeps common git commands usable in the workspace', async () => {
    const backend = await seatbelt();
    if (!backend) return;
    await execFileAsync('git', ['init', '-q'], { cwd: workspace });
    const gitEnv = { ...env(), TMPDIR: os.tmpdir() };
    const runtime = await createPolicyRuntime({
      cwd: workspace,
      additionalDirs: [],
      env: gitEnv,
      config: parsePermissions({}, ':workspace'),
      approvalPolicy: 'on-request',
      reviewer: 'user',
    });
    const result = await runSandboxed(
      'git status --porcelain >/dev/null && git rev-parse --is-inside-work-tree',
      backend,
      runtime,
      workspace,
      { TMPDIR: os.tmpdir() },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('true');
  });

  it('runs repository git hooks under the sandbox', async () => {
    const backend = await seatbelt();
    if (!backend) return;
    await execFileAsync('git', ['init', '-q'], { cwd: workspace });
    await writeFile(path.join(workspace, 'file.txt'), 'hello\n');
    const hook = path.join(workspace, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\necho hook-ran > hook-output.txt\n');
    await chmod(hook, 0o755);
    const gitEnv = { ...env(), TMPDIR: os.tmpdir() };
    const runtime = await createPolicyRuntime({
      cwd: workspace,
      additionalDirs: [],
      env: gitEnv,
      config: parsePermissions({}, ':workspace'),
      approvalPolicy: 'on-request',
      reviewer: 'user',
    });
    const result = await runSandboxed(
      'git add file.txt && git -c user.name=Test -c user.email=test@example.com commit -m init',
      backend,
      runtime,
      workspace,
      { TMPDIR: os.tmpdir() },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readFile(path.join(workspace, 'hook-output.txt'), 'utf8')).toBe('hook-ran\n');
  });

  it('can install and run a git hook with the explicit git-hooks profile', async () => {
    const backend = await seatbelt();
    if (!backend) return;
    await execFileAsync('git', ['init', '-q'], { cwd: workspace });
    await writeFile(path.join(workspace, 'file.txt'), 'hello\n');
    const hook = path.join(workspace, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\n');
    await chmod(hook, 0o755);
    const gitEnv = { ...env(), TMPDIR: os.tmpdir() };
    const runtime = await createPolicyRuntime({
      cwd: workspace,
      additionalDirs: [],
      env: gitEnv,
      config: parsePermissions({}, ':workspace-git-hooks'),
      approvalPolicy: 'on-request',
      reviewer: 'user',
    });
    const result = await runSandboxed(
      "echo 'echo hook-ran > hook-output.txt' >> .git/hooks/pre-commit && " +
        'git config user.name Test && git config user.email test@example.com && ' +
        'git add file.txt && git commit -m init',
      backend,
      runtime,
      workspace,
      { TMPDIR: os.tmpdir() },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readFile(path.join(workspace, 'hook-output.txt'), 'utf8')).toBe('hook-ran\n');
  });

  it('denies loopback network by default and allows it for a network profile', async () => {
    const backend = await seatbelt();
    if (!backend) return;
    const { port } = await startServer();
    const script = [
      'fetch(' + JSON.stringify('http://127.0.0.1:' + port + '/') + ', { signal: AbortSignal.timeout(1500) })',
      '  .then((response) => response.text())',
      '  .then((text) => { console.log(text); process.exit(0); })',
      '  .catch((error) => { console.error(error.code || error.message); process.exit(3); });',
    ].join(' ');

    const deniedPolicy = await policy();
    const denied = await runSandboxed('node -e ' + JSON.stringify(script), backend, deniedPolicy);
    expect(denied.exitCode, denied.stderr).toBe(3);
    expect(denied.stderr).not.toContain('sandbox-network-ok');

    const allowedPolicy = await policy('net', 'on-request', {
      net: { extends: ':workspace', network: { enabled: true } },
    });
    const allowed = await runSandboxed('node -e ' + JSON.stringify(script), backend, allowedPolicy);
    expect(allowed.exitCode, allowed.stderr).toBe(0);
    expect(allowed.stdout).toContain('sandbox-network-ok');
  });

  it('reports SANDBOX_DENIED and writes shell metadata', async () => {
    const backend = await seatbelt();
    if (!backend) return;
    const runtime = await policy();
    await writeFile(path.join(root, 'outside.txt'), 'outside secret\n');
    // A permissive fake policy proves the OS sandbox (not the policy layer)
    // produces the structured denial.
    const permissive: PolicyRuntime = {
      ...runtime,
      sandboxPolicy: runtime.sandboxPolicy,
      rootsFor: (access) => runtime.rootsFor(access),
      isPathDenied: (target) => runtime.isPathDenied(target),
      evaluate: async () => ({
        verdict: 'allow',
        rule: 'test.allow',
        action: { kind: 'exec', tool: 'Shell', command: 'cat ../outside.txt' },
        risk: 'low',
      }),
    };
    await mkdir(path.join(home, '.ssh'), { recursive: true });
    await writeFile(path.join(home, '.ssh', 'id_rsa'), 'PRIVATE KEY\n');
    const registry = new ToolRegistry(createBuiltinTools());
    const result = await registry.execute(
      'Shell',
      { command: 'cat "$HOME/.ssh/id_rsa"' },
      ctxFor(permissive, backend),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('sandbox: seatbelt (denied)');
    expect(result.meta).toMatchObject({
      code: 'SANDBOX_DENIED',
      sandbox: { kind: 'seatbelt', active: true, denied: true },
    });
  });
});
