import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { CodingxError } from '../util/errors.js';
import type { SandboxPolicy } from '../policy/types.js';
import type {
  SandboxBackend,
  SandboxBackendOptions,
  SandboxCapabilities,
  SandboxShellInvocation,
  SandboxStatus,
} from './types.js';

const execFileAsync = promisify(execFile);
const DEFAULT_SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/**
 * Paths every macOS process needs in order to start. These are read-only;
 * writes still come exclusively from the permission profile.
 */
const SYSTEM_READ_ROOTS = [
  '/System',
  '/Library',
  '/Applications',
  '/usr',
  '/usr/local',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/opt',
  '/private/etc',
  '/etc',
  '/private/var/db',
  '/private/var/run',
  '/private/var/select',
  '/private/var/tmp',
  '/private/tmp',
  '/tmp',
  '/nix',
  '/Users/Shared',
];

/** Developer tool state that lives below $HOME but contains no credentials. */
const HOME_READ_PATHS = [
  '.gitconfig',
  '.config/git',
  '.npm',
  '.cache',
  '.cargo',
  '.rustup',
  '.nvm',
  '.volta',
  '.asdf',
  '.bun',
  '.deno',
  '.local/bin',
  '.local/share/pnpm',
  '.m2',
  '.gradle',
  '.pyenv',
  '.rbenv',
  '.gem',
  '.opam',
  '.sdkman',
  '.nix-profile',
  'go',
  'Library/pnpm',
  'Library/Developer',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.config/fish',
];

/** Device nodes that are safe and required by normal commands. */
const DEVICE_READ_LITERALS = [
  '/dev/null',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/tty',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/ptmx',
];
const DEVICE_READ_SUBPATHS = ['/dev/fd'];
const DEVICE_WRITE_LITERALS = ['/dev/null', '/dev/tty', '/dev/fd', '/dev/stdout', '/dev/stderr'];

/** System prefixes which do not contain user/workspace secret files. */
const SYSTEM_READ_PREFIXES = [
  '/System',
  '/Library',
  '/Applications',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/opt',
  '/private/etc',
  '/etc',
  '/dev',
  '/nix',
  '/private/var/db',
  '/private/var/run',
  '/private/var/select',
];

function unique(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function seatbeltString(value: string): string {
  return (
    '"' +
    value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t') +
    '"'
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globCore(pattern: string): string {
  let value = pattern.replace(/\\/g, '/');
  if (value.startsWith('**/')) value = value.slice(3);
  else if (value.startsWith('./')) value = value.slice(2);
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    if (char === '*') {
      if (value[index + 1] === '*') {
        out += '.*';
        index += 1;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    out += escapeRegex(char);
  }
  return out;
}

function globRegexForRoot(root: string, pattern: string): string {
  const normalizedRoot = root.endsWith('/') && root !== '/' ? root.slice(0, -1) : root;
  const prefix = normalizedRoot === '/' ? '/' : escapeRegex(normalizedRoot) + '/';
  return '^' + prefix + '(?:.*/)?' + globCore(pattern) + '$';
}

function addLiteral(lines: string[], operation: string, value: string): void {
  lines.push('(' + operation + ' (literal ' + seatbeltString(value) + '))');
}

function addSubpath(lines: string[], operation: string, value: string): void {
  lines.push('(' + operation + ' (subpath ' + seatbeltString(value) + '))');
}

function executableReadRoots(): string[] {
  const directory = path.dirname(process.execPath);
  const roots = [directory];
  // nvm/volta layouts put npm and corepack beside ../lib/node_modules.
  if (path.basename(directory) === 'bin') roots.push(path.dirname(directory));
  return roots;
}

function canonicalRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

function isWriteOnlyDeny(pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, '/');
  return (
    normalized === '**/.git/config' ||
    normalized === '.git/config' ||
    normalized === '**/.git/hooks/**' ||
    normalized === '.git/hooks/**' ||
    normalized === '**/.git/modules/**/hooks/**' ||
    normalized === '.git/modules/**/hooks/**'
  );
}

function isSystemRoot(root: string): boolean {
  return SYSTEM_READ_PREFIXES.some((prefix) => root === prefix || root.startsWith(prefix + '/'));
}

function scopedGlobRoots(policy: SandboxPolicy): string[] {
  const roots: string[] = [
    policy.cwd,
    policy.home,
    policy.tmpdir,
    '/tmp',
    '/private/tmp',
    '/private/var/tmp',
    ...policy.writeRoots,
    ...policy.additionalDirs,
    ...(policy.sessionDir === undefined ? [] : [policy.sessionDir]),
  ];
  return unique(roots.map(canonicalRoot)).filter((root) => root.startsWith('/'));
}

/**
 * Build a default-deny Seatbelt profile. Reads are limited to system,
 * toolchain and profile roots; writes come from the resolved profile roots.
 * Credential roots and secret-file globs are denied explicitly. Seatbelt lets
 * allow rules win over deny rules, so denies are emitted after the broad
 * allows and use canonical paths.
 */
export function buildSeatbeltProfile(policy: SandboxPolicy): string {
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow signal (target children))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow pseudo-tty)',
    '(allow user-preference-read)',
    '(allow file-read-metadata)',
  ];

  // Seatbelt needs to read the filesystem root itself while resolving paths.
  addLiteral(lines, 'allow file-read*', '/');

  const canonicalHome = canonicalRoot(policy.home);
  const readRoots = unique([
    ...SYSTEM_READ_ROOTS,
    ...executableReadRoots().map(canonicalRoot),
    ...policy.readRoots.map(canonicalRoot),
    ...policy.additionalDirs.map(canonicalRoot),
    ...HOME_READ_PATHS.map((entry) => path.join(canonicalHome, entry)),
  ]).filter((root) => root.startsWith('/'));
  for (const root of readRoots) addSubpath(lines, 'allow file-read*', root);
  for (const device of DEVICE_READ_LITERALS) addLiteral(lines, 'allow file-read*', device);
  for (const device of DEVICE_READ_SUBPATHS) addSubpath(lines, 'allow file-read*', device);

  for (const root of unique(policy.writeRoots.map(canonicalRoot))) {
    if (root.startsWith('/')) addSubpath(lines, 'allow file-write*', root);
  }
  for (const device of DEVICE_WRITE_LITERALS) addLiteral(lines, 'allow file-write*', device);

  if (policy.network.enabled) lines.push('(allow network*)');

  for (const root of unique(policy.denyRoots.map(canonicalRoot))) {
    if (!root.startsWith('/')) continue;
    addSubpath(lines, 'deny file-read*', root);
    addSubpath(lines, 'deny file-write*', root);
  }

  const scopedRoots = scopedGlobRoots(policy);
  const regexes: Array<{ regex: string; writeOnly: boolean }> = [];
  for (const glob of policy.denyGlobs) {
    const writeOnly = isWriteOnlyDeny(glob.pattern);
    if (glob.pattern.startsWith('/')) {
      regexes.push({ regex: '^' + globCore(glob.pattern) + '$', writeOnly });
      continue;
    }
    if (glob.base !== null) {
      regexes.push({ regex: globRegexForRoot(glob.base, glob.pattern), writeOnly });
      continue;
    }
    for (const root of scopedRoots) {
      if (isSystemRoot(root)) continue;
      regexes.push({ regex: globRegexForRoot(root, glob.pattern), writeOnly });
    }
  }

  const seenRegexes = new Set<string>();
  for (const { regex, writeOnly } of regexes) {
    if (seenRegexes.has(regex)) continue;
    seenRegexes.add(regex);
    if (!writeOnly) lines.push('(deny file-read* (regex ' + seatbeltString(regex) + '))');
    lines.push('(deny file-write* (regex ' + seatbeltString(regex) + '))');
  }

  return lines.join('\n') + '\n';
}

