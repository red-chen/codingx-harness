import { link, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CodingxError } from '../util/errors.js';
import { fileVersion, optionalVersion, sameVersion, type FileVersion } from './read-tracker.js';
import type { ToolContext } from './types.js';

export interface FileSnapshot { version?: FileVersion; bytes?: Buffer }
export interface FileChangeCommit {
  (version: FileVersion | undefined): Promise<void>;
  prepared?(version: FileVersion | undefined): Promise<void>;
}
export interface FileChangeRecorder {
  prepare(target: string, before: FileSnapshot, after: Buffer | undefined): Promise<FileChangeCommit>;
}
export async function snapshot(target: string): Promise<FileSnapshot> {
  const version = optionalVersion(target);
  if (!version) return {};
  const bytes = await readFile(target);
  const { digest } = await import('../session/objects.js');
  if (digest(bytes) !== version.sha256 || !sameVersion(version, optionalVersion(target))) throw new CodingxError('FILE_CHANGED', 'File changed while capturing checkpoint: ' + target);
  return { version, bytes };
}
export function assertVersion(target: string, expected: FileVersion | undefined, code: 'FILE_CHANGED' | 'UNDO_CONFLICT' = 'FILE_CHANGED'): void {
  if (!sameVersion(expected, optionalVersion(target))) throw new CodingxError(code, 'File changed: ' + target + '. Read it again; no overwrite was performed.');
}
export async function replaceFile(target: string, bytes: Buffer | undefined, expected: FileVersion | undefined, mode?: number, beforeCommit?: (version: FileVersion | undefined) => Promise<void>): Promise<FileVersion | undefined> {
  const parent = path.dirname(target);
  const initialParent = await stat(parent);
  const checkParent = async (): Promise<void> => {
    const current = await stat(parent);
    if (await realpath(parent) !== parent || current.dev !== initialParent.dev || current.ino !== initialParent.ino) throw new CodingxError('FILE_CHANGED', 'Parent directory changed: ' + parent);
  };
  await checkParent();
  const temp = path.join(parent, '.codingx-' + randomUUID() + '.tmp');
  if (bytes === undefined) { await beforeCommit?.(undefined); await checkParent(); assertVersion(target, expected); await unlink(target); return undefined; }
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode ?? expected?.mode ?? (0o666 & ~process.umask()));
    await handle.sync();
    await handle.close();
    const staged = { ...fileVersion(temp), path: target };
    await beforeCommit?.(staged);
    await checkParent();
    assertVersion(target, expected);
    if (expected) await rename(temp, target);
    else await link(temp, target); // exclusive creation never overwrites an appearing file
    return optionalVersion(target);
  } finally { await handle.close().catch(() => undefined); await unlink(temp).catch(() => undefined); }
}
export async function prepareWrite(ctx: ToolContext, target: string, content: string | undefined, source = target): Promise<() => Promise<FileVersion | undefined>> {
  ctx.readTracker.assertUnchanged(source);
  ctx.readTracker.assertUnchanged(target);
  const before = await snapshot(target);
  if (before.version && !ctx.readTracker.hasRead(target)) throw new CodingxError('FILE_CHANGED', 'Read required before writing ' + target);
  const bytes = content === undefined ? undefined : Buffer.from(content);
  const commit = await ctx.fileChanges?.prepare(target, before, bytes);
  return async () => {
    if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    ctx.readTracker.assertUnchanged(source);
    ctx.readTracker.assertUnchanged(target);
    const version = await replaceFile(target, bytes, before.version, undefined, async staged => {
      await commit?.prepared?.(staged);
      if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      ctx.readTracker.assertUnchanged(source);
    });
    if (version) ctx.readTracker.markRead(target, version);
    else ctx.readTracker.forget(target);
    await commit?.(version);
    return version;
  };
}
