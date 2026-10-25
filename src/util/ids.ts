import { randomUUID } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_SESSION_ID_RE = /^[0-9a-z]{12}$/;

/** New sessions use a UUID v4; legacy 12-char ids remain readable. */
export function generateSessionId(): string {
  return randomUUID();
}

export function isValidSessionId(value: string): boolean {
  return UUID_RE.test(value) || LEGACY_SESSION_ID_RE.test(value);
}

/** Resolve a full id or a unique prefix, mirroring the CLI contract. */
export function resolveSessionId(input: string, ids: readonly string[]): string {
  if (ids.includes(input)) return input;
  const matches = ids.filter((id) => id.startsWith(input));
  if (matches.length === 1) return matches[0] as string;
  if (matches.length === 0) throw new Error('No session matches ' + input);
  throw new Error('Session prefix ' + input + ' is ambiguous: ' + matches.join(', '));
}

/** RFC 3339 UTC timestamp with colons replaced for filesystem safety. */
export function formatSessionTimestamp(date = new Date()): string {
  return date.toISOString().slice(0, 19).replaceAll(':', '-');
}

export function sessionFileName(id: string, date = new Date()): string {
  return formatSessionTimestamp(date) + '_' + id + '.jsonl';
}

export function generateEventId(): string {
  return randomUUID();
}

export function generateTurnId(): string {
  return 'turn_' + randomUUID().replaceAll('-', '').slice(0, 16);
}

export function generateRequestId(): string {
  return randomUUID();
}