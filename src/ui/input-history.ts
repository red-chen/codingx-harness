import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactString } from '../util/redact.js';
import { legacyWorkspaceKey, workspaceDirectory } from '../util/workspace.js';
import { canonicalizePath } from '../util/paths.js';

export const INPUT_HISTORY_LIMIT = 200;

/** Per-cwd input recall, separate from conversation rollouts. Each submission is
 * atomic and uniquely named, so simultaneous CLIs never overwrite each other. */
export class InputHistory {
  private pending: Promise<void> = Promise.resolve();
  private sequence = 0;

  private constructor(private readonly root: string, private readonly cwd: string, private readonly onError: () => void) {}

  static async open(home: string, cwd: string, onError: () => void = () => {}): Promise<InputHistory> {
    return new InputHistory(path.join(home, 'input-history'), await canonicalizePath(cwd), onError);
  }

  private async directoryEntries(directory: string): Promise<string[]> {
    try {
      return (await readdir(directory)).filter((name) => /^\d{13}-\d{6}-[a-f0-9-]+\.json$/u.test(name))
        .map((name) => path.join(directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async entries(): Promise<string[]> {
    const directory = await workspaceDirectory(this.root, this.cwd);
    const legacy = path.join(this.root, await legacyWorkspaceKey(this.cwd));
    let ownsDirectory = false;
    try { ownsDirectory = JSON.parse(await readFile(path.join(directory, 'cwd.json'), 'utf8')) === this.cwd; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const entries = (await Promise.all([
      ownsDirectory ? this.directoryEntries(directory) : [], this.directoryEntries(legacy),
    ])).flat();
    return entries.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  }

  async load(): Promise<string[]> {
    try {
      const entries = await this.entries();
      const values = await Promise.all(entries.slice(-INPUT_HISTORY_LIMIT).map(async (name) => {
        try {
          const value: unknown = JSON.parse(await readFile(name, 'utf8'));
          return typeof value === 'string' && value.trim() ? value : undefined;
        } catch { return undefined; }
      }));
      return values.filter((value): value is string => value !== undefined);
    } catch {
      this.onError();
      return [];
    }
  }

  append(text: string): void {
    if (!text.trim()) return;
    const value = redactString(text).value;
    const name = `${Date.now()}-${String(this.sequence++ % 1000000).padStart(6, '0')}-${randomUUID()}.json`;
    this.pending = this.pending.then(async () => {
      const directory = await workspaceDirectory(this.root, this.cwd, true);
      const target = path.join(directory, name);
      const temporary = target + '.tmp';
      try {
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      const entries = await this.entries();
      await Promise.all(entries.slice(0, Math.max(0, entries.length - INPUT_HISTORY_LIMIT)).map(
        (entry) => unlink(entry).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        }),
      ));
    }).catch(() => { this.onError(); });
  }

  async flush(): Promise<void> { await this.pending; }
}
