import os from 'node:os';
import path from 'node:path';
import { ConfigError } from '../util/errors.js';
import { canonicalizePath, expandHome, isPathInside } from '../util/paths.js';
import type {
  FileAccess,
  FilesystemRule,
  NetworkPolicy,
  PermissionProfile,
  PermissionsConfig,
} from './types.js';

export const WORKSPACE_PROFILE = ':workspace';
export const READ_ONLY_PROFILE = ':read-only';
export const DANGER_PROFILE = ':danger-full-access';

const READ_ONLY_COMMANDS = new Set([
  'cat',
  'date',
  'df',
  'dir',
  'du',
  'echo',
  'file',
  'find',
  'git',
  'grep',
  'head',
  'id',
  'ls',
  'node',
  'npm',
  'printenv',
  'printf',
  'pwd',
  'rg',
  'stat',
  'tail',
  'tree',
  'type',
  'uname',
  'wc',
  'where',
  'which',
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files']);

/** find actions that write files or execute another program. */
const FIND_UNSAFE_ACTIONS = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
]);

export const BUILTIN_PROFILES: Record<string, PermissionProfile> = {
  [READ_ONLY_PROFILE]: {
    name: READ_ONLY_PROFILE,
    filesystem: [
      { scope: ':workspace_roots', access: 'read' },
      { scope: ':minimal', access: 'read' },
    ],
    network: { enabled: false, domains: {} },
    source: 'builtin',
  },
  [WORKSPACE_PROFILE]: {
    name: WORKSPACE_PROFILE,
    filesystem: [
      { scope: ':workspace_roots', access: 'write' },
      { scope: ':tmpdir', access: 'write' },
      { scope: ':slash_tmp', access: 'write' },
      { scope: ':minimal', access: 'read' },
    ],
    network: { enabled: false, domains: {} },
    source: 'builtin',
  },
  [DANGER_PROFILE]: {
    name: DANGER_PROFILE,
    filesystem: [{ scope: ':root', access: 'write' }],
    network: { enabled: true, domains: {} },
    source: 'builtin',
  },
};

export function isReadOnlyProgram(program: string, args: readonly string[]): boolean {
  if (!READ_ONLY_COMMANDS.has(program)) return false;
  if (program === 'git') {
    const subcommand = args.find((arg) => !arg.startsWith('-'));
    return subcommand !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
  }
  if (program === 'node' || program === 'npm') {
    // Version probes are harmless; arbitrary scripts are not read-only.
    return args.length === 1 && (args[0] === '--version' || args[0] === '-v');
  }
  if (program === 'find') {
    return !args.some((arg) => FIND_UNSAFE_ACTIONS.has(arg));
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function accessFrom(value: unknown, where: string): FileAccess {
  if (value === 'read' || value === 'write' || value === 'deny') return value;
  throw new ConfigError(where + ' must be "read", "write" or "deny".');
}

function parseFilesystem(raw: unknown, name: string): FilesystemRule[] {
  if (raw === undefined) return [];
  if (!isPlainObject(raw)) throw new ConfigError('[permissions.' + name + '.filesystem] must be a table.');
  const rules: FilesystemRule[] = [];
  for (const [scope, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      rules.push({ scope, access: accessFrom(value, '[permissions.' + name + '.filesystem] ' + scope) });
      continue;
    }
    if (isPlainObject(value)) {
      for (const [subpath, nested] of Object.entries(value)) {
        rules.push({
          scope,
          subpath,
          access: accessFrom(nested, '[permissions.' + name + '.filesystem.' + scope + '] ' + subpath),
        });
      }
      continue;
    }
    throw new ConfigError(
      '[permissions.' + name + '.filesystem] ' + scope + ' must be an access string or a subpath table.',
    );
  }
  return rules;
}

function parseNetwork(raw: unknown, name: string): NetworkPolicy | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new ConfigError('[permissions.' + name + '.network] must be a table.');
  const enabled = raw.enabled;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new ConfigError('[permissions.' + name + '.network] enabled must be a boolean.');
  }
  const domains: Record<string, 'allow' | 'deny'> = {};
  if (raw.domains !== undefined) {
    if (!isPlainObject(raw.domains)) {
      throw new ConfigError('[permissions.' + name + '.network.domains] must be a table.');
    }
    for (const [domain, decision] of Object.entries(raw.domains)) {
      if (decision !== 'allow' && decision !== 'deny') {
        throw new ConfigError(
          '[permissions.' + name + '.network.domains] ' + domain + ' must be "allow" or "deny".',
        );
      }
      domains[domain] = decision;
    }
  }
  return { enabled: enabled === true, domains };
}

interface ParsedProfile {
  name: string;
  extends?: string;
  filesystem: FilesystemRule[];
  network?: NetworkPolicy;
}

