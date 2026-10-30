import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildChildEnv } from '../src/exec/index.js';
import {
  createPolicyRuntime,
  parsePermissions,
  parseShellCommand,
} from '../src/policy/index.js';
import type { ApprovalDecision, PolicyRuntime } from '../src/policy/types.js';
import {
  ReadFileTracker,
  ToolRegistry,
  createBuiltinTools,
  type ToolContext,
} from '../src/tools/index.js';

let root: string;
let cwd: string;
let home: string;
let tmpdir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codingx-policy-'));
  cwd = path.join(root, 'workspace');
  home = path.join(root, 'home');
  tmpdir = path.join(root, 'tmp');
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(tmpdir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return { HOME: home, TMPDIR: tmpdir, PATH: process.env.PATH ?? '' };
}

async function runtime(
  profile = ':workspace',
  approvalPolicy: 'on-request' | 'never' = 'on-request',
  profiles: Record<string, unknown> = {},
): Promise<PolicyRuntime> {
  const config = parsePermissions(profiles, profile);
  return createPolicyRuntime({
    cwd,
    additionalDirs: [],
    env: env(),
    config,
    approvalPolicy,
    reviewer: 'user',
  });
}

describe('permission profiles', () => {
  it('parses built-ins and named profiles, and rejects unknown defaults', () => {
    const config = parsePermissions(
      {
        review: {
          extends: ':workspace',
          filesystem: { '~/.agents': 'write' },
          network: { enabled: true, domains: { 'api.example.com': 'allow' } },
        },
      },
      'review',
    );
    expect(config.profiles[':workspace']).toBeDefined();
    expect(config.profiles.review?.filesystem.some((rule) => rule.scope === '~/.agents')).toBe(true);
    expect(config.profiles.review?.network.enabled).toBe(true);
    expect(() => parsePermissions({}, ':nope')).toThrow(/Unknown default permission profile/);
  });

  it('rejects unsupported allow-glob profile rules instead of silently ignoring them', async () => {
    await expect(
      runtime('glob-write', 'on-request', {
        'glob-write': {
          filesystem: { ':workspace_roots': { 'src/**': 'write' } },
        },
      }),
    ).rejects.toThrow(/glob rules currently support deny/i);
  });

  it('resolves custom roots and network policies', async () => {
    const extra = path.join(root, 'extra');
    await mkdir(extra, { recursive: true });
    const policy = await runtime('review', 'on-request', {
      review: {
        extends: ':workspace',
        filesystem: { [extra]: 'write' },
        network: { enabled: true, domains: { 'example.com': 'allow' } },
      },
    });
    const decision = await policy.evaluate('Write', { path: path.join(extra, 'note.txt'), content: 'x' });
    expect(decision.verdict).toBe('allow');
    expect(policy.writeRoots).toContain(await realpath(extra));
  });
});

