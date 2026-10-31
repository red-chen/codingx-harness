import { approvalRequestFor, type PolicyRuntime } from '../policy/index.js';
import type { AppendEventInput } from '../session/types.js';
import type { ApprovalHandler, PolicyDecision } from '../policy/types.js';
import type { SandboxBackend } from '../sandbox/types.js';
import { runSandboxedShell } from '../tools/shell-exec.js';
import { isAbortError } from '../util/errors.js';
import { truncateMiddle } from '../util/tokens.js';

/**
 * User-issued shell commands typed as '!command' in the TUI/composer.
 *
 * They never go through the model, but they do go through the same permission
 * policy, approval UI and OS sandbox as the Shell tool. The caller records
 * local.command / local.result in the rollout and decides how to paint output.
 */

const LOCAL_COMMAND_PREFIX = '!';

/**
 * Extract the command from a composer line that starts with '!'.
 * Returns undefined when the line is not a local command; an empty string means
 * the user typed a bare '!' (usage error).
 */
export function parseLocalCommand(text: string): string | undefined {
  const leading = text.trimStart();
  if (!leading.startsWith(LOCAL_COMMAND_PREFIX)) return undefined;
  return leading.slice(LOCAL_COMMAND_PREFIX.length).replace(/\r\n?/gu, '\n').trim();
}

export interface LocalCommandOptions {
  command: string;
  /** Workspace root; the command runs here. */
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputChars: number;
  policy?: PolicyRuntime;
  sandbox?: SandboxBackend;
  approve?: ApprovalHandler;
  signal?: AbortSignal;
}

export interface LocalCommandSandbox {
  kind: string;
  active: boolean;
  denied: boolean;
  code?: string;
  reason?: string;
}

export interface LocalCommandOutcome {
  /** Text shown in the transcript and stored in local.result. */
  content: string;
  isError: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  /** Stable-ish error code for display/audit (ABORTED, SANDBOX_DENIED, ...). */
  code?: string;
  /** Final policy decision, including an approval grant. */
  decision?: PolicyDecision;
  sandbox?: LocalCommandSandbox;
}

function trimTrailingNewlines(text: string): string {
  return text.replace(/\n+$/u, '');
}

function formatOutput(
  stdout: string,
  stderr: string,
  status: { timedOut: boolean; aborted: boolean; signal: string | null; exitCode: number | null; timeoutMs: number },
  maxOutputChars: number,
): string {
  const parts = [trimTrailingNewlines(stdout), trimTrailingNewlines(stderr)].filter((part) => part.length > 0);
  let content = parts.join('\n');
  let note: string | undefined;
  if (status.timedOut) note = '[timed out after ' + status.timeoutMs + 'ms]';
  else if (status.aborted) note = '[aborted]';
  else if (status.signal !== null) note = '[terminated by ' + status.signal + ']';
  else if (status.exitCode !== 0) note = '[exit code ' + (status.exitCode === null ? 'none' : status.exitCode) + ']';
  if (note !== undefined) content = content.length > 0 ? content + '\n' + note : note;
  if (content.length === 0) content = '(no output)';
  return truncateMiddle(content, maxOutputChars, '\n[... output truncated ...]\n');
}

function denialMessage(decision: PolicyDecision): string {
  const reason = decision.reason ?? 'the permission policy rejected this command.';
  if (decision.code === 'POLICY_FORBIDDEN') return 'Blocked by policy: ' + reason;
  if (decision.code === 'APPROVAL_REQUIRED') {
    return 'Approval required: ' + reason + ' No interactive approver is available in this run.';
  }
  return 'Permission denied: ' + reason;
}

function failure(
  content: string,
  code: string | undefined,
  decision: PolicyDecision | undefined,
  sandbox?: LocalCommandSandbox,
): LocalCommandOutcome {
  return {
    content,
    isError: true,
    exitCode: null,
    durationMs: 0,
    timedOut: false,
    aborted: false,
    ...(code === undefined ? {} : { code }),
    ...(decision === undefined ? {} : { decision }),
    ...(sandbox === undefined ? {} : { sandbox }),
  };
}

function aborted(decision: PolicyDecision | undefined): LocalCommandOutcome {
  return {
    content: '[aborted]',
    isError: true,
    exitCode: null,
    durationMs: 0,
    timedOut: false,
    aborted: true,
    code: 'ABORTED',
    ...(decision === undefined ? {} : { decision }),
  };
}

