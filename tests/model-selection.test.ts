import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createProvider } from '../src/providers/index.js';
import { ProviderRouter } from '../src/routing/index.js';
import type { AgentLoop } from '../src/agent/index.js';
import type { SessionHandle } from '../src/session/index.js';
import type { CliApp } from '../src/cli/bootstrap.js';
import { changeModelSelection, configuredModels, resolveModelSelection } from '../src/cli/model-selection.js';

let root: string;
let app: CliApp;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codingx-model-selection-'));
  await writeFile(path.join(root, 'config.toml'), `
[provider.zhipu]
endpoint = "http://127.0.0.1:1"
api_key_env = "ZHIPU_TEST_KEY"
[provider.deepseek]
endpoint = "http://127.0.0.1:2"
api_key_env = "DEEPSEEK_TEST_KEY"
[[routes.default.targets]]
provider = "zhipu"
model = "glm-5.3"
[[routes.deepseek.targets]]
provider = "deepseek"
model = "deepseek-flash"
[[routes.duplicate.targets]]
provider = "deepseek"
model = "deepseek-flash"
`);
  const loaded = await loadConfig({ cwd: root, codingxHome: root, env: {} });
  const router = new ProviderRouter({
    routeName: 'default', route: loaded.config.routes.default!,
    providers: { zhipu: createProvider('zhipu', loaded.config.providers.zhipu!, 'original-test-key') },
  });
  app = { config: loaded.config, loaded, router, codingxHome: root, cwd: root } as CliApp;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('configured model selection', () => {
  it('lists targets from every provider and deduplicates repeated provider/model pairs', () => {
    expect(configuredModels(app.config)).toEqual([
      { model: 'glm-5.3', provider: 'zhipu', route: 'default' },
      { model: 'deepseek-flash', provider: 'deepseek', route: 'deepseek' },
    ]);
  });

  it('resolves configured model names and explicit provider/model names', () => {
    expect(resolveModelSelection(app, { model: 'deepseek-flash', reasoningEffort: 'high' })).toEqual({
      model: 'deepseek-flash', provider: 'deepseek', route: 'deepseek', reasoningEffort: 'high',
    });
    expect(resolveModelSelection(app, { model: 'deepseek/deepseek-flash' })).toEqual({
      model: 'deepseek-flash', provider: 'deepseek', route: 'deepseek',
    });
    expect(resolveModelSelection(app, { model: 'custom-model' })).toEqual({
      model: 'custom-model', provider: 'zhipu', route: 'default',
    });
  });

  it('retains an explicit provider for identical model names', () => {
    app.config.routes.deepseek!.targets[0]!.model = 'glm-5.3';
    expect(resolveModelSelection(app, { model: 'glm-5.3', provider: 'deepseek' })).toMatchObject({
      provider: 'deepseek', route: 'deepseek',
    });
    expect(resolveModelSelection(app, { model: 'glm-5.3' }).provider).toBe('zhipu');
  });

  it('keeps the active client and history unchanged when credentials are missing', async () => {
    const router = app.router;
    const append = vi.fn();
    const setRouter = vi.fn();
    await expect(changeModelSelection(app, { append } as unknown as SessionHandle,
      { setRouter } as unknown as AgentLoop, { model: 'deepseek-flash' }, {})).rejects.toThrow(/No API key.*deepseek/);
    expect(app.router).toBe(router);
    expect(append).not.toHaveBeenCalled();
    expect(setRouter).not.toHaveBeenCalled();
  });

  it('does not switch clients when the rollout append fails and never persists credentials', async () => {
    const router = app.router;
    const append = vi.fn().mockRejectedValue(new Error('disk full'));
    const setRouter = vi.fn();
    await expect(changeModelSelection(app, { append } as unknown as SessionHandle,
      { setRouter } as unknown as AgentLoop, { model: 'deepseek-flash' },
      { DEEPSEEK_TEST_KEY: 'private-test-key' })).rejects.toThrow('disk full');
    expect(app.router).toBe(router);
    expect(setRouter).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith({
      type: 'model.changed', model: 'deepseek-flash', provider: 'deepseek', route: 'deepseek',
    });
    expect(JSON.stringify(append.mock.calls)).not.toContain('private-test-key');
  });

  it('reports a cwd save failure while keeping the audited live selection consistent', async () => {
    await writeFile(path.join(root, 'workspaces'), 'not a directory');
    const append = vi.fn().mockResolvedValue(undefined);
    const setRouter = vi.fn();
    const setReasoningEffort = vi.fn();
    const applied = await changeModelSelection(app, { append } as unknown as SessionHandle,
      { setRouter, setReasoningEffort } as unknown as AgentLoop,
      { model: 'deepseek-flash', reasoningEffort: 'high' }, { DEEPSEEK_TEST_KEY: 'private-test-key' });
    expect(applied.persistenceWarning).toContain('cwd preferences could not be saved');
    expect(app.router.providerId).toBe('deepseek');
    expect(setRouter).toHaveBeenCalledWith(app.router, 'deepseek-flash');
    expect(setReasoningEffort).toHaveBeenCalledWith('high');
    expect(append).toHaveBeenCalledOnce();
  });
});
