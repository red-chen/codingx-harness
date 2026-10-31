import type { ExecInvocation, ExecResult } from '../exec/types.js';
import { runShellCommand } from '../exec/index.js';
import { startNetworkProxy, type NetworkProxy } from '../sandbox/network.js';
import type { AdditionalPermissions, PolicyRuntime } from '../policy/types.js';
import type { SandboxBackend } from '../sandbox/types.js';
import { networkMode } from '../policy/network.js';
import { sandboxFailure, type ExecutionSandbox } from '../sandbox/diagnostics.js';

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
  /** Trusted per-execution grant from the approval flow. */
  approvedNetwork?: 'local';
  approvedPermissions?: AdditionalPermissions;
}

export interface SandboxedShellExecution {
  result: ExecResult;
  sandboxKind?: string;
  /** True when the command actually ran inside the OS sandbox backend. */
  sandboxActive: boolean;
  sandboxDenied: boolean;
  networkDenied: boolean;
  hint?: string;
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

export interface PreparedShell {
  ok: true;
  invocation?: ExecInvocation;
  sandboxKind?: string;
  sandboxInfo?: ExecutionSandbox;
  env: Record<string, string>;
  proxy?: NetworkProxy;
  cleanup: () => Promise<void>;
}

export type ShellPreparationOptions = Pick<SandboxedShellOptions,
  'command' | 'env' | 'sandbox' | 'policy' | 'yolo' | 'approvedNetwork' | 'approvedPermissions'>;

/**
 * Resolve the sandbox invocation, run the command and classify sandbox denials.
 * Fail-closed behavior (required backend missing) is preserved for both callers.
 */
export async function prepareSandboxedShell(options: ShellPreparationOptions): Promise<PreparedShell | SandboxUnavailable> {
  const { sandbox, policy } = options;
  let invocation: { file: string; args: string[] } | undefined;
  let sandboxKind: string | undefined;
  let sandboxInfo: ExecutionSandbox | undefined;
  let proxy: NetworkProxy | undefined;
  const cleanup = async (): Promise<void> => { await proxy?.close(); };
  if (policy && !policy.yolo && options.yolo !== true &&
      (options.approvedPermissions || (networkMode(policy.sandboxPolicy.network) !== 'none' && Object.keys(policy.sandboxPolicy.network.domains).length > 0)) &&
      !sandbox?.status.available) {
    return { ok: false, code: 'SANDBOX_UNAVAILABLE', message: 'Scoped permissions and domain restrictions require an available OS sandbox.',
      sandbox: { kind: sandbox?.kind ?? 'none', active: false, available: false } };
  }
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
        let effectivePolicy = options.approvedNetwork === 'local' && networkMode(policy.sandboxPolicy.network) === 'none'
          ? { ...policy.sandboxPolicy, network: { ...policy.sandboxPolicy.network, enabled: true, mode: 'local' as const } }
          : policy.sandboxPolicy;
        const extra = options.approvedPermissions;
        if (extra !== undefined) {
          const domains = { ...effectivePolicy.network.domains };
          for (const host of extra.network?.domains ?? []) if (domains[host] !== 'deny') domains[host] = 'allow';
          effectivePolicy = {
            ...effectivePolicy,
            readRoots: [...effectivePolicy.readRoots, ...(extra.filesystem?.read ?? []), ...(extra.filesystem?.write ?? [])],
            writeRoots: [...effectivePolicy.writeRoots, ...(extra.filesystem?.write ?? [])],
            network: extra.network ? { enabled: true, mode: 'all', domains } : effectivePolicy.network,
          };
        }
        if (networkMode(effectivePolicy.network) !== 'none' && Object.keys(effectivePolicy.network.domains).length > 0) {
          proxy = await startNetworkProxy({ domains: effectivePolicy.network.domains, localOnly: networkMode(effectivePolicy.network) === 'local' });
          effectivePolicy = { ...effectivePolicy, proxyPort: proxy.port };
        }
        invocation = sandbox.wrapShell(options.command, effectivePolicy);
        sandboxKind = sandbox.kind;
        sandboxInfo = { kind: sandbox.kind, network: proxy ? 'proxy' : networkMode(effectivePolicy.network) };
      } catch (error) {
        await cleanup();
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
  if (proxy) {
    for (const key of Object.keys(childEnv)) if (/^(?:https?|all|no)_proxy$/iu.test(key)) delete childEnv[key];
    Object.assign(childEnv, { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, http_proxy: proxy.url, https_proxy: proxy.url, ALL_PROXY: proxy.url, all_proxy: proxy.url, NO_PROXY: '', no_proxy: '' });
  }
  return { ok: true, invocation, sandboxKind, sandboxInfo, env: childEnv, proxy, cleanup };
}

export async function runSandboxedShell(options: SandboxedShellOptions): Promise<SandboxedShellOutcome> {
  const prepared = await prepareSandboxedShell(options);
  if (!prepared.ok) return prepared;
  const { invocation, sandboxKind, env: childEnv } = prepared;
  let result: ExecResult;
  try {
    result = await runShellCommand({
      command: options.command,
      ...(invocation === undefined ? {} : { invocation }),
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      env: childEnv,
      maxOutputChars: options.maxOutputChars,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } finally {
    await prepared.cleanup();
  }

  const failed = result.timedOut || result.exitCode !== 0 || result.signal !== null;
  const combinedOutput = result.stdout + '\n' + result.stderr;
  const diagnostic = sandboxFailure(combinedOutput, failed, prepared.sandboxInfo);
  if (prepared.proxy?.denied.length) {
    diagnostic.denied = true; diagnostic.networkDenied = true;
    diagnostic.hint = prepared.proxy.denied.join('\n') + '\nRequest only required domains via additional_permissions.network.domains. Private destinations also require an exact IP allow; configured denies cannot be approved.';
  }

  return {
    ok: true,
    execution: {
      result,
      ...(sandboxKind === undefined ? {} : { sandboxKind }),
      sandboxActive: invocation !== undefined,
      sandboxDenied: diagnostic.denied,
      networkDenied: diagnostic.networkDenied,
      hint: diagnostic.hint,
    },
  };
}