/** Run one '!command' through policy, optional approval, sandbox and exec. */
export async function runLocalCommand(options: LocalCommandOptions): Promise<LocalCommandOutcome> {
  let decision: PolicyDecision | undefined;
  let approvedNetwork: 'local' | undefined;
  if (options.policy !== undefined) {
    decision = await options.policy.evaluate('Shell', { command: options.command });
    if (decision.verdict === 'ask') {
      if (options.approve === undefined) {
        return failure(
          denialMessage({ ...decision, code: 'APPROVAL_REQUIRED' }),
          'APPROVAL_REQUIRED',
          decision,
        );
      }
      let answer;
      try {
        answer = await options.approve(approvalRequestFor(decision), options.signal);
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted === true) return aborted(decision);
        throw error;
      }
      if (answer.decision !== 'allow') {
        return failure(
          'Permission denied: ' + (answer.reason ?? 'the user denied this command.'),
          'PERMISSION_DENIED',
          decision,
        );
      }
      if (decision.action.networkScope === 'local') {
        if (answer.scope !== 'once') return failure('Local network exceptions require allow-once approval.', 'PERMISSION_DENIED', decision);
        approvedNetwork = 'local';
      }
      decision = { ...decision, verdict: 'allow', code: undefined, rule: 'approval.' + answer.scope };
    } else if (decision.verdict === 'deny') {
      return failure(denialMessage(decision), decision.code ?? 'PERMISSION_DENIED', decision);
    }
  }

  let outcome;
  try {
    outcome = await runSandboxedShell({
      command: options.command,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      env: options.env,
      maxOutputChars: options.maxOutputChars,
      approvedNetwork,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
      ...(options.policy?.yolo === true ? { yolo: true } : {}),
    });
  } catch (error) {
    return failure(
      'Failed to run command: ' + (error instanceof Error ? error.message : String(error)),
      undefined,
      decision,
    );
  }

  if (!outcome.ok) {
    return failure(outcome.message, outcome.code, decision, {
      kind: outcome.sandbox.kind,
      active: false,
      denied: false,
      ...(outcome.sandbox.reason === undefined ? {} : { reason: outcome.sandbox.reason }),
    });
  }

  const { result, sandboxKind, sandboxActive, sandboxDenied, networkDenied, hint } = outcome.execution;
  const content = formatOutput(
    result.stdout,
    result.stderr,
    {
      timedOut: result.timedOut,
      aborted: result.aborted,
      signal: result.signal,
      exitCode: result.exitCode,
      timeoutMs: options.timeoutMs,
    },
    options.maxOutputChars,
  );
  const failed = result.aborted || result.timedOut || result.signal !== null || result.exitCode !== 0;
  const sandbox: LocalCommandSandbox | undefined = sandboxActive
    ? {
        kind: sandboxKind ?? 'sandbox',
        active: true,
        denied: sandboxDenied,
        ...(sandboxDenied
          ? {
              code: 'SANDBOX_DENIED',
              reason: networkDenied
                ? 'Network access is denied by the permission profile sandbox.'
                : 'The operating-system sandbox denied a filesystem operation.',
            }
          : {}),
      }
    : undefined;

  return {
    content: hint === undefined ? content : hint + '\n\n' + content,
    isError: failed,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    aborted: result.aborted,
    ...(result.aborted ? { code: 'ABORTED' } : sandboxDenied ? { code: 'SANDBOX_DENIED' } : {}),
    ...(decision === undefined ? {} : { decision }),
    ...(sandbox === undefined ? {} : { sandbox }),
  };
}

/** Rollout event written before a local command starts. */
export function localCommandStartEvent(commandId: string, command: string, cwd: string): AppendEventInput {
  return { type: 'local.command', commandId, command, cwd };
}

/** Rollout event written after a local command finishes, including failures. */
export function localCommandResultEvent(
  commandId: string,
  command: string,
  outcome: LocalCommandOutcome,
): AppendEventInput {
  return {
    type: 'local.result',
    commandId,
    command,
    content: outcome.content,
    isError: outcome.isError,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    ...(outcome.aborted ? { aborted: true } : {}),
    ...(outcome.code === undefined ? {} : { code: outcome.code }),
    ...(outcome.sandbox === undefined ? {} : { sandbox: outcome.sandbox }),
  };
}

/** permission.decision / sandbox.denied audit events for a local command. */
export function localCommandAuditEvents(
  commandId: string,
  outcome: LocalCommandOutcome,
  context: { profile: string; approvalPolicy: string },
): AppendEventInput[] {
  const events: AppendEventInput[] = [];
  const sandbox = outcome.sandbox;
  if (sandbox?.denied === true) {
    events.push({
      type: 'sandbox.denied',
      commandId,
      callId: commandId,
      kind: sandbox.kind,
      reason: sandbox.reason ?? 'The OS sandbox denied the command.',
      retryable: true,
    });
  }
  const decision = outcome.decision;
  if (decision !== undefined) {
    events.push({
      type: 'permission.decision',
      commandId,
      callId: commandId,
      name: 'Shell',
      source: 'local-command',
      verdict: decision.verdict,
      ...(decision.code === undefined ? {} : { code: decision.code }),
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      ...(decision.rule === undefined ? {} : { rule: decision.rule }),
      risk: decision.risk,
      action: decision.action,
      profile: context.profile,
      approvalPolicy: context.approvalPolicy,
    });
  }
  return events;
}
