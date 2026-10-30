import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { legacyWorkspaceKey, workspaceKey } from '../src/util/workspace.js';
import { InputHistory } from '../src/ui/input-history.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), 'codingx-input-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('cwd input history', () => {
  it('isolates exact directories, ignores legacy global entries, and shares symlink aliases', async () => {
    const cwd = path.join(home, 'repo');
    const nested = path.join(cwd, 'nested');
    await mkdir(nested, { recursive: true });
    const alias = path.join(home, 'alias');
    await symlink(cwd, alias);
    const first = await InputHistory.open(home, cwd);
    first.append('only this repo');
    await first.flush();
    const legacy = path.join(home, 'input-history', '1700000000000-000000-abcdef.json');
    await writeFile(legacy, JSON.stringify('old global input'));
    expect(await (await InputHistory.open(home, alias)).load()).toEqual(['only this repo']);
    expect(await (await InputHistory.open(home, nested)).load()).toEqual([]);
    const other = await InputHistory.open(home, nested);
    for (let i = 0; i < 205; i++) other.append('nested ' + i);
    await other.flush();
    expect(await first.load()).toEqual(['only this repo']);
    expect(await other.load()).toHaveLength(200);
    expect((await stat(legacy)).isFile()).toBe(true);
  });

  it('persists the newest 200 entries across instances, with private files and multiline text', async () => {
    const history = await InputHistory.open(home, home);
    expect(await history.load()).toEqual([]);
    for (let i = 0; i < 205; i++) history.append('input ' + i);
    history.append('multi\nline 中文');
    history.append('  ');
    await history.flush();
    const entries = await (await InputHistory.open(home, home)).load();
    expect(entries).toHaveLength(200);
    expect(entries[0]).toBe('input 6');
    expect(entries.at(-1)).toBe('multi\nline 中文');
    const directory = path.join(home, 'input-history', await workspaceKey(home));
    const files = (await readdir(directory)).filter((name) => name !== 'cwd.json');
    expect(files).toHaveLength(200);
    expect((await stat(path.join(directory, files[0]!))).mode & 0o777).toBe(0o600);
  });

  it('merges independent writers and redacts credentials before persisting', async () => {
    const first = await InputHistory.open(home, home);
    const second = await InputHistory.open(home, home);
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

  it('reads old hash directories and keeps colliding readable names isolated', async () => {
    const firstCwd = path.join(home, 'a-b', 'c');
    const secondCwd = path.join(home, 'a', 'b-c');
    await mkdir(firstCwd, { recursive: true });
    await mkdir(secondCwd, { recursive: true });
    const legacy = path.join(home, 'input-history', await legacyWorkspaceKey(firstCwd));
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, '1700000000000-000000-abcdef.json'), JSON.stringify('old entry'));
    const first = await InputHistory.open(home, firstCwd);
    const second = await InputHistory.open(home, secondCwd);
    first.append('first');
    second.append('second');
    await Promise.all([first.flush(), second.flush()]);
    expect(await first.load()).toEqual(['old entry', 'first']);
    expect(await second.load()).toEqual(['second']);
    expect(await (await InputHistory.open(home, firstCwd)).load()).toEqual(['old entry', 'first']);
  });

  it('reports storage errors without rejecting flush or load', async () => {
    await writeFile(path.join(home, 'input-history'), 'not a directory');
    let errors = 0;
    const history = await InputHistory.open(home, home, () => { errors++; });
    expect(await history.load()).toEqual([]);
    history.append('text');
    await history.flush();
    expect(errors).toBe(2);
  });
});
