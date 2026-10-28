import type { ExecResult } from '../exec/types.js';
import { runShellCommand } from '../exec/index.js';
import type { PolicyRuntime } from '../policy/types.js';
import type { SandboxBackend } from '../sandbox/types.js';

/**
 * Shared shell execution used by the model-facing Shell tool and by local
 * '!command' input. Both paths must apply the same OS sandbox policy; the
 * caller decides how to present the result.
 */
export interface SandboxedShellOptions {
  command: string;
  /** Absolute, validated working directory. */
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
  maxOutputChars: number;
  signal?: AbortSignal;
  policy?: PolicyRuntime;
  sandbox?: SandboxBackend;
  /** True when --yolo disabled every permission check and the OS sandbox. */
  yolo?: boolean;
}

export interface SandboxedShellExecution {
  result: ExecResult;
  sandboxKind?: string;
  /** True when the command actually ran inside the OS sandbox backend. */
  sandboxActive: boolean;
  sandboxDenied: boolean;
  networkDenied: boolean;
}

export interface SandboxUnavailable {
  ok: false;
  code: 'SANDBOX_UNAVAILABLE';
  message: string;
  sandbox: { kind: string; active: false; available: false; reason?: string };
}

export type SandboxedShellOutcome =
  | { ok: true; execution: SandboxedShellExecution }
  | SandboxUnavailable;

/**
 * Resolve the sandbox invocation, run the command and classify sandbox denials.
 * Fail-closed behavior (required backend missing) is preserved for both callers.
 */
export async function runSandboxedShell(options: SandboxedShellOptions): Promise<SandboxedShellOutcome> {
  const { sandbox, policy } = options;
  let invocation: { file: string; args: string[] } | undefined;
  let sandboxKind: string | undefined;
  if (sandbox !== undefined && policy !== undefined && !policy.yolo && options.yolo !== true) {
    if (!sandbox.status.available && sandbox.status.required) {
      const reason = sandbox.status.reason ?? 'no OS sandbox backend is available';
      return {
        ok: false,
        code: 'SANDBOX_UNAVAILABLE',
        message:
          'Sandbox unavailable for Shell: ' + reason +
          ' This platform requires OS isolation, so the command was not executed. ' +
          'Use a supported platform or fix the sandbox installation before retrying.',
        sandbox: { kind: sandbox.kind, active: false, available: false, reason },
      };
    }
    if (sandbox.status.available) {
      try {
        invocation = sandbox.wrapShell(options.command, policy.sandboxPolicy);
        sandboxKind = sandbox.kind;
      } catch (error) {
        return {
          ok: false,
          code: 'SANDBOX_UNAVAILABLE',
          message:
            'Sandbox unavailable for Shell: ' +
            (error instanceof Error ? error.message : String(error)) +
            ' The command was not executed.',
          sandbox: { kind: sandbox.kind, active: false, available: false },
        };
      }
    }
  }

  const childEnv = invocation === undefined || sandboxKind === undefined
    ? options.env
    : { ...options.env, CODINGX_SANDBOX: sandboxKind };
  const result = await runShellCommand({
    command: options.command,
    ...(invocation === undefined ? {} : { invocation }),
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: childEnv,
    maxOutputChars: options.maxOutputChars,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const failed = result.timedOut || result.exitCode !== 0 || result.signal !== null;
  const combinedOutput = result.stdout + '\n' + result.stderr;
  const filesystemDenied =
    invocation !== undefined &&
    failed &&
    /(Operation not permitted|sandbox-exec: .*(?:deny|Operation not permitted))/i.test(combinedOutput);
  const networkDenied =
    invocation !== undefined &&
    failed &&
    policy !== undefined &&
    policy.sandboxPolicy.network.enabled === false &&
    /(Could not resolve host|Network is unreachable|Temporary failure in name resolution|nodename nor servname provided)/i.test(
      combinedOutput,
    );

  return {
    ok: true,
    execution: {
      result,
      ...(sandboxKind === undefined ? {} : { sandboxKind }),
      sandboxActive: invocation !== undefined,
      sandboxDenied: filesystemDenied || networkDenied,
      networkDenied,
    },
  };
}
