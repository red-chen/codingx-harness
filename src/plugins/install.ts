import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml, type TomlTable } from 'smol-toml';
import { ConfigError } from '../util/errors.js';
import { canonicalizePath, expandHome, isPathInside } from '../util/paths.js';
import { loadStatusBarPlugin, readPluginDirectory } from './status-bar.js';

export interface PluginInstallOptions {
  source: string;
  cwd: string;
  home: string;
  enable?: boolean;
}

export interface PluginInstallResult {
  id: string;
  directory: string;
  installed: boolean;
  enabled: boolean;
}

export function pluginHome(cwd: string, env: NodeJS.ProcessEnv): string {
  return path.resolve(cwd, expandHome(env.CODINGX_HOME ?? path.join(os.homedir(), '.codingx')));
}

/** Resolve from our own module, never the user's cwd (works in src and bundled dist). */
async function bundledPlugins(): Promise<string> {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === 'codingx') return path.join(directory, 'plugins');
    } catch { /* Continue through src/dist parents. */ }
    const parent = path.dirname(directory);
    if (parent === directory) throw new ConfigError('Cannot locate bundled plugins.');
    directory = parent;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Surgical TOML edits, accepted only if parsing proves that exactly plugin changed. */
export function enablePluginInToml(text: string, id: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new ConfigError('Invalid plugin ID.');
  let parsed: TomlTable;
  try { parsed = parseToml(text); }
  catch { throw new ConfigError('Cannot enable plugin: global config.toml is invalid.'); }
  const section = parsed.status_bar;
  if (section !== undefined && !object(section)) throw new ConfigError('Global status_bar must be a TOML table.');
  const expected = parseToml(text);
  expected.status_bar = Object.assign(Object.create(null), section ?? {}, { plugin: id });
  const valid = (candidate: string): boolean => {
    try { return isDeepStrictEqual(parseToml(candidate), expected); } catch { return false; }
  };
  if (valid(text)) return text;
  const quoted = JSON.stringify(id);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  if (section === undefined) {
    const candidate = text + (text.endsWith('\n') || text.length === 0 ? '' : newline) +
      newline + '[status_bar]' + newline + 'plugin = ' + quoted + newline;
    if (valid(candidate)) return candidate;
  }
  // Handles ordinary, dotted and inline assignments, preserving comments and all other literals.
  if (object(section) && typeof section.plugin === 'string') {
    for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'/gu)) {
      let value: unknown;
      try { value = parseToml('value = ' + match[0]).value; } catch { continue; }
      if (value !== section.plugin) continue;
      const candidate = text.slice(0, match.index) + quoted + text.slice(match.index + match[0].length);
      if (valid(candidate)) return candidate;
    }
  }
  // A table without plugin, including quoted headers and inline-table notation.
  for (const match of text.matchAll(/^\s*\[(?:status_bar|"status_bar"|'status_bar')\][^\r\n]*(?:\r?\n|$)/gmu)) {
    const end = match.index + match[0].length;
    const candidate = text.slice(0, end) + (match[0].endsWith('\n') ? '' : newline) + 'plugin = ' + quoted + newline + text.slice(end);
    if (valid(candidate)) return candidate;
  }
  for (const match of text.matchAll(/(?:status_bar|"status_bar"|'status_bar')\s*=\s*\{/gu)) {
    const end = match.index + match[0].length;
    const comma = text.slice(end).trimStart().startsWith('}') ? '' : ', ';
    const candidate = text.slice(0, end) + ' plugin = ' + quoted + comma + text.slice(end);
    if (valid(candidate)) return candidate;
  }
  // Dotted keys at the root can be extended without adding a duplicate table.
  const prefixed = 'status_bar.plugin = ' + quoted + newline + text;
  if (valid(prefixed)) return prefixed;
  throw new ConfigError('Cannot safely edit status_bar in this TOML layout; set status_bar.plugin manually.');
}

async function readConfig(home: string): Promise<string> {
  try { return await readFile(path.join(home, 'config.toml'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new ConfigError('Cannot read global config.toml.', { cause: error });
  }
}

export async function enablePlugin(home: string, id: string): Promise<void> {
  await loadStatusBarPlugin(home, id);
  const before = await readConfig(home);
  const after = enablePluginInToml(before, id);
  if (before === after) return;
  // Follow an existing user-config symlink rather than replacing it.
  const target = await canonicalizePath(path.join(home, 'config.toml'));
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(temporary, after, { mode: 0o600, flag: 'wx' });
    if (await readConfig(home) !== before) throw new ConfigError('Global config changed during plugin activation; retry.');
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function validateTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new ConfigError('Plugin installation only supports regular files and directories (no symlinks or special files).');
    }
    if (entry.isDirectory()) await validateTree(path.join(directory, entry.name));
  }
}

export async function installPlugin(options: PluginInstallOptions): Promise<PluginInstallResult> {
  const builtin = options.source === 'deepseek-cost';
  const source = builtin ? path.join(await bundledPlugins(), options.source) : path.resolve(options.cwd, expandHome(options.source));
  const { manifest } = await readPluginDirectory(source);
  // Check configuration before copying anything; never leave an install on an invalid enable request.
  if (options.enable) enablePluginInToml(await readConfig(options.home), manifest.id);
  const root = path.join(options.home, 'plugins');
  const directory = path.join(root, manifest.id);
  try {
    await lstat(directory);
    await loadStatusBarPlugin(options.home, manifest.id);
    if (options.enable) await enablePlugin(options.home, manifest.id);
    return { id: manifest.id, directory, installed: false, enabled: options.enable ?? false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const realSource = await realpath(source);
  if (isPathInside(realSource, await canonicalizePath(root))) throw new ConfigError('Plugin destination cannot be inside its source directory.');
  await validateTree(realSource);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(root, '.install-'));
  let installed = false;
  try {
    await cp(realSource, staging, { recursive: true, force: false, errorOnExist: true });
    await validateTree(staging);
    const staged = await readPluginDirectory(staging);
    if (staged.manifest.id !== manifest.id) throw new ConfigError('Plugin manifest changed during installation.');
    await rename(staging, directory);
    installed = true;
    if (options.enable) await enablePlugin(options.home, manifest.id);
    return { id: manifest.id, directory, installed: true, enabled: options.enable ?? false };
  } catch (error) {
    throw new ConfigError(installed
      ? 'Plugin installed, but could not enable it; run codingx plugin enable ' + manifest.id + '.'
      : 'Plugin installation failed; existing files were preserved.', { cause: error });
  } finally { await rm(staging, { recursive: true, force: true }); }
}
