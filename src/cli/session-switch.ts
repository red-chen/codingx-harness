import { buildSystemPrompt } from '../agent/system-prompt.js';
import { sandboxSummary } from '../sandbox/index.js';
import type { CliApp } from './bootstrap.js';
import type { SessionHandle, SessionStoreApi } from '../session/types.js';
import { canonicalizePath } from '../util/paths.js';
import { SessionBusyError, SessionError } from '../util/errors.js';
import { rebuildHistory } from '../agent/history.js';
import { validateImageSnapshots } from '../agent/attachments.js';
import type { PickerEntry } from '../tui/state/types.js';

/** Shared history repair for startup and in-process switches. */
export async function restoreSessionHistory(session: SessionHandle) {
  const events = await session.replay();
  const rebuilt = rebuildHistory(events);
  // Fail explicitly before switching away if an image snapshot is missing/corrupt.
  await validateImageSnapshots(rebuilt.messages, session);
  if (rebuilt.syntheticResults.length) await session.append(rebuilt.syntheticResults.map(result => ({ type: 'tool.result', ...result })));
  return { events, rebuilt };
}
export async function acquireResumable(store: SessionStoreApi, cwd: string, id: string): Promise<SessionHandle> {
  const canonical = await canonicalizePath(cwd);
  const matches = (await store.listSessions()).filter(s => s.id === id || s.id.startsWith(id));
  if (matches.length !== 1) throw new SessionError('Session ID is missing or ambiguous.');
  const target = matches[0]!;
  if (await canonicalizePath(target.cwd) !== canonical) throw new SessionError('Session belongs to another workspace.');
  if (target.status === 'ended') throw new SessionError('Session ended. Use --fork ' + target.id + '.');
  if (target.status !== 'idle' && target.status !== 'interrupted') throw new SessionBusyError('Session is active and cannot be taken over.');
  const handle = await store.attachSession(target.id, 'write');
  try { await restoreSessionHistory(handle); return handle; }
  catch (error) { await handle.close(); throw error; }
}
export async function sessionEntries(store: SessionStoreApi, cwd: string): Promise<PickerEntry[]> {
  const canonical = await canonicalizePath(cwd);
  const entries: PickerEntry[] = [];
  for (const session of await store.listSessions()) {
    if (await canonicalizePath(session.cwd) !== canonical) continue;
    const events = await store.replaySession(session.id);
    const messages = events.filter(e => e.type === 'user.message' || e.type === 'assistant.message');
    const title = String(messages.find(e => e.type === 'user.message')?.text ?? '(untitled)').replace(/\s+/g,' ').slice(0,60);
    const recent = String(messages.at(-1)?.text ?? '(no messages)').replace(/\s+/g,' ').slice(0,240);
    entries.push({ value: session.id, label: title + ' · ' + session.id + ' · ' + session.status + ' · ' + session.updatedAt, detail: recent, disabled: session.status !== 'idle' && session.status !== 'interrupted' });
  }
  return entries;
}

/** Rebuild per-session hook context so switching never accumulates an old session's context. */
export async function startSessionContext(app: CliApp, session: SessionHandle) {
  const hooks = await app.hooks.run('session_start', { sessionId: session.id, cwd: app.cwd }, { session });
  app.sessionHookContext = hooks.context.trim() || undefined;
  app.systemPrompt = buildSystemPrompt(app.snapshot, {
    skills: app.skills.summaries(),
    ...(app.additionalDirs.length ? { additionalDirs: app.additionalDirs } : {}),
    permissionProfile: app.policy.profileName, approvalPolicy: app.policy.approvalPolicy,
    sandbox: sandboxSummary(app.sandbox.status, app.policy.sandboxPolicy),
    ...(app.yolo ? { yolo: true } : {}),
  });
  if (app.sessionHookContext) app.systemPrompt += '\n\n# Hook context (session_start)\n' + app.sessionHookContext;
  return hooks;
}
