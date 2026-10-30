import { sandboxFailure } from '../sandbox/diagnostics.js';
import { stripVTControlCharacters } from 'node:util';
import type { ProcessManager } from '../exec/process-manager.js';
import type { ManagedProcess } from '../exec/types.js';
import { CodingxError } from '../util/errors.js';
import { redactString } from '../util/redact.js';

export const PROCESS_COMMAND_USAGE = [
  '/process [list]                 List this session’s managed processes',
  '/process logs <id> [cursor]      Show recent output, or read from a cursor',
  '/process stop <id>               Stop the process group',
  'Use a full processId or a unique prefix; OS PIDs are not accepted.',
].join('\n');

export interface ProcessCommandResult {
  content: string;
  isError: boolean;
}

export type ProcessCommandManager = Pick<ProcessManager, 'list' | 'read' | 'stop' | 'flush'>;

export function isProcessCommand(line: string): boolean {
  return /^\/process(?:\s|$)/u.test(line.trim());
}

function safeText(text: string): string {
  return redactString(stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, '')).value;
}

function status(info: ManagedProcess): string {
  const details: string[] = [info.state];
  if (info.exitCode !== null) details.push('exit=' + info.exitCode);
  if (info.signal !== null) details.push(info.signal);
  if (info.stopReason !== undefined) details.push(info.stopReason);
  return details.join(' ');
}

function resolveId(manager: ProcessCommandManager, prefix: string): string {
  const entries = manager.list();
  const exact = entries.find((entry) => entry.processId === prefix);
  if (exact) return exact.processId;
  const matches = entries.filter((entry) => entry.processId.startsWith(prefix));
  if (matches.length === 0) throw new CodingxError('PROCESS_NOT_FOUND', 'No process matches "' + prefix + '" in this CLI session. Use /process to list handles.');
  if (matches.length > 1) throw new CodingxError('TOOL_ERROR', 'Ambiguous processId prefix "' + prefix + '"; use a longer prefix.');
  return matches[0]!.processId;
}

/** User-issued management commands: no model request or model-history entry. */
export async function runProcessCommand(line: string, manager: ProcessCommandManager): Promise<ProcessCommandResult> {
  try {
    const [name, action = 'list', id, cursorText, ...extra] = line.trim().split(/\s+/u);
    if (name !== '/process') return { content: PROCESS_COMMAND_USAGE, isError: true };
    if (action === 'help' && id === undefined) return { content: PROCESS_COMMAND_USAGE, isError: false };
    if (action === 'list' && id === undefined) {
      await manager.flush();
      const processes = manager.list();
      const rows = processes.map((info) =>
        info.processId + '  ' + status(info) + '  pid=' + (info.pid ?? '-') + '\n  ' +
        info.command.replace(/\s+/gu, ' ').slice(0, 200));
      return { content: safeText((rows.length > 0 ? rows.join('\n') : 'No managed processes in this CLI session.') + '\n\n' + PROCESS_COMMAND_USAGE), isError: false };
    }
    if (id === undefined || extra.length > 0 ||
        (action !== 'logs' && action !== 'read' && action !== 'stop') ||
        (action === 'stop' && cursorText !== undefined) ||
        (cursorText !== undefined && (!/^\d+$/u.test(cursorText) || !Number.isSafeInteger(Number(cursorText))))) {
      return { content: PROCESS_COMMAND_USAGE, isError: true };
    }
    const processId = resolveId(manager, id);
    if (action === 'stop') {
      const info = await manager.stop(processId);
      return { content: safeText(info.processId + '  ' + status(info)), isError: false };
    }
    // Without a cursor, show the latest page rather than the oldest retained page.
    const read = await manager.read(processId, cursorText === undefined ? 0 : Number(cursorText), cursorText === undefined ? 65_536 : 8_000);
    const output = read.output.slice(-8_000);
    const truncated = read.truncated || read.output.length > output.length;
    const diagnostic = sandboxFailure(read.output, read.process.state === 'exited' && read.process.exitCode !== 0, read.process.sandbox);
    const content = processId + '  ' + status(read.process) + '\n' +
      (truncated ? '[older output omitted]\n' : '') + (output || '(no output)') +
      (diagnostic.hint === undefined ? '' : '\n\n' + diagnostic.hint) +
      '\n\nNext: /process logs ' + processId + ' ' + read.nextCursor;
    return { content: safeText(content), isError: false };
  } catch (error) {
    return { content: safeText('Process command failed: ' + (error instanceof Error ? error.message : String(error))), isError: true };
  }
}
