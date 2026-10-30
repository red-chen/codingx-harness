import { stat } from 'node:fs/promises';
import { networkMode } from '../policy/network.js';
import { sandboxFailure } from '../sandbox/diagnostics.js';
import { z } from 'zod';
import { CodingxError, isAbortError } from '../util/errors.js';
import { resolveWorkspacePath } from './paths.js';
import { prepareSandboxedShell } from './shell-exec.js';
import type { ManagedProcess, ProcessOutput } from '../exec/types.js';
import type { ToolContext, ToolDef, ToolResult } from './types.js';

async function result(ctx: ToolContext, action: (manager: NonNullable<ToolContext['processes']>) => Promise<unknown>, inspectExit = false): Promise<ToolResult> {
  try {
    if (!ctx.processes) throw new CodingxError('PROCESS_UNAVAILABLE', 'No process manager is available in this session.');
    const value = await action(ctx.processes);
    const process = inspectExit ? (value as { process: ManagedProcess }).process : value as Partial<ManagedProcess>;
    const failed = process.state === 'failed' || (inspectExit && process.state === 'exited' &&
      process.stopReason === undefined && (process.exitCode !== 0 || process.signal !== null));
    const diagnostic = sandboxFailure(inspectExit ? (value as ProcessOutput).output : '', failed, process.sandbox);
    const rendered = diagnostic.hint === undefined ? value : { ...value as ProcessOutput, hint: diagnostic.hint };
    return {
      content: JSON.stringify(rendered),
      ...(failed ? { isError: true, meta: {
        code: diagnostic.denied ? 'SANDBOX_DENIED' : 'TOOL_ERROR',
        ...(process.sandbox === undefined ? {} : { sandbox: { ...process.sandbox, active: true, denied: diagnostic.denied, reason: diagnostic.hint } }),
      } } : {}),
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      content: error instanceof Error ? error.message : String(error), isError: true,
      meta: { code: error instanceof CodingxError ? error.code : 'TOOL_ERROR' },
    };
  }
}

const startSchema = z.object({
  command: z.string().min(1).max(16_000), cwd: z.string().optional(),
  description: z.string().optional(),
});
const listSchema = z.object({});
const readSchema = z.object({
  process_id: z.string().min(1), cursor: z.number().int().nonnegative().optional(),
  max_chars: z.number().int().min(1).max(32_000).optional(),
  wait_ms: z.number().int().min(0).max(30_000).optional(),
});
const stopSchema = z.object({ process_id: z.string().min(1) });

export const processStartTool: ToolDef<typeof startSchema> = {
  name: 'ProcessStart',
  description: 'Start a managed background process (HTTP/dev server, watcher). Run the command in the foreground: do not append &, nohup or daemonize. Returns a processId for ProcessRead/ProcessStop. Running does not mean the service is ready. Survives turns, but stops on session clear or CLI exit. Uses the same permissions and sandbox as Shell. No stdin or PTY.',
  schema: startSchema,
  parallelSafe: false,
  approval: 'always',
  async execute(input, ctx) {
    const prepared = prepareSandboxedShell({ command: input.command, env: ctx.shell.env, policy: ctx.policy, sandbox: ctx.sandbox, yolo: ctx.yolo });
    if (!prepared.ok) return { content: prepared.message, isError: true, meta: { code: prepared.code, sandbox: prepared.sandbox } };
    return result(ctx, async (manager) => {
      const resolved = await resolveWorkspacePath(ctx, input.cwd ?? '.', { mustExist: true, access: 'read' });
      if (!(await stat(resolved.absolute)).isDirectory()) throw new CodingxError('TOOL_ERROR', 'Process cwd is not a directory.');
      return manager.start({
        command: input.command, cwd: resolved.absolute, env: prepared.env, invocation: prepared.invocation, signal: ctx.signal,
        ...(prepared.sandboxKind === undefined || ctx.policy === undefined ? {} : {
          sandbox: { kind: prepared.sandboxKind, network: networkMode(ctx.policy.sandboxPolicy.network) },
        }),
      });
    });
  },
};

export const processListTool: ToolDef<typeof listSchema> = {
  name: 'ProcessList',
  description: 'List managed processes in this live CLI session, including recently exited processes. Restored history does not restore live process handles.',
  schema: listSchema, parallelSafe: true, approval: 'none',
  execute: (_input, ctx) => result(ctx, async (manager) => { await manager.flush(); return manager.list(); }),
};

export const processReadTool: ToolDef<typeof readSchema> = {
  name: 'ProcessRead',
  description: 'Read bounded combined stdout/stderr and process status. Pass nextCursor from the previous read to get incremental output. truncated indicates older output was discarded. wait_ms waits for exit or the deadline without stopping the process. A failed exit is represented by exitCode/signal.',
  schema: readSchema,
  parallelSafe: true, approval: 'none',
  execute: (input, ctx) => result(ctx, (manager) => manager.read(
    input.process_id, input.cursor ?? 0,
    Math.min(input.max_chars ?? 8_000, Math.max(1, Math.floor((ctx.maxOutputChars - 1_000) / 6))),
    input.wait_ms ?? 0, ctx.signal,
  ), true),
};

export const processStopTool: ToolDef<typeof stopSchema> = {
  name: 'ProcessStop',
  description: 'Stop a managed process and its process group with SIGTERM, then SIGKILL if needed. Accepts only a processId from this live session. Safe to repeat on an exited process.',
  schema: stopSchema, parallelSafe: false, approval: 'none',
  execute: (input, ctx) => result(ctx, (manager) => manager.stop(input.process_id)),
};
