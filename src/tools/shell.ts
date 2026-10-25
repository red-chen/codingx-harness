import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { abortError, ToolError } from '../util/errors.js';
import { runShellCommand } from '../exec/index.js';
import { resolveWorkspacePath } from './paths.js';
import type { ToolDef } from './types.js';

const MAX_TIMEOUT_MS = 10 * 60 * 1000;

const schema = z.object({
  command: z.string().min(1).describe('Shell command to run via bash -lc (cmd.exe on Windows).'),
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
  return label + ':\n' + (text.length > 0 ? text.replace(/\n$/, '') : '(empty)');
}

export const shellTool: ToolDef<typeof schema> = {
  name: 'Shell',
  description:
    'Run a shell command inside the workspace (or an --add-dir root) and return stdout, stderr and the exit code. ' +
    'Commands run through bash -lc in their own process group; the working directory must stay inside an allowed root. ' +
    'Use this to run tests, builds, linters and git commands. Long output is truncated with an explicit marker. ' +
    'A non-zero exit code is reported as an error result; read the output before deciding what to do next. ' +
    'Do not use Shell to read, search or edit files when ReadFile, Grep, Glob or EditFile fits. ' +
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
    const result = await runShellCommand({
      command: input.command,
      cwd: resolved.absolute,
      timeoutMs,
      env: ctx.shell.env,
      maxOutputChars: ctx.maxOutputChars,
      signal: ctx.signal,
    });

    if (result.aborted) throw abortError('Shell command aborted.');

    const relCwd = resolved.relative;
    const parts: string[] = [];
    if (result.timedOut) {
      parts.push('Command timed out after ' + timeoutMs + 'ms and was terminated.');
    }
    parts.push('exit_code: ' + (result.exitCode === null ? 'none' : result.exitCode));
    parts.push('duration_ms: ' + result.durationMs);
    if (input.description) parts.push('description: ' + input.description);
    parts.push(section('stdout', result.stdout));
    parts.push(section('stderr', result.stderr));
    if (result.stdoutTruncated) parts.push('[stdout truncated; ' + result.stdoutChars + ' characters total]');
    if (result.stderrTruncated) parts.push('[stderr truncated; ' + result.stderrChars + ' characters total]');

    const failed = result.timedOut || result.exitCode !== 0 || result.signal !== null;
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
      },
    };
  },
};
