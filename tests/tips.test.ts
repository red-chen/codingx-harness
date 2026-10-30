import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TIPS, loadTips, selectTip } from '../src/ui/tips.js';
import { createTuiAppForSession } from '../src/cli/commands/tui.js';

let root: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codingx-tips-'));
  home = path.join(root, 'custom-home');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('startup tips', () => {
  it('creates an editable default file under the supplied CODINGX_HOME', async () => {
    const loaded = await loadTips(home);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.config).toEqual({ enabled: true, tips: DEFAULT_TIPS });
    const filename = path.join(home, 'tips.json');
    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual(loaded.config);
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    expect(selectTip(loaded.config, () => 0)).toBe(DEFAULT_TIPS[0]);
    expect(selectTip(loaded.config, () => 0.999)).toBe(DEFAULT_TIPS.at(-1));
  });

  it('uses edited tips after restart without overwriting them, and passes the tip into the TUI', async () => {
    await loadTips(home);
    const custom = JSON.stringify({ tips: ['Use /help for shortcuts.'] });
    await writeFile(path.join(home, 'tips.json'), custom);
    const loaded = await loadTips(home);
    const tip = selectTip(loaded.config)!;
    const app = createTuiAppForSession({
      tip, sessionId: 's', cwd: '/work', model: 'm', permissionProfile: ':workspace',
      approvalPolicy: 'on-request', contextWindow: 1000, version: '0.1.0', width: 80, height: 24, resumed: {},
    });
    expect(app.state.tip).toBe('Use /help for shortcuts.');
    app.resetSession();
    expect(app.state.tip).toBe(tip);
    expect(app.state.transcript).toEqual([]);
    expect(await readFile(path.join(home, 'tips.json'), 'utf8')).toBe(custom);
  });

  it.each([
    { enabled: false, tips: ['hidden'] },
    { tips: [] },
    { tips: [' ', '\n\t', '\u001b[31m'] },
  ])('hides tips when disabled or the list is empty: %j', async (config) => {
    await mkdir(home);
    await writeFile(path.join(home, 'tips.json'), JSON.stringify(config));
    const loaded = await loadTips(home);
    expect(loaded.warnings).toEqual([]);
    expect(selectTip(loaded.config)).toBeUndefined();
  });

  it.each(['{broken', '{"tips":[123]}', '{"enabled":"false"}'])('falls back without replacing invalid configuration: %s', async (contents) => {
    await mkdir(home);
    await writeFile(path.join(home, 'tips.json'), contents);
    const loaded = await loadTips(home);
    expect(loaded.config.tips).toEqual(DEFAULT_TIPS);
    expect(loaded.warnings).toHaveLength(1);
    expect(await readFile(path.join(home, 'tips.json'), 'utf8')).toBe(contents);
  });

  it('keeps working when the configuration cannot be created', async () => {
    await writeFile(home, 'not a directory');
    const loaded = await loadTips(home);
    expect(loaded.config.tips).toEqual(DEFAULT_TIPS);
    expect(loaded.warnings).toHaveLength(1);
  });

  it('strips terminal controls and normalizes custom text', () => {
    expect(selectTip({ enabled: true, tips: [' \u001b[31mHello\u001b[0m\n世界\t!\u001b]2;injected\u0007'] }))
      .toBe('Hello 世界 !');
  });
});