const PROBE_PROFILE = [
  '(version 1)',
  '(deny default)',
  '(allow process-exec)',
  '(allow file-read* (literal "/"))',
  '(allow file-read* (subpath "/usr"))',
  '(allow file-read* (subpath "/bin"))',
].join('\n');

function shellPath(): string {
  return existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

export class SeatbeltBackend implements SandboxBackend {
  readonly kind = 'seatbelt' as const;
  readonly capabilities: SandboxCapabilities = {
    fileSystem: 'enforced',
    network: 'deny',
    unixSockets: false,
  };
  readonly status: SandboxStatus;
  private readonly binaryPath: string;
  private readonly probe: boolean;
  private readonly probeTimeoutMs: number;
  private probeResult: Promise<boolean> | undefined;

  constructor(options: SandboxBackendOptions = {}) {
    this.binaryPath = options.seatbeltPath ?? DEFAULT_SANDBOX_EXEC;
    this.probe = options.probe ?? true;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.status = {
      kind: 'seatbelt',
      platform: options.platform ?? process.platform,
      available: false,
      required: true,
      capabilities: this.capabilities,
      warnings: ['sandbox-exec is deprecated by Apple but is still available on supported macOS versions.'],
    };
  }

  async available(): Promise<boolean> {
    this.probeResult ??= this.runProbe();
    const available = await this.probeResult;
    this.status.available = available;
    if (!available && this.status.reason === undefined) {
      this.status.reason = 'sandbox-exec is missing or cannot apply a profile.';
    }
    return available;
  }

  private async runProbe(): Promise<boolean> {
    try {
      await access(this.binaryPath, constants.X_OK);
    } catch {
      this.status.reason = 'sandbox-exec was not found at ' + this.binaryPath + '.';
      return false;
    }
    if (!this.probe) {
      this.status.reason = undefined;
      return true;
    }
    try {
      await execFileAsync(this.binaryPath, ['-p', PROBE_PROFILE, '/usr/bin/true'], {
        timeout: this.probeTimeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      });
      return true;
    } catch (error) {
      this.status.reason =
        'sandbox-exec probe failed: ' + (error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  wrapShell(command: string, policy: SandboxPolicy): SandboxShellInvocation {
    if (!this.status.available) {
      throw new CodingxError(
        'SANDBOX_UNAVAILABLE',
        this.status.reason ?? 'The macOS Seatbelt sandbox is not available.',
      );
    }
    if (policy.yolo) {
      throw new CodingxError('SANDBOX_UNAVAILABLE', 'The selected permission profile disables the sandbox.');
    }
    const profile = buildSeatbeltProfile(policy);
    return {
      file: this.binaryPath,
      args: ['-p', profile, shellPath(), '-lc', command],
    };
  }
}

export function createSeatbeltBackend(options: SandboxBackendOptions = {}): SeatbeltBackend {
  return new SeatbeltBackend({ ...options, platform: options.platform ?? process.platform });
}
