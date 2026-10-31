import { canonicalizePath } from '../util/paths.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionHandle } from './types.js';
import type { ObjectRef } from './objects.js';
import { CodingxError } from '../util/errors.js';
import { assertVersion, replaceFile, type FileChangeCommit, type FileChangeRecorder, type FileSnapshot } from '../tools/file-mutation.js';
import { optionalVersion, sameVersion, type FileVersion, type ReadFileTracker } from '../tools/read-tracker.js';
import { createFileDiff } from '../tools/file-diff.js';

interface StoredSnapshot { version?: FileVersion; object?: ObjectRef }
interface Change { id: string; turnId: string; path: string; before: StoredSnapshot; after: StoredSnapshot }
export class FileChanges {
  private pending: Change[] | undefined;
  constructor(private readonly session: SessionHandle, private readonly cwd: string, private readonly tracker: ReadFileTracker, private readonly authorize?: (target: string) => Promise<void>) {}
  forTurn(turnId: string): FileChangeRecorder {
    return { prepare: async (target, before, after) => {
      if (!this.session.putObject || !this.session.getObject) throw new CodingxError('OBJECT_ERROR', 'Session storage does not support checkpoints; file modification stopped.');
      const beforeStored = await this.store(before);
      const afterObject = after === undefined ? undefined : await this.session.putObject(after);
      const id = randomUUID();
      await this.session.append({ type: 'file.change.prepared', id, turnId, path: target, before: beforeStored, after: { object: afterObject } });
      const commit: FileChangeCommit = async version => {
        try { await this.session.append({ type: 'file.change', id, turnId, path: target, before: beforeStored, after: { version, object: afterObject } }); }
        catch (cause) { throw new CodingxError('OBJECT_ERROR', 'File changed; completion audit failed. The durable checkpoint can be recovered with /changes.', { cause }); }
      };
      commit.prepared = async version => {
        await this.session.append({ type: 'file.change.ready', id, turnId, path: target, before: beforeStored, after: { version, object: afterObject } });
      };
      return commit;
    } };
  }
  private async store(snapshot: FileSnapshot): Promise<StoredSnapshot> {
    return { version: snapshot.version, ...(snapshot.bytes === undefined ? {} : { object: await this.session.putObject!(snapshot.bytes) }) };
  }
  async list(): Promise<Change[]> {
    const events = await this.session.replay();
    const complete = new Set(events.filter(e => e.type === 'file.change').map(e => e.id));
    for (const event of events.filter(e => e.type === 'file.change.ready' && !complete.has(e.id))) {
      const change = event as unknown as Change;
      if (sameVersion(change.after.version, optionalVersion(change.path))) {
        const recovered = await this.session.append({ type: 'file.change', id: change.id, turnId: change.turnId, path: change.path, before: change.before, after: change.after, recovered: true });
        events.push(...recovered);
      }
    }
    const undone = new Set(events.filter(e => e.type === 'file.undo').flatMap(e => e.changeIds as string[]));
    const changes = events.filter(e => e.type === 'file.change' && !undone.has(e.id as string)).map(e => e as unknown as Change);
    const groups = new Map<string, Change>();
    for (const change of changes) {
      const key = change.turnId + '\0' + change.path;
      const first = groups.get(key);
      groups.set(key, first ? { ...change, before: first.before } : change);
    }
    return [...groups.values()];
  }
  async command(line: string): Promise<string> {
    if (line.trim() === '/changes') {
      const changes = await this.list();
      return changes.length ? changes.map(c => c.turnId + '  ' + path.relative(this.cwd, c.path) + (!c.after.object ? ' deleted' : c.before.object ? ' modified' : ' created')).join('\n') : 'No pending file-tool changes. Shell changes are not tracked.';
    }
    const match = /^\/undo\s+(\S+)(?:\s+(.+?))?(\s+--confirm)?$/.exec(line.trim());
    if (!match) return 'Usage: /undo <turn-id> [path]. Preview first, then repeat with --confirm.';
    const turnId = match[1]!;
    let selectedPath = match[2];
    let confirm = Boolean(match[3]);
    if (selectedPath === '--confirm') { selectedPath = undefined; confirm = true; }
    if (selectedPath?.startsWith('"') && selectedPath.endsWith('"')) selectedPath = selectedPath.slice(1,-1);
    const selectedAbsolute = selectedPath ? await canonicalizePath(path.resolve(this.cwd, selectedPath)) : undefined;
    const changes = (await this.list()).filter(c => c.turnId === turnId && (!selectedAbsolute || c.path === selectedAbsolute));
    if (!changes.length) return 'No matching changes.';
    for (const c of changes) assertVersion(c.path, c.after.version, 'UNDO_CONFLICT');
    if (!confirm) {
      this.pending = changes;
      const previews = [];
      for (const c of changes) {
        const before = c.before.object ? (await this.session.getObject!(c.before.object)).toString('utf8') : '';
        const after = c.after.object ? (await this.session.getObject!(c.after.object)).toString('utf8') : '';
        previews.push(JSON.stringify(createFileDiff(path.relative(this.cwd, c.path), after, before)));
      }
      return previews.join('\n') + '\nConfirm: ' + line.trim() + ' --confirm';
    }
    if (JSON.stringify(changes) !== JSON.stringify(this.pending)) throw new CodingxError('UNDO_CONFLICT', 'Preview changed or missing. Run /undo without --confirm first.');
    for (const change of changes) await this.authorize?.(change.path);
    const snapshots = [];
    for (const c of changes) snapshots.push(c.before.object ? await this.session.getObject!(c.before.object) : undefined);
    for (const c of changes) assertVersion(c.path, c.after.version, 'UNDO_CONFLICT');
    const events = await this.session.replay();
    for (let i = 0; i < changes.length; i++) {
      const c = changes[i]!;
      assertVersion(c.path, c.after.version, 'UNDO_CONFLICT');
      await this.session.append({ type: 'file.undo.prepared', turnId, path: c.path, before: c.after, after: c.before });
      const restored = await replaceFile(c.path, snapshots[i], c.after.version, c.before.version?.mode);
      const changeIds = events.filter(e => e.type === 'file.change' && e.turnId === turnId && e.path === c.path).map(e => e.id);
      await this.session.append({ type: 'file.undo', turnId, path: c.path, changeIds, version: restored, text: 'User undid file-tool changes from turn ' + turnId + ' in ' + c.path + '. Re-read before editing.' });
    }
    this.tracker.clear();
    this.pending = undefined;
    return 'Undid ' + changes.length + ' file(s). Conversation history retained.';
  }
}