describe('policy evaluation', () => {
  it('gates git hook and config writes behind explicit scopes', async () => {
    await mkdir(path.join(cwd, '.git', 'hooks'), { recursive: true });
    await writeFile(path.join(cwd, '.git', 'config'), '[core]\n');
    const hookPath = path.join(cwd, '.git', 'hooks', 'pre-commit');
    const configPath = path.join(cwd, '.git', 'config');

    const defaults = await runtime(':workspace', 'never');
    expect((await defaults.evaluate('Write', { path: hookPath, content: 'x' })).verdict).toBe('deny');
    expect((await defaults.evaluate('Write', { path: configPath, content: 'x' })).verdict).toBe('deny');

    const hooks = await runtime(':workspace-git-hooks', 'never');
    expect((await hooks.evaluate('Write', { path: hookPath, content: 'x' })).verdict).toBe('allow');
    expect((await hooks.evaluate('Write', { path: configPath, content: 'x' })).verdict).toBe('allow');

    const custom = await runtime('hooks-only', 'never', {
      'hooks-only': { extends: ':workspace', filesystem: { ':git_hooks': 'write' } },
    });
    expect((await custom.evaluate('Write', { path: hookPath, content: 'x' })).verdict).toBe('allow');
    expect((await custom.evaluate('Write', { path: configPath, content: 'x' })).verdict).toBe('deny');

    await expect(
      runtime('bad-git-scope', 'never', {
        'bad-git-scope': { extends: ':workspace', filesystem: { ':git_hooks': 'read' } },
      }),
    ).rejects.toThrow(/:git_hooks supports/);
  });

  it('allows workspace reads/writes and asks for outside paths', async () => {
    const policy = await runtime();
    const inside = await policy.evaluate('Read', { path: 'src/a.ts' });
    expect(inside.verdict).toBe('allow');

    const outside = await policy.evaluate('Write', { path: path.join(root, 'outside', 'a.txt') });
    expect(outside.verdict).toBe('ask');
    expect(outside.reason).toMatch(/outside/);

    const never = await runtime(':workspace', 'never');
    const denied = await never.evaluate('Write', { path: path.join(root, 'outside', 'a.txt') });
    expect(denied.verdict).toBe('deny');
    expect(denied.code).toBe('PERMISSION_DENIED');
  });

  it('denies secret files even when they sit inside the workspace', async () => {
    const policy = await runtime();
    const envFile = await policy.evaluate('Read', { path: 'config/.env' });
    expect(envFile.verdict).toBe('deny');
    const keyFile = await policy.evaluate('Write', { path: 'certs/server.pem', content: 'x' });
    expect(keyFile.verdict).toBe('deny');
    const normal = await policy.evaluate('Read', { path: 'src/app.ts' });
    expect(normal.verdict).toBe('allow');
  });

  it('denies credential paths and grants full access only for danger-full-access', async () => {
    const policy = await runtime();
    const secret = await policy.evaluate('Read', { path: path.join(home, '.ssh', 'id_rsa') });
    expect(secret.verdict).toBe('deny');

    const danger = await runtime(':danger-full-access', 'never');
    const allowed = await danger.evaluate('Read', { path: path.join(home, '.ssh', 'id_rsa') });
    expect(allowed.verdict).toBe('allow');
  });

  it('asks for writes under read-only and still permits read-only commands', async () => {
    const policy = await runtime(':read-only');
    const write = await policy.evaluate('Write', { path: 'note.txt', content: 'x' });
    expect(write.verdict).toBe('ask');

    const pwd = await policy.evaluate('Shell', { command: 'pwd' });
    expect(pwd.verdict).toBe('allow');

    const arbitrary = await policy.evaluate('Shell', { command: 'npm test' });
    expect(arbitrary.verdict).toBe('ask');
  });

  it('enforces shell hard denies, network policy and redirect roots', async () => {
    const policy = await runtime();
    const sudo = await policy.evaluate('Shell', { command: 'sudo ls' });
    expect(sudo.verdict).toBe('deny');
    expect(sudo.code).toBe('POLICY_FORBIDDEN');

    const network = await policy.evaluate('Shell', { command: 'curl https://example.com' });
    expect(network.verdict).toBe('ask');

    const outsideRead = await policy.evaluate('Shell', { command: 'cat /etc/passwd' });
    expect(outsideRead.verdict).toBe('ask');
    expect(outsideRead.rule).toBe('exec.path');

    const redirect = await policy.evaluate('Shell', { command: 'echo hi > ' + path.join(home, 'out.txt') });
    expect(redirect.verdict).toBe('ask');

    const tmpRedirect = await policy.evaluate('Shell', { command: 'echo hi > ' + path.join(tmpdir, 'out.txt') });
    expect(tmpRedirect.verdict).toBe('allow');
  });

  it('does not let read-only or denied paths escape through shell syntax', async () => {
    const readOnly = await runtime(':read-only', 'never');
    for (const command of [
      'env touch pwned',
      'find . -delete',
      'git status & touch pwned',
      'echo "$(touch pwned)"',
    ]) {
      const decision = await readOnly.evaluate('Shell', { command });
      expect(decision.verdict, command).toBe('deny');
    }

    const workspace = await runtime(':workspace', 'never');
    for (const command of ['cat < .env', 'echo X > .env', 'cat ../../etc/passwd']) {
      const decision = await workspace.evaluate('Shell', { command });
      expect(decision.verdict, command).toBe('deny');
    }

    const devNull = await workspace.evaluate('Shell', { command: 'echo hi > /dev/null' });
    expect(devNull.verdict).toBe('allow');

    for (const file of ['.git/config', '.git/hooks/pre-commit']) {
      const decision = await workspace.evaluate('Write', { path: file, content: 'x' });
      expect(decision.verdict, file).toBe('deny');
    }
  });

  it('flags quoted command substitution and single ampersands', () => {
    expect(parseShellCommand('echo "$(touch pwned)"', cwd).hasUnsafeConstruct).toBe(true);
    expect(parseShellCommand('echo "$(touch pwned)"', cwd).hasSubstitution).toBe(true);
    const parsed = parseShellCommand('git status & touch pwned', cwd);
    expect(parsed.segments.map((segment) => segment.program)).toEqual(['git', 'touch']);
  });

  it('parses compound commands and tracks cd', async () => {
    const parsed = parseShellCommand('cd ' + tmpdir + ' && echo hi > out.txt', cwd);
    expect(parsed.parseError).toBeUndefined();
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0]?.program).toBe('cd');
    expect(parsed.segments[1]?.cwd).toBe(tmpdir);
    expect(parsed.segments[1]?.redirects[0]?.path).toBe('out.txt');
  });
});

