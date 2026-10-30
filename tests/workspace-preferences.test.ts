import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkspacePreferencesStore } from '../src/config/workspace-preferences.js';
import { loadConfig } from '../src/config/index.js';
import { legacyWorkspaceKey } from '../src/util/workspace.js';
import { canonicalizePath } from '../src/util/paths.js';

let root: string;
let home: string;
let cwd: string;
const model = { model: 'saved-model', provider: 'secondary', route: 'secondary', reasoningEffort: 'high' as const };
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codingx-workspace-prefs-'));
  home = path.join(root, 'home');
  cwd = path.join(root, 'repo');
  await mkdir(home);
  await mkdir(cwd);
  await writeFile(path.join(home, 'config.toml'), `
[model]
reasoning_effort = "low"
[provider.primary]
endpoint = "http://127.0.0.1:1"
[provider.secondary]
endpoint = "http://127.0.0.1:2"
[[routes.default.targets]]
provider = "primary"
model = "default-model"
[[routes.secondary.targets]]
provider = "secondary"
model = "second-model"
`);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('cwd preferences', () => {
  it('persists model and permission independently across instances with private atomic files', async () => {
    const first = await WorkspacePreferencesStore.open(home, cwd);
    const second = await WorkspacePreferencesStore.open(home, cwd);
    await Promise.all([first.saveModel(model), second.savePermissionProfile(':read-only')]);
    expect(await (await WorkspacePreferencesStore.open(home, cwd)).load()).toEqual({ model, permissionProfile: ':read-only' });
    expect((await readdir(first.directory)).sort()).toEqual(['cwd.json', 'model.json', 'permissions.json']);
    expect((await stat(path.join(first.directory, 'model.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(first.directory)).mode & 0o777).toBe(0o700);
  });

  it('isolates exact cwd values but treats symlink aliases as the same directory', async () => {
    const store = await WorkspacePreferencesStore.open(home, cwd);
    await store.saveModel(model);
    const nested = path.join(cwd, 'nested');
    await mkdir(nested);
    expect(await (await WorkspacePreferencesStore.open(home, nested)).load()).toEqual({});
    const alias = path.join(root, 'alias');
    await symlink(cwd, alias);
    expect((await (await WorkspacePreferencesStore.open(home, alias)).load()).model).toEqual(model);
  });

  it('reads legacy hash preferences and separates colliding readable paths on write', async () => {
    const firstCwd = path.join(root, 'a-b', 'c');
    const secondCwd = path.join(root, 'a', 'b-c');
    await mkdir(firstCwd, { recursive: true });
    await mkdir(secondCwd, { recursive: true });
    const legacy = path.join(home, 'workspaces', await legacyWorkspaceKey(firstCwd));
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, 'model.json'), JSON.stringify({ version: 1, cwd: await canonicalizePath(firstCwd), value: model }));
    const first = await WorkspacePreferencesStore.open(home, firstCwd);
    const second = await WorkspacePreferencesStore.open(home, secondCwd);
    expect((await first.load()).model).toEqual(model);
    await Promise.all([first.saveModel({ ...model, model: 'first' }), second.saveModel({ ...model, model: 'second' })]);
    expect(first.directory).not.toBe(second.directory);
    expect((await (await WorkspacePreferencesStore.open(home, firstCwd)).load()).model?.model).toBe('first');
    expect((await second.load()).model?.model).toBe('second');
  });

  it('loads cwd defaults above TOML while explicit CLI/env overrides remain temporary', async () => {
    const store = await WorkspacePreferencesStore.open(home, cwd);
    await store.saveModel(model);
    await store.savePermissionProfile(':read-only');
    const load = (env: NodeJS.ProcessEnv = {}, cli = {}) => loadConfig({ cwd, codingxHome: home, env, cli });
    const saved = await load();
    expect(saved.config.model).toMatchObject({ route: 'secondary', reasoningEffort: 'high' });
    expect(saved.config.permissions.defaultProfile).toBe(':read-only');
    expect(saved.overrides).toEqual({});
    const explicit = await load({ CODINGX_REASONING_EFFORT: 'medium' }, { route: 'default', reasoningEffort: 'default', sandboxMode: 'workspace-write' });
    expect(explicit.config.model.reasoningEffort).toBeUndefined();
    expect(explicit.config.model.route).toBe('default');
    expect(explicit.config.permissions.defaultProfile).toBe(':workspace');
    expect((await load({}, { dangerouslyBypass: true })).config.permissions.defaultProfile).toBe(':danger-full-access');
    expect((await load()).config.permissions.defaultProfile).toBe(':read-only');
    expect((await load()).config.model.reasoningEffort).toBe('high');
    await store.saveModel({ ...model, reasoningEffort: 'default' });
    expect((await load()).config.model.reasoningEffort).toBeUndefined();
  });

  it('ignores corrupt data and removed config references with an explicit warning', async () => {
    const store = await WorkspacePreferencesStore.open(home, cwd);
    await store.saveModel({ ...model, provider: 'removed' });
    await store.savePermissionProfile('deleted-profile');
    const loaded = await loadConfig({ cwd, codingxHome: home, env: {} });
    expect(loaded.workspacePreferences).toEqual({});
    expect(loaded.config.model.reasoningEffort).toBe('low');
    expect(loaded.config.permissions.defaultProfile).toBe(':workspace');
    expect(loaded.warnings.join(' ')).toMatch(/removed provider.*profile no longer exists/);
    await writeFile(path.join(store.directory, 'model.json'), '{broken');
    const warnings: string[] = [];
    expect((await store.load(warnings)).model).toBeUndefined();
    expect(warnings[0]).toContain('Could not read cwd model preferences');
  });

  it('rejects unknown fields instead of persisting credentials or unrelated settings', async () => {
    const store = await WorkspacePreferencesStore.open(home, cwd);
    await store.saveModel(model);
    await expect(store.saveModel({ ...model, apiKey: 'private-key' } as typeof model)).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    expect(await readFile(path.join(store.directory, 'model.json'), 'utf8')).not.toContain('private-key');
  });
});
