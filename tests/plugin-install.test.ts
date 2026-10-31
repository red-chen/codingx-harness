import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { enablePluginInToml, installPlugin } from '../src/plugins/install.js';
import { runCli } from '../src/cli/index.js';

let root: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codingx-install-'));
  home = path.join(root, 'home');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function cli(args: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(['--cd', root, ...args], {
    env: { CODINGX_HOME: home },
    stdout: { write: (text) => { stdout += text; return true; } },
    stderr: { write: (text) => { stderr += text; return true; } },
  });
  return { code, stdout, stderr };
}

async function localSource() {
  const source = path.join(root, 'my source');
  await mkdir(source);
  const manifest = (await readFile('plugins/deepseek-cost/manifest.yaml', 'utf8')).replace('id: deepseek-cost', 'id: local-test');
  await writeFile(path.join(source, 'manifest.yaml'), manifest);
  await writeFile(path.join(source, 'index.mjs'), 'throw new Error("INSTALL MUST NOT EXECUTE THIS");');
  return source;
}

describe('plugin CLI installation', () => {
  it('installs the bundled plugin from an unrelated cwd and enables without provider configuration', async () => {
    const result = await cli(['--json', 'plugin', 'install', 'deepseek-cost', '--enable']);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 'deepseek-cost', installed: true, enabled: true });
    expect(await readFile(path.join(home, 'plugins/deepseek-cost/manifest.yaml'), 'utf8')).toContain('codingx.status-bar/v1');
    expect(parseToml(await readFile(path.join(home, 'config.toml'), 'utf8')).status_bar).toEqual({ plugin: 'deepseek-cost' });
  });

  it('installs a local directory without running code, then enables separately', async () => {
    const source = await localSource();
    const result = await cli(['plugin', 'install', './my source']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('plugin enable local-test');
    await expect(readFile(path.join(home, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(home, 'plugins/local-test/index.mjs'), 'utf8')).toEqual(await readFile(path.join(source, 'index.mjs'), 'utf8'));
    expect((await cli(['plugin', 'enable', 'local-test'])).code).toBe(0);
  });

  it('does not overwrite installed prices or plugin files on repeat installation', async () => {
    expect((await cli(['plugin', 'install', 'deepseek-cost'])).code).toBe(0);
    const pricing = path.join(home, 'plugins/deepseek-cost/pricing.json');
    await writeFile(pricing, 'historical price state');
    const result = await cli(['plugin', 'install', 'deepseek-cost', '--enable']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('files preserved');
    expect(await readFile(pricing, 'utf8')).toBe('historical price state');
    expect((await readdir(path.join(home, 'plugins'))).sort()).toEqual(['deepseek-cost']);
  });

  it('preserves global settings, comments and timeout while switching plugins', async () => {
    await mkdir(home);
    const original = '# personal config\n[model]\nmax_output_tokens = 1024\n\n[status_bar]\nplugin = "previous" # chosen\ntimeout_ms = 3000\n';
    await writeFile(path.join(home, 'config.toml'), original);
    expect((await cli(['plugin', 'install', 'deepseek-cost', '--enable'])).code).toBe(0);
    expect(await readFile(path.join(home, 'config.toml'), 'utf8')).toBe(original.replace('"previous"', '"deepseek-cost"'));
  });

  it('rejects invalid manifest and config before installation, with no partial copy', async () => {
    const source = await localSource();
    await writeFile(path.join(source, 'manifest.yaml'), 'manifest_version: 99\n');
    expect((await cli(['plugin', 'install', source])).code).toBe(2);
    await expect(readdir(home)).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(home);
    await writeFile(path.join(home, 'config.toml'), 'broken = [');
    expect((await cli(['plugin', 'install', 'deepseek-cost', '--enable'])).code).toBe(2);
    await expect(readdir(path.join(home, 'plugins'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(home, 'config.toml'), 'utf8')).toBe('broken = [');
  });

  it('rejects symlinks in a source and destinations inside the source tree', async () => {
    const source = await localSource();
    await expect(installPlugin({ source, cwd: root, home: path.join(source, 'nested') })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await symlink(path.join(source, 'index.mjs'), path.join(source, 'link.mjs'));
    await expect(installPlugin({ source, cwd: root, home })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  it('validates installed IDs and refuses to enable a missing plugin', async () => {
    expect((await cli(['plugin', 'enable', '../escape'])).code).toBe(2);
    expect((await cli(['plugin', 'enable', 'missing'])).code).toBe(2);
    await expect(readFile(path.join(home, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('updates the target of a config symlink', async () => {
    await mkdir(home);
    const target = path.join(root, 'actual-config.toml');
    await writeFile(target, '# shared\n[status_bar]\nplugin = "old"\n');
    await symlink(target, path.join(home, 'config.toml'));
    expect((await cli(['plugin', 'install', 'deepseek-cost', '--enable'])).code).toBe(0);
    expect(await readFile(target, 'utf8')).toContain('plugin = "deepseek-cost"');
  });
});

describe('TOML activation editing', () => {
  it.each([
    'status_bar = { plugin = "old", timeout_ms = 2000 } # comment\n',
    'status_bar.plugin = "old"\nstatus_bar.timeout_ms = 2000\n',
    '["status_bar"]\nplugin = \'old\' # comment\n',
    '[status_bar]\ntimeout_ms = 2000\n',
    'status_bar = {}\n',
    'status_bar = { timeout_ms = 2000 }\n',
    'status_bar.timeout_ms = 2000\n',
    '# hello\r\n[status_bar]\r\nplugin = "old"\r\n',
  ])('preserves unrelated fields for valid TOML layouts (%s)', (text) => {
    const before = parseToml(text);
    const result = enablePluginInToml(text, 'deepseek-cost');
    expect(parseToml(result)).toEqual({ ...before, status_bar: { ...(before.status_bar as object), plugin: 'deepseek-cost' } });
    expect(enablePluginInToml(result, 'deepseek-cost')).toBe(result);
  });

  it('does not mistake strings or comments for actual configuration', () => {
    const text = 'example = """\n[status_bar]\nplugin = "old"\n"""\n[status_bar]\nplugin = "old" # real\n';
    const result = enablePluginInToml(text, 'deepseek-cost');
    expect(result).toContain('plugin = "old"\n"""');
    expect(result).toContain('plugin = "deepseek-cost" # real');
  });
});