describe('ToolRegistry policy enforcement', () => {
  function ctxWith(policy: PolicyRuntime, approve?: (request: unknown) => Promise<ApprovalDecision>): ToolContext {
    return {
      cwd,
      signal: new AbortController().signal,
      readTracker: new ReadFileTracker(),
      maxOutputChars: 30_000,
      policy,
      ...(approve === undefined ? {} : { approve }),
      shell: {
        env: buildChildEnv(['PATH', 'HOME', 'TMPDIR'], { ...process.env, HOME: home }),
        timeoutMs: 5_000,
      },
    };
  }

  it('turns an ask into APPROVAL_REQUIRED when no approver exists', async () => {
    const policy = await runtime();
    const registry = new ToolRegistry(createBuiltinTools());
    const target = path.join(root, 'outside', 'denied.txt');
    const result = await registry.execute('Write', { path: target, content: 'x' }, ctxWith(policy));
    expect(result.isError).toBe(true);
    expect(result.meta?.code).toBe('APPROVAL_REQUIRED');
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('executes a one-shot approved path and records policy metadata', async () => {
    const policy = await runtime();
    const registry = new ToolRegistry(createBuiltinTools());
    const target = path.join(root, 'outside', 'approved.txt');
    const ctx = ctxWith(policy, async () => ({ decision: 'allow', scope: 'once' }));
    const result = await registry.execute('Write', { path: target, content: 'approved\n' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(await readFile(target, 'utf8')).toBe('approved\n');
    expect(result.meta?.policy).toMatchObject({ verdict: 'allow', profile: ':workspace' });
  });

  it('filters denied files from Glob, Grep and ListDir', async () => {
    const policy = await runtime();
    await writeFile(path.join(cwd, '.env'), 'SECRET=1\n');
    await writeFile(path.join(cwd, 'app.ts'), 'const SECRET = 2;\n');
    const registry = new ToolRegistry(createBuiltinTools());
    const ctx = ctxWith(policy);

    const glob = await registry.execute('Glob', { pattern: '**/*' }, ctx);
    expect(glob.content).toContain('app.ts');
    expect(glob.content).not.toContain('.env');

    const grep = await registry.execute('Grep', { pattern: 'SECRET' }, ctx);
    expect(grep.content).toContain('app.ts');
    expect(grep.content).not.toContain('.env');

    const listed = await registry.execute('ListDir', { path: '.' }, ctx);
    expect(listed.content).toContain('app.ts');
    expect(listed.content).not.toContain('.env');

    const shell = await registry.execute('Shell', { command: 'cat .env' }, ctx);
    expect(shell.isError).toBe(true);
    expect(shell.content).toContain('denied path');
  });

  it('honors an explicit denial', async () => {
    const policy = await runtime();
    const registry = new ToolRegistry(createBuiltinTools());
    const target = path.join(root, 'outside', 'denied-by-user.txt');
    const ctx = ctxWith(policy, async () => ({ decision: 'deny', reason: 'not now' }));
    const result = await registry.execute('Write', { path: target, content: 'x' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.meta?.code).toBe('PERMISSION_DENIED');
    expect(result.content).toContain('not now');
  });
});

describe('loopback permission profile', () => {
  it('permits literal local clients and rejects non-loopback and unknown destinations', async () => {
    const policy = await runtime(':workspace-local', 'never');
    expect(policy.yolo).toBe(false);
    expect(policy.writeRoots).toContain(await realpath(cwd));
    for (const url of ['http://localhost:8000', 'http://127.0.0.1:8000', 'http://[::1]:8000']) {
      expect((await policy.evaluate('Shell', { command: 'curl ' + url })).verdict).toBe('allow');
    }
    for (const url of ['http://example.com', 'http://192.168.1.2', 'http://localhost.evil.test', 'http://[::ffff:127.0.0.1]']) {
      expect(await policy.evaluate('Shell', { command: 'curl ' + url })).toMatchObject({ verdict: 'deny', rule: 'network.local' });
    }
    expect((await policy.evaluate('Shell', { command: 'npm install' })).verdict).toBe('deny');
    expect((await policy.evaluate('ProcessStart', { command: 'python3 -m http.server 8000 --bind 127.0.0.1' })).verdict).toBe('allow');
  });

  it('inherits loopback mode without enabling external access through domain entries', async () => {
    const policy = await runtime('dev', 'never', {
      dev: { extends: ':workspace-local' },
    });
    expect(policy.sandboxPolicy.network.mode).toBe('local');
    const withDomains = await runtime('dev', 'never', {
      dev: { extends: ':workspace', network: { mode: 'local', domains: { 'example.com': 'allow' } } },
    });
    expect((await withDomains.evaluate('Shell', { command: 'curl http://example.com' })).verdict).toBe('deny');
  });
});
