import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalizePath } from './paths.js';

/** Human-readable directory name; ownership markers disambiguate collisions. */
export async function workspaceKey(cwd: string): Promise<string> {
  const readable = (await canonicalizePath(cwd)).replaceAll('/', '-');
  // Leave room for collision suffixes within macOS's filename byte limit.
  let key = '';
  for (const character of readable) {
    if (Buffer.byteLength(key + character) > 220) break;
    key += character;
  }
  return key;
}

export async function legacyWorkspaceKey(cwd: string): Promise<string> {
  return createHash('sha256').update(await canonicalizePath(cwd)).digest('hex');
}

/** Atomically claim a readable name; no marker or directory is created on reads. */
export async function workspaceDirectory(root: string, cwd: string, create = false): Promise<string> {
  const canonical = await canonicalizePath(cwd);
  const key = await workspaceKey(canonical);
  for (let index = 1; ; index++) {
    const directory = path.join(root, key + (index === 1 ? '' : '--' + index));
    const marker = path.join(directory, 'cwd.json');
    try {
      if (JSON.parse(await readFile(marker, 'utf8')) === canonical) return directory;
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!create) return directory;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = marker + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(canonical), { mode: 0o600, flag: 'wx' });
      try {
        // A hard link publishes the complete marker without replacing another writer's claim.
        await link(temporary, marker);
        return directory;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (JSON.parse(await readFile(marker, 'utf8')) === canonical) return directory;
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}
