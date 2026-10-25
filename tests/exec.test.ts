import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildChildEnv, runShellCommand } from '../src/exec/index.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'codingx-exec-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function baseRequest(command: string, overrides: Record<string, unknown> = {}) {
  return {
    command,
    cwd,
    timeoutMs: 5_000,
    env: buildChildEnv(['PATH', 'HOME', 'LANG', 'TERM'], { ...process.env, HOME: cwd }),
    maxOutputChars: 10_000,
    ...overrides,
  };
}

describe('buildChildEnv', () => {
  it('copies only whitelisted names and drops credentials even when whitelisted', () => {
    const env = buildChildEnv(
      ['PATH', 'HOME', 'API_KEY', 'AWS_SECRET_ACCESS_KEY', 'CODINGX_SESSIOND_SOCKET', 'SSH_AUTH_SOCK'],
      {
        PATH: '/usr/bin',
        HOME: '/home/test',
        API_KEY: 'secret',
        AWS_SECRET_ACCESS_KEY: 'secret',
        CODINGX_SESSIOND_SOCKET: '/tmp/sock',
        SSH_AUTH_SOCK: '/tmp/ssh',
        UNRELATED: 'nope',
      },
    );
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/test' });
  });

  it('provides a PATH fallback and filters extra credential names', () => {
    const env = buildChildEnv(['PATH'], {}, { FOO: 'bar', GITHUB_TOKEN: 'secret' });
    expect(env.PATH).toBeTruthy();
    expect(env.FOO).toBe('bar');
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('runShellCommand', () => {
  it('captures stdout, stderr, exit code and duration', async () => {
    const result = await runShellCommand(baseRequest('echo hello && echo warn 1>&2'));
    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      aborted: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    expect(result.stdout).toBe('hello\n');
    expect(result.stderr).toBe('warn\n');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.stdoutChars).toBe(6);
  });

  it('returns non-zero exit codes without throwing', async () => {
    const result = await runShellCommand(baseRequest('exit 7'));
    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
  });

  it('kills the process group on timeout', async () => {
    const started = Date.now();
    const result = await runShellCommand(
      baseRequest('sleep 5', { timeoutMs: 200, maxOutputChars: 1_000 }),
    );
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.durationMs).toBeLessThan(3_000);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('kills the process group when the abort signal fires', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    const result = await runShellCommand(
      baseRequest('sleep 5', { signal: controller.signal, timeoutMs: 10_000 }),
    );
    clearTimeout(timer);
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeLessThan(3_000);
  });

  it('passes only the filtered environment to children', async () => {
    const env = buildChildEnv(['PATH', 'HOME', 'API_KEY', 'CODINGX_SESSIOND_SOCKET'], {
      PATH: '/custom/bin',
      HOME: '/home/test',
      API_KEY: 'supersecret',
      CODINGX_SESSIOND_SOCKET: '/tmp/private.sock',
    });
    const result = await runShellCommand(
      baseRequest(
        'printenv API_KEY || echo api-key-unset; printenv CODINGX_SESSIOND_SOCKET || echo socket-unset; echo "path:$PATH"',
        { env },
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('api-key-unset');
    expect(result.stdout).toContain('socket-unset');
    expect(result.stdout).toContain('/custom/bin');
    expect(result.stdout).not.toContain('supersecret');
    expect(result.stdout).not.toContain('private.sock');
  });

  it('bounds oversized output with an explicit marker', async () => {
    const result = await runShellCommand(
      baseRequest('yes a | head -c 5000', { maxOutputChars: 500 }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdoutChars).toBe(5_000);
    expect(result.stdout).toContain('characters omitted');
    expect(result.stdout.length).toBeLessThan(1_000);
  });

  it('rejects invalid requests and missing working directories', async () => {
    await expect(runShellCommand(baseRequest('echo hi', { timeoutMs: 0 }))).rejects.toThrow(/timeoutMs/);
    await expect(runShellCommand(baseRequest('echo hi', { maxOutputChars: 0 }))).rejects.toThrow(/maxOutputChars/);
    await expect(runShellCommand(baseRequest('   '))).rejects.toThrow(/must not be empty/);
    await expect(
      runShellCommand(baseRequest('echo hi', { cwd: path.join(cwd, 'missing') })),
    ).rejects.toThrow(/Failed to start command|ENOENT/);
  });

  it('returns immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runShellCommand(baseRequest('echo hi', { signal: controller.signal }));
    expect(result.aborted).toBe(true);
    expect(result.stdout).toBe('');
    expect(result.durationMs).toBe(0);
  });
});
