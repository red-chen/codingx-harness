import path from 'node:path';
import { parseShellCommand } from './shell-parse.js';
import { isLocalHost } from './network.js';

export const LOCAL_NETWORK_APPROVAL_REASON =
  'Allow local networking for this execution and its process group until it exits? ' +
  'File isolation and the session profile stay unchanged. Seatbelt includes this host’s interface addresses ' +
  'and cannot restrict wildcard listeners; bind servers to 127.0.0.1 or ::1 to avoid LAN exposure. ' +
  'This permission is for one execution only.';

/** Convenience detection only: actual network access still requires explicit approval. */
export function requestsLocalNetwork(input: unknown, cwd: string): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const record = input as Record<string, unknown>;
  if (record.network === 'local') return true;
  if (record.network === 'inherit' || typeof record.command !== 'string') return false;
  return parseShellCommand(record.command, cwd).segments.some((segment) => {
    const program = path.basename(segment.program);
    const args = segment.args;
    if (/^python(?:\d+(?:\.\d+)*)?$/u.test(program)) {
      return args.some((arg, index) => arg === '-m' && ['http.server', 'uvicorn'].includes(args[index + 1] ?? ''));
    }
    if (['vite', 'uvicorn', 'http-server'].includes(program)) return true;
    if (program === 'next') return args[0] === 'dev' || args[0] === 'start';
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) {
      return args[0] === 'dev' || args[0] === 'start' || (args[0] === 'run' && ['dev', 'start'].includes(args[1] ?? ''));
    }
    if (program === 'npx') return ['vite', 'next', 'http-server'].includes(args[0] ?? '');
    if (['curl', 'wget'].includes(program)) {
      return args.some((arg) => {
        try { const url = new URL(arg); return ['http:', 'https:'].includes(url.protocol) && isLocalHost(url.hostname); }
        catch { return false; }
      });
    }
    return false;
  });
}
