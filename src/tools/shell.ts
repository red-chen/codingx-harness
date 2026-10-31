import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { escalationFields } from '../policy/escalation.js';
import { abortError, ToolError } from '../util/errors.js';
import { resolveWorkspacePath } from './paths.js';
import { runSandboxedShell } from './shell-exec.js';
import type { ToolDef } from './types.js';

const MAX_TIMEOUT_MS = 10 * 60 * 1000;

const schema = z.object({
  ...escalationFields,
  command: z.string().min(1).describe('Shell command to run via bash -lc (cmd.exe on Windows).'),
  network: z.enum(['inherit', 'local']).optional().describe('Request local networking for this execution with user approval. Omit to auto-detect common local services/clients; inherit uses the profile unchanged.'),
  cwd: z
    .string()
    .optional()
    .describe('Working directory inside the workspace or an --add-dir root. Defaults to the workspace root.'),
  timeout_ms: z
    .number()
    .int()
    .min(100)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe('Timeout in milliseconds. Defaults to the session timeout (120000).'),
  description: z.string().optional().describe('Short human-readable explanation of what the command does.'),
});

function section(label: string, text: string): string {
  return label + ':' + '\n' + (text.length > 0 ? text.replace(/\n$/, '') : '(empty)');
}

export const shellTool: ToolDef<typeof schema> = {
  name: 'Shell',
  description:
    'Run a shell command inside the workspace (or an --add-dir root) and return stdout, stderr and the exit code. ' +
    'Commands run through bash -lc in their own process group; the working directory must stay inside an allowed root. ' +
    'On macOS they also run inside the Seatbelt sandbox, so writes outside the permission profile and network access ' +
    'follow the selected permission profile. ' +
    'Use this to run tests, builds, linters and git commands. Long output is truncated with an explicit marker. ' +
    'Use ProcessStart for long-running services or watchers; do not background them with & or nohup. ' +
    'For local networking use network: "local" to request one-execution approval without switching profiles. ' +
    'For necessary filesystem or HTTP(S) access beyond the profile, request sandbox_permissions: "require_escalated", justification, ' +
    'and additional_permissions with filesystem.read/write paths and/or network.domains. Approval applies only to this execution; secrets remain denied. ' +
    'Domain-scoped networking uses HTTP_PROXY/HTTPS_PROXY; use proxy-aware clients. Direct sockets and SSH are not supported by domain grants. ' +
    'After SANDBOX_DENIED inspect partial effects, then request the minimum additional permissions before retrying. ' +
    'A non-zero exit code is reported as an error result; read the output before deciding what to do next. ' +
    'Do not use Shell to read, search or edit files when Read, Grep, Glob or Edit fits. ' +
    'Do not run commands that wait for input (editors, pagers, prompts); they block until the timeout. ' +
    'When a command fails, read the error and change the command instead of repeating it unchanged.',
  schema,
  parallelSafe: false,
  approval: 'always',
  async execute(input, ctx) {
    const requestedCwd = input.cwd ?? '.';
    const resolved = await resolveWorkspacePath(ctx, requestedCwd, { mustExist: true, access: 'read' });
    const info = await stat(resolved.absolute);
    if (!info.isDirectory()) throw new ToolError('shell cwd is not a directory: ' + requestedCwd + '.');

    const timeoutMs = Math.min(input.timeout_ms ?? ctx.shell.timeoutMs, MAX_TIMEOUT_MS);
    const outcome = await runSandboxedShell({
      command: input.command,
      cwd: resolved.absolute,
      timeoutMs,
      env: ctx.shell.env,
      maxOutputChars: ctx.maxOutputChars,
      signal: ctx.signal,
      approvedNetwork: ctx.approvedNetwork,
      approvedPermissions: ctx.approvedPermissions,
      ...(ctx.policy === undefined ? {} : { policy: ctx.policy }),
      ...(ctx.sandbox === undefined ? {} : { sandbox: ctx.sandbox }),
      ...(ctx.yolo === true ? { yolo: true } : {}),
    });
    if (!outcome.ok) {
      return {
        content: outcome.message,
        isError: true,
        meta: { code: outcome.code, sandbox: outcome.sandbox },
      };
    }

    const { result, sandboxKind, sandboxActive, sandboxDenied, networkDenied, hint } = outcome.execution;
    if (result.aborted) throw abortError('Shell command aborted.');

    const failed = result.timedOut || result.exitCode !== 0 || result.signal !== null;
    const sandboxMeta =
      sandboxActive
        ? {
            kind: sandboxKind ?? 'sandbox',
            active: true,
            denied: sandboxDenied,
            ...(sandboxDenied
              ? {
                  reason: networkDenied
                    ? 'Network access is denied by the permission profile sandbox.'
                    : 'The operating-system sandbox denied a filesystem operation.',
                  code: 'SANDBOX_DENIED',
                }
              : {}),
          }
        : undefined;

    const relCwd = resolved.relative;
    const parts: string[] = [];
    if (result.timedOut) {
      parts.push('Command timed out after ' + timeoutMs + 'ms and was terminated.');
    }
    if (hint !== undefined) parts.push(hint);
    if (sandboxDenied) parts.push('For a necessary retry, use sandbox_permissions: "require_escalated", justification, and additional_permissions: { filesystem: { read: [paths], write: [paths] }, network: { domains: [hosts] } }. Request only needed scopes. Approval lasts for this execution only. Inspect partial effects before retrying; never replay blindly.');
    parts.push('exit_code: ' + (result.exitCode === null ? 'none' : result.exitCode));
    parts.push('duration_ms: ' + result.durationMs);
    if (input.description) parts.push('description: ' + input.description);
    if (sandboxMeta !== undefined) {
      parts.push('sandbox: ' + sandboxMeta.kind + (sandboxDenied ? ' (denied)' : ''));
    }
    parts.push(section('stdout', result.stdout));
    parts.push(section('stderr', result.stderr));
    if (result.stdoutTruncated) parts.push('[stdout truncated; ' + result.stdoutChars + ' characters total]');
    if (result.stderrTruncated) parts.push('[stderr truncated; ' + result.stderrChars + ' characters total]');

    return {
      content: parts.join('\n\n'),
      ...(failed ? { isError: true } : {}),
      meta: {
        command: input.command,
        cwd: relCwd,
        ...(input.description ? { description: input.description } : {}),
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdoutChars: result.stdoutChars,
        stderrChars: result.stderrChars,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        ...(sandboxDenied ? { code: 'SANDBOX_DENIED' } : {}),
        ...(sandboxMeta === undefined ? {} : { sandbox: sandboxMeta }),
      },
    };
  },
};
