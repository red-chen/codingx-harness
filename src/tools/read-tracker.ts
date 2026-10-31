import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { CodingxError } from '../util/errors.js';

export interface FileVersion {
  path: string;
  sha256: string;
  dev: number;
  ino: number;
  mode: number;
  link?: { dev: number; ino: number };
}
export function fileVersion(target: string, content?: Uint8Array): FileVersion {
  const entry = lstatSync(target);
  const canonical = realpathSync(target);
  const before = statSync(canonical);
  if (!before.isFile() || before.size > 16 * 1024 * 1024) throw new CodingxError('FILE_CHANGED', 'File is no longer a supported regular file: ' + target);
  const bytes = content ?? readFileSync(canonical);
  const after = statSync(canonical);
  if (!after.isFile() || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new CodingxError('FILE_CHANGED', 'File changed while reading: ' + target + '. Read it again.');
  }
  return { path: canonical, sha256: createHash('sha256').update(bytes).digest('hex'), dev: after.dev, ino: after.ino, mode: after.mode & 0o7777, ...(entry.isSymbolicLink() ? { link: { dev: entry.dev, ino: entry.ino } } : {}) };
}
export function sameVersion(a: FileVersion | undefined, b: FileVersion | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.path === b.path && a.sha256 === b.sha256 && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.link?.dev === b.link?.dev && a.link?.ino === b.link?.ino;
}
export function optionalVersion(target: string): FileVersion | undefined {
  try { return fileVersion(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
/** Versions include full-file hashes even when only a line range was returned. */
export class ReadFileTracker {
  private readonly files = new Map<string, FileVersion>();
  markRead(absolutePath: string, version = fileVersion(absolutePath)): void {
    const { link: _link, ...canonicalVersion } = version;
    for (const [key, previous] of this.files) {
      if (previous.path === version.path) this.files.set(key, { ...canonicalVersion, ...(previous.link ? { link: previous.link } : {}) });
    }
    this.files.set(path.resolve(absolutePath), version);
    this.files.set(version.path, canonicalVersion);
  }
  hasRead(absolutePath: string): boolean { return this.files.has(path.resolve(absolutePath)); }
  version(absolutePath: string): FileVersion | undefined { return this.files.get(path.resolve(absolutePath)); }
  assertUnchanged(absolutePath: string): void {
    const previous = this.version(absolutePath);
    let current: FileVersion | undefined;
    if (previous) current = optionalVersion(absolutePath);
    if (previous && !sameVersion(previous, current)) {
      throw new CodingxError('FILE_CHANGED', 'File changed, was replaced or deleted: ' + absolutePath + '. Call Read again before writing.');
    }
  }
  forget(target: string): void { for (const [key, value] of this.files) if (key === target || value.path === target) this.files.delete(key); }
  clear(): void { this.files.clear(); }
  get size(): number { return new Set([...this.files.values()].map(version => version.path)).size; }
}
