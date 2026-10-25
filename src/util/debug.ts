import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Opt-in debug tracing for hard-to-reproduce terminal issues.
 *
 * Set `CODINGX_DEBUG=clipboard` (or a comma-separated list of scopes, or `*`)
 * and lines are appended to `~/.codingx/debug.log`. Disabled by default; the
 * logger never throws so it cannot break the TUI.
 */
const scopes = new Set(
  (process.env.CODINGX_DEBUG ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0),
);

export function debugLog(scope: string, message: string): void {
  if (!scopes.has(scope) && !scopes.has('*')) return;
  try {
    const directory = path.join(homedir(), '.codingx');
    mkdirSync(directory, { recursive: true });
    appendFileSync(path.join(directory, 'debug.log'), new Date().toISOString() + ' [' + scope + '] ' + message + '\n');
  } catch {
    // Debug logging must never affect the TUI.
  }
}