function parseRawProfiles(raw: Record<string, unknown>): Record<string, ParsedProfile> {
  const parsed: Record<string, ParsedProfile> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name.startsWith(':')) {
      throw new ConfigError('Permission profile names must not start with ":" (reserved for built-ins): ' + name);
    }
    if (!isPlainObject(value)) throw new ConfigError('[permissions.' + name + '] must be a table.');
    const extendsName = value.extends;
    if (extendsName !== undefined && typeof extendsName !== 'string') {
      throw new ConfigError('[permissions.' + name + '] extends must be a profile name.');
    }
    const network = parseNetwork(value.network, name);
    parsed[name] = {
      name,
      ...(typeof extendsName === 'string' ? { extends: extendsName } : {}),
      filesystem: parseFilesystem(value.filesystem, name),
      ...(network === undefined ? {} : { network }),
    };
  }
  return parsed;
}

function mergeProfiles(
  name: string,
  raw: Record<string, ParsedProfile>,
  builtins: Record<string, PermissionProfile>,
  seen: Set<string>,
): PermissionProfile {
  const builtin = builtins[name];
  if (builtin) return builtin;
  const profile = raw[name];
  if (!profile) throw new ConfigError('Unknown permission profile "' + name + '".', { details: { code: 'PERMISSION_PROFILE_UNKNOWN' } });
  if (seen.has(name)) throw new ConfigError('Permission profile cycle detected at "' + name + '".');
  seen.add(name);
  const base = profile.extends
    ? mergeProfiles(profile.extends, raw, builtins, seen)
    : { name, filesystem: [], network: { enabled: false, domains: {} }, source: 'builtin' as const };
  const merged: PermissionProfile = {
    name,
    ...(profile.extends ? { extends: profile.extends } : {}),
    filesystem: [...base.filesystem, ...profile.filesystem],
    network: profile.network ?? base.network,
    source: 'config',
  };
  return merged;
}

/** Parse [permissions.*] from the merged config and validate the default profile. */
export function parsePermissions(
  rawProfiles: Record<string, unknown>,
  defaultProfile: string,
): PermissionsConfig {
  const parsed = parseRawProfiles(rawProfiles);
  const profiles: Record<string, PermissionProfile> = { ...BUILTIN_PROFILES };
  for (const name of Object.keys(parsed)) {
    profiles[name] = mergeProfiles(name, parsed, BUILTIN_PROFILES, new Set());
  }
  if (!profiles[defaultProfile]) {
    throw new ConfigError(
      'Unknown default permission profile "' + defaultProfile + '". Built-ins: ' +
        Object.keys(BUILTIN_PROFILES).join(', ') + '.',
      { details: { code: 'PERMISSION_PROFILE_UNKNOWN' } },
    );
  }
  return { defaultProfile, profiles };
}

export interface ResolvedProfileRoots {
  readRoots: string[];
  writeRoots: string[];
  denyRoots: string[];
  denyGlobs: Array<{ base: string | null; pattern: string }>;
  allowAll: boolean;
}

function hasGlob(value: string): boolean {
  return value.includes('*') || value.includes('?') || value.includes('[');
}

function systemReadRoots(): string[] {
  const roots = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt'];
  const execDir = path.dirname(process.execPath);
  if (execDir) roots.push(execDir);
  return roots;
}

function normalizeRulePath(input: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : os.homedir();
  return path.resolve(cwd, expandHome(input, home));
}

async function addRoot(list: string[], candidate: string): Promise<void> {
  const canonical = await canonicalizePath(candidate);
  if (!list.includes(canonical)) list.push(canonical);
}

/**
 * Resolve a profile's rules into concrete roots for file tools. OS-level
 * sandboxing (Seatbelt/Landlock) will consume the same resolved structure.
 */
