import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InputHistory } from '../src/ui/input-history.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), 'codingx-input-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('global input history', () => {
  it('persists the newest 200 entries across instances, with private files and multiline text', async () => {
    const history = new InputHistory(home);
    expect(await history.load()).toEqual([]);
    for (let i = 0; i < 205; i++) history.append('input ' + i);
    history.append('multi\nline 中文');
    history.append('  ');
    await history.flush();
    const entries = await new InputHistory(home).load();
    expect(entries).toHaveLength(200);
    expect(entries[0]).toBe('input 6');
    expect(entries.at(-1)).toBe('multi\nline 中文');
    const directory = path.join(home, 'input-history');
    const files = await readdir(directory);
    expect(files).toHaveLength(200);
    expect((await stat(path.join(directory, files[0]!))).mode & 0o777).toBe(0o600);
  });

  it('merges independent writers and redacts credentials before persisting', async () => {
    const first = new InputHistory(home);
    const second = new InputHistory(home);
    for (let i = 0; i < 20; i++) {
      first.append('first ' + i);
      second.append('second ' + i);
    }
    first.append('API_KEY=secret-value-123');
    await Promise.all([first.flush(), second.flush()]);
    const entries = await second.load();
    expect(entries).toHaveLength(41);
    expect(entries).toContain('first 19');
    expect(entries).toContain('second 19');
    expect(entries).toContain('API_KEY=[REDACTED:secret]');
  });

  it('reports storage errors without rejecting flush or load', async () => {
    await writeFile(path.join(home, 'input-history'), 'not a directory');
    let errors = 0;
    const history = new InputHistory(home, () => { errors++; });
    expect(await history.load()).toEqual([]);
    history.append('text');
    await history.flush();
    expect(errors).toBe(2);
  });
});
