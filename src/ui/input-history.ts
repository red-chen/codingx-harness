import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactString } from '../util/redact.js';

export const INPUT_HISTORY_LIMIT = 200;

/** Global input recall, separate from conversation rollouts. Each submission is
 * atomic and uniquely named, so simultaneous CLIs never overwrite each other. */
export class InputHistory {
  private readonly directory: string;
  private pending: Promise<void> = Promise.resolve();
  private sequence = 0;

  constructor(home: string, private readonly onError: () => void = () => {}) {
    this.directory = path.join(home, 'input-history');
  }

  private async entries(): Promise<string[]> {
    try {
      return (await readdir(this.directory)).filter((name) => /^\d{13}-\d{6}-[a-f0-9-]+\.json$/u.test(name)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async load(): Promise<string[]> {
    try {
      const entries = await this.entries();
      const values = await Promise.all(entries.slice(-INPUT_HISTORY_LIMIT).map(async (name) => {
        try {
          const value: unknown = JSON.parse(await readFile(path.join(this.directory, name), 'utf8'));
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
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const target = path.join(this.directory, name);
      const temporary = target + '.tmp';
      try {
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      const entries = await this.entries();
      await Promise.all(entries.slice(0, Math.max(0, entries.length - INPUT_HISTORY_LIMIT)).map(
        (entry) => unlink(path.join(this.directory, entry)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        }),
      ));
    }).catch(() => { this.onError(); });
  }

  async flush(): Promise<void> { await this.pending; }
}
