import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildChildEnv } from '../src/exec/index.js';
import { parseLocalCommand, runLocalCommand, type LocalCommandOptions } from '../src/cli/local-command.js';
import type { PolicyAction, PolicyDecision, PolicyRuntime } from '../src/policy/types.js';
import type { SandboxBackend } from '../src/sandbox/types.js';

describe('parseLocalCommand', () => {
  it('extracts commands after a leading bang', () => {
    expect(parseLocalCommand('!pwd')).toBe('pwd');
    expect(parseLocalCommand('   !  echo hi  ')).toBe('echo hi');
    expect(parseLocalCommand('!echo first\necho second')).toBe('echo first\necho second');
    expect(parseLocalCommand('!echo a\r\nb')).toBe('echo a\nb');
  });

  it('returns undefined for normal prompts and an empty command for a bare bang', () => {
    expect(parseLocalCommand('hello')).toBeUndefined();
    expect(parseLocalCommand('hello !pwd')).toBeUndefined();
    expect(parseLocalCommand('')).toBeUndefined();
    expect(parseLocalCommand('!')).toBe('');
    expect(parseLocalCommand('!   ')).toBe('');
  });
});

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'codingx-bang-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function env(): Record<string, string> {
  return buildChildEnv(['PATH', 'HOME', 'LANG', 'TERM'], { ...process.env, HOME: cwd });
}

function execAction(command: string): PolicyAction {
  return { kind: 'exec', tool: 'Shell', command, cwd, network: false };
}

function decision(verdict: PolicyDecision['verdict'], command: string): PolicyDecision {
  return {
    verdict,
    action: execAction(command),
    risk: 'high',
    ...(verdict === 'ask' ? { reason: 'needs approval' } : {}),
    ...(verdict === 'deny' ? { code: 'POLICY_FORBIDDEN' as const, reason: 'blocked by test' } : {}),
  };
}

function fakePolicy(evaluate: PolicyRuntime['evaluate']): PolicyRuntime {
  return {
    profileName: ':workspace',
    approvalPolicy: 'on-request',
    reviewer: 'user',
    yolo: false,
    cwd,
    additionalDirs: [],
    readRoots: [cwd],
    writeRoots: [cwd],
    sandboxPolicy: {
      profileName: ':workspace',
      cwd,
      home: cwd,
      tmpdir: os.tmpdir(),
      readRoots: [cwd],
      writeRoots: [cwd],
      denyRoots: [],
      denyGlobs: [],
      additionalDirs: [],
      network: { enabled: false, domains: {} },
      yolo: false,
      gitHooksWritable: false,
      gitConfigWritable: false,
    },
    evaluate,
    rootsFor: () => [cwd],
    isPathDenied: () => false,
  };
}

function unavailableSandbox(): SandboxBackend {
  const capabilities = { fileSystem: 'enforced' as const, network: 'deny' as const, unixSockets: false };
  return {
    kind: 'seatbelt',
    capabilities,
    status: {
      kind: 'seatbelt',
      platform: process.platform,
      available: false,
      required: true,
      capabilities,
      reason: 'probe failed in test',
      warnings: [],
    },
    available: async () => false,
    wrapShell: () => {
      throw new Error('seatbelt unavailable');
    },
  };
}

function baseOptions(command: string, overrides: Record<string, unknown> = {}): LocalCommandOptions {
  return {
    command,
    cwd,
    env: env(),
    timeoutMs: 5_000,
    maxOutputChars: 10_000,
    ...overrides,
  } as LocalCommandOptions;
}

describe.skipIf(process.platform === 'win32')('runLocalCommand', () => {
  it('runs a command and formats stdout, stderr and the exit code', async () => {
    const ok = await runLocalCommand(baseOptions('printf hello'));
    expect(ok).toMatchObject({ content: 'hello', isError: false, exitCode: 0, timedOut: false, aborted: false });
    expect(ok.decision).toBeUndefined();

    const failed = await runLocalCommand(baseOptions('printf oops 1>&2; exit 3'));
    expect(failed.exitCode).toBe(3);
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain('oops');
    expect(failed.content).toContain('[exit code 3]');

    const silent = await runLocalCommand(baseOptions('true'));
    expect(silent.content).toBe('(no output)');
  });

  it('truncates oversized output', async () => {
    const outcome = await runLocalCommand(
      baseOptions('seq 1 2000', { maxOutputChars: 200 }),
    );
    expect(outcome.content).toContain('[... output truncated ...]');
    expect(outcome.content.length).toBeLessThanOrEqual(220);
  });

  it('blocks a denied command without executing it', async () => {
    const marker = path.join(cwd, 'denied-marker.txt');
    const policy = fakePolicy(async (_tool, input) => {
      const command = (input as { command: string }).command;
      return decision('deny', command);
    });
    const outcome = await runLocalCommand(baseOptions('touch denied-marker.txt', { policy }));
    expect(outcome.isError).toBe(true);
    expect(outcome.code).toBe('POLICY_FORBIDDEN');
    expect(outcome.content).toContain('Blocked by policy');
    await expect(access(marker)).rejects.toThrow();
  });

  it('asks for approval and runs once when allowed', async () => {
    const commands: string[] = [];
    const policy = fakePolicy(async (_tool, input) => {
      const command = (input as { command: string }).command;
      commands.push(command);
      return decision('ask', command);
    });
    let approvals = 0;
    const outcome = await runLocalCommand(
      baseOptions('printf approved', {
        policy,
        approve: async () => {
          approvals += 1;
          return { decision: 'allow', scope: 'once' };
        },
      }),
    );
    expect(commands).toEqual(['printf approved']);
    expect(approvals).toBe(1);
    expect(outcome.content).toBe('approved');
    expect(outcome.decision).toMatchObject({ verdict: 'allow', rule: 'approval.once' });
  });

  it('does not execute when approval is denied', async () => {
    const marker = path.join(cwd, 'approval-marker.txt');
    const policy = fakePolicy(async (_tool, input) => decision('ask', (input as { command: string }).command));
    const outcome = await runLocalCommand(
      baseOptions('touch approval-marker.txt', {
        policy,
        approve: async () => ({ decision: 'deny', reason: 'not this time' }),
      }),
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.code).toBe('PERMISSION_DENIED');
    expect(outcome.content).toBe('Permission denied: not this time');
    await expect(access(marker)).rejects.toThrow();
  });

  it('fails closed when the sandbox is required but unavailable', async () => {
    const policy = fakePolicy(async (_tool, input) => decision('allow', (input as { command: string }).command));
    const outcome = await runLocalCommand(
      baseOptions('printf nope', { policy, sandbox: unavailableSandbox() }),
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.code).toBe('SANDBOX_UNAVAILABLE');
    expect(outcome.content).toContain('Sandbox unavailable for Shell');
    expect(outcome.content).toContain('probe failed in test');
    expect(outcome.sandbox).toMatchObject({ kind: 'seatbelt', active: false, denied: false });
  });

  it('reports timeouts and aborts without throwing', async () => {
    const timedOut = await runLocalCommand(baseOptions('sleep 5', { timeoutMs: 100 }));
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.isError).toBe(true);
    expect(timedOut.content).toContain('timed out');

    const controller = new AbortController();
    const pending = runLocalCommand(baseOptions('sleep 5', { signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    const aborted = await pending;
    expect(aborted.aborted).toBe(true);
    expect(aborted.isError).toBe(true);
    expect(aborted.content).toContain('[aborted]');
  });
});