export async function resolveProfileRoots(
  profile: PermissionProfile,
  options: {
    cwd: string;
    additionalDirs: readonly string[];
    env: NodeJS.ProcessEnv;
    sessionDir?: string;
  },
): Promise<ResolvedProfileRoots> {
  const cwd = await canonicalizePath(options.cwd);
  const workspaceRoots: string[] = [];
  await addRoot(workspaceRoots, cwd);
  for (const directory of options.additionalDirs) await addRoot(workspaceRoots, directory);

  const home = options.env.HOME !== undefined && options.env.HOME.length > 0 ? options.env.HOME : os.homedir();
  const tmpdir = options.env.TMPDIR !== undefined && options.env.TMPDIR.length > 0 ? options.env.TMPDIR : os.tmpdir();
  const readRoots: string[] = [];
  const writeRoots: string[] = [];
  const denyRoots: string[] = [];
  const denyGlobs: Array<{ base: string | null; pattern: string }> = [];
  let allowAll = false;

  for (const rule of profile.filesystem) {
    if (rule.scope === ':workspace_roots') {
      if (rule.subpath !== undefined && hasGlob(rule.subpath)) {
        if (rule.access !== 'deny') {
          throw new ConfigError(
            'Permission profile glob rules currently support deny access only; "' +
              rule.scope +
              '/' +
              rule.subpath +
              '" uses "' +
              rule.access +
              '". Use a concrete path or a deny glob.',
          );
        }
        for (const root of workspaceRoots) denyGlobs.push({ base: root, pattern: rule.subpath });
        continue;
      }
      const bases = rule.subpath === undefined ? workspaceRoots : workspaceRoots.map((root) => path.resolve(root, rule.subpath as string));
      for (const base of bases) {
        if (rule.access === 'write') {
          await addRoot(writeRoots, base);
          await addRoot(readRoots, base);
        } else if (rule.access === 'read') {
          await addRoot(readRoots, base);
        } else {
          await addRoot(denyRoots, base);
        }
      }
      continue;
    }

    if (rule.scope === ':minimal') {
      if (rule.access !== 'deny') {
        for (const root of systemReadRoots()) await addRoot(readRoots, root);
      }
      continue;
    }

    if (rule.scope === ':tmpdir') {
      if (rule.access === 'write') {
        await addRoot(writeRoots, tmpdir);
        await addRoot(readRoots, tmpdir);
      } else if (rule.access === 'read') {
        await addRoot(readRoots, tmpdir);
      } else {
        await addRoot(denyRoots, tmpdir);
      }
      continue;
    }

    if (rule.scope === ':slash_tmp') {
      if (rule.access === 'write') {
        await addRoot(writeRoots, '/tmp');
        await addRoot(readRoots, '/tmp');
      } else if (rule.access === 'read') {
        await addRoot(readRoots, '/tmp');
      } else {
        await addRoot(denyRoots, '/tmp');
      }
      continue;
    }

    if (rule.scope === ':root') {
      if (rule.access === 'write' && profile.name === DANGER_PROFILE) {
        allowAll = true;
      } else {
        await addRoot(readRoots, path.parse(cwd).root);
        if (rule.access === 'write') await addRoot(writeRoots, path.parse(cwd).root);
      }
      continue;
    }

    const expanded = normalizeRulePath(rule.scope + (rule.subpath === undefined ? '' : '/' + rule.subpath), cwd, options.env);
    if (hasGlob(rule.scope) || (rule.subpath !== undefined && hasGlob(rule.subpath))) {
      if (rule.access !== 'deny') {
        throw new ConfigError(
          'Permission profile glob rules currently support deny access only; "' +
            rule.scope +
            (rule.subpath === undefined ? '' : '/' + rule.subpath) +
            '" uses "' +
            rule.access +
            '". Use a concrete path or a deny glob.',
        );
      }
      denyGlobs.push({ base: null, pattern: rule.scope + (rule.subpath === undefined ? '' : '/' + rule.subpath) });
      continue;
    }
    if (rule.access === 'write') {
      await addRoot(writeRoots, expanded);
      await addRoot(readRoots, expanded);
    } else if (rule.access === 'read') {
      await addRoot(readRoots, expanded);
    } else {
      await addRoot(denyRoots, expanded);
    }
  }

  if (!allowAll) {
    // Credential/config directories are denied even when a profile points a
    // broader root at the home directory. :danger-full-access sets allowAll.
    await addRoot(denyRoots, path.join(home, '.ssh'));
    await addRoot(denyRoots, path.join(home, '.aws'));
    await addRoot(denyRoots, path.join(home, '.config', 'gh'));
    await addRoot(denyRoots, path.join(home, '.codingx'));
    if (options.sessionDir) await addRoot(denyRoots, options.sessionDir);
    for (const pattern of [
      '.env',
      '.env.*',
      '*.pem',
      '*.key',
      'id_rsa',
      'id_ed25519',
      '.npmrc',
      '.netrc',
      '.ssh',
      '.aws',
      '.gnupg',
      '**/.git/config',
      '**/.git/hooks/**',
      '**/.git/modules/**/hooks/**',
      '**/*.env',
      '**/.env',
      '**/.env.*',
      '**/*.pem',
      '**/*.key',
      '**/id_rsa',
      '**/id_ed25519',
      '**/.npmrc',
      '**/.netrc',
    ]) {
      denyGlobs.push({ base: null, pattern });
    }
  }

  return { readRoots, writeRoots, denyRoots, denyGlobs, allowAll };
}

export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '.';
    } else if ('\\.^$+{}()|[]'.includes(char)) {
      source += '\\' + char;
    } else {
      source += char;
    }
  }
  return new RegExp('^' + source + '$');
}

export function matchesPathGlob(
  absolute: string,
  glob: { base: string | null; pattern: string },
): boolean {
  const normalized = absolute.split(path.sep).join('/');
  let candidate = normalized;
  if (glob.base !== null) {
    const relative = path.relative(glob.base, absolute).split(path.sep).join('/');
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return false;
    candidate = relative;
  }
  return globToRegExp(glob.pattern).test(candidate) || globToRegExp(glob.pattern).test(path.basename(absolute));
}
