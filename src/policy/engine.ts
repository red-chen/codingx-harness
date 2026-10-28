import os from 'node:os';
import path from 'node:path';
import { ConfigError } from '../util/errors.js';
import { canonicalizePath, expandHome, isPathInside } from '../util/paths.js';
import {
  DANGER_PROFILE,
  matchesPathGlob,
  isReadOnlyProgram,
  resolveProfileRoots,
} from './profile.js';
import { parseShellCommand } from './shell-parse.js';
import type {
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalsReviewer,
  FileAccess,
  PermissionProfile,
  PolicyAction,
  PolicyDecision,
  PolicyRuntime,
  PolicyRuntimeOptions,
  PolicyVerdict,
  SandboxPolicy,
  ShellSegment,
} from './types.js';

const READ_TOOLS = new Set(['ReadFile', 'ListDir', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['WriteFile', 'EditFile', 'ApplyPatch']);
const PASSIVE_TOOLS = new Set(['AskUserQuestion', 'UpdatePlan', 'Skill']);

const FORBIDDEN_PROGRAMS = new Set([
  'sudo',
  'doas',
  'su',
  'mkfs',
  'fdisk',
  'parted',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
]);

const NETWORK_PROGRAMS = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'sftp',
  'nc',
  'ncat',
  'telnet',
  'ping',
  'ftp',
  'gh',
]);

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : os.homedir();
}

function basenameOf(program: string): string {
  return path.basename(program);
}

function normalizeCommandPath(value: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const home = homeOf(env);
  const expanded = value.replace(/\$\{HOME\}/g, home).replace(/\$HOME\b/g, home);
  return path.resolve(cwd, expandHome(expanded, home));
}

function isInsideAny(roots: readonly string[], absolute: string): boolean {
  return roots.some((root) => isPathInside(root, absolute));
}

/** Heuristic used only to decide whether an argv token needs a path check. */
function isPathLikeArg(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('~') ||
    value.startsWith('.') ||
    value.includes('/') ||
    value.includes(path.sep)
  );
}

function domainMatches(pattern: string, host: string): boolean {
  const normalized = host.toLowerCase();
  const rule = pattern.toLowerCase();
  if (rule.startsWith('**.')) {
    const suffix = rule.slice(2);
    return normalized === suffix.slice(1) || normalized.endsWith(suffix);
  }
  if (rule.startsWith('*.')) {
    return normalized.endsWith(rule.slice(1));
  }
  return normalized === rule;
}

function networkAllowed(domains: Record<string, 'allow' | 'deny'>, host: string | undefined): boolean {
  const entries = Object.entries(domains);
  if (entries.length === 0) return true;
  if (host === undefined) return false;
  let allowed = false;
  for (const [pattern, decision] of entries) {
    if (!domainMatches(pattern, host)) continue;
    if (decision === 'deny') return false;
    allowed = true;
  }
  return allowed;
}

function hostFromSegment(segment: ShellSegment): string | undefined {
  const urls = [...segment.args, segment.program].filter((arg) => /^https?:\/\//i.test(arg));
  if (urls.length > 0) {
    try {
      return new URL(urls[0] as string).hostname;
    } catch {
      return undefined;
    }
  }
  if (segment.program === 'ssh' || segment.program === 'scp' || segment.program === 'sftp') {
    const target = segment.args.find((arg) => !arg.startsWith('-'));
    if (target) return target.includes('@') ? target.split('@').pop() : target;
  }
  return undefined;
}

function isNetworkSegment(segment: ShellSegment): boolean {
  const program = basenameOf(segment.program);
  if (NETWORK_PROGRAMS.has(program)) return true;
  if (program === 'git') {
    const sub = segment.args.find((arg) => !arg.startsWith('-'));
    return sub !== undefined && ['push', 'pull', 'fetch', 'clone', 'ls-remote', 'submodule'].includes(sub);
  }
  if (program === 'npm' || program === 'pnpm' || program === 'yarn') {
    return segment.args.some((arg) => ['install', 'add', 'publish', 'update'].includes(arg));
  }
  if (program === 'pip' || program === 'pip3' || program === 'cargo' || program === 'go' || program === 'brew') {
    return segment.args.some((arg) => ['install', 'add', 'get', 'update', 'upgrade'].includes(arg));
  }
  if (program === 'apt' || program === 'apt-get' || program === 'yum' || program === 'dnf') {
    return segment.args.some((arg) => ['install', 'update', 'upgrade'].includes(arg));
  }
  if (program === 'docker') {
    return segment.args.some((arg) => ['pull', 'push', 'login'].includes(arg));
  }
  return false;
}

function forbiddenSegment(segment: ShellSegment, env: NodeJS.ProcessEnv): string | undefined {
  const program = basenameOf(segment.program);
  if (FORBIDDEN_PROGRAMS.has(program)) return 'privileged/system command "' + program + '" is forbidden';
  const home = homeOf(env);
  if (program === 'rm') {
    const targets = segment.args.filter((arg) => !arg.startsWith('-'));
    const dangerous = targets.some((target) => {
      const resolved = normalizeCommandPath(target, segment.cwd, env);
      return (
        resolved === '/' ||
        resolved === '/*' ||
        target === '~' ||
        target === '$HOME' ||
        resolved === home ||
        resolved === path.parse(home).root
      );
    });
    if (dangerous) return 'recursive deletion of / or the home directory is forbidden';
  }
  if (program === 'dd') {
    if (segment.args.some((arg) => /^of=\/dev\//.test(arg))) return 'writing to a block device is forbidden';
  }
  if (program === 'chmod' || program === 'chown') {
    const targets = segment.args.filter((arg) => !arg.startsWith('-'));
    if (targets.some((target) => normalizeCommandPath(target, segment.cwd, env) === path.parse(segment.cwd).root)) {
      return 'changing permissions/ownership of / is forbidden';
    }
  }
  return undefined;
}

function pipelinePipesToShell(segments: readonly ShellSegment[]): boolean {
  for (let index = 1; index < segments.length; index += 1) {
    const previous = basenameOf((segments[index - 1] as ShellSegment).program);
    const current = basenameOf((segments[index] as ShellSegment).program);
    if ((previous === 'curl' || previous === 'wget') && (current === 'sh' || current === 'bash' || current === 'zsh')) {
      return true;
    }
  }
  return false;
}

function extractFilePaths(tool: string, input: unknown): Array<string | undefined> {
  if (typeof input !== 'object' || input === null) return [undefined];
  const record = input as Record<string, unknown>;
  if (tool === 'ApplyPatch' && typeof record.patch === 'string') {
    const paths: string[] = [];
    for (const line of record.patch.split('\n')) {
      const match = /^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/.exec(line);
      if (!match || match[1] === undefined) continue;
      const value = match[1].trim();
      if (value.length > 0 && value !== '/dev/null') paths.push(value.replace(/^"|"$/g, ''));
    }
    return paths.length > 0 ? paths : [undefined];
  }
  return [typeof record.path === 'string' ? record.path : undefined];
}

function fileAccess(tool: string): FileAccess {
  if (READ_TOOLS.has(tool)) return 'read';
  if (WRITE_TOOLS.has(tool)) return 'write';
  return 'read';
}

function denied(
  action: PolicyAction,
  reason: string,
  rule: string,
  code: PolicyDecision['code'],
  risk: 'low' | 'medium' | 'high',
): PolicyDecision {
  return { verdict: 'deny', code, reason, rule, action, risk };
}

class Runtime implements PolicyRuntime {
  readonly profileName: string;
  readonly approvalPolicy: ApprovalPolicy;
  readonly reviewer: ApprovalsReviewer;
  readonly yolo: boolean;
  readonly cwd: string;
  readonly additionalDirs: readonly string[];
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly sandboxPolicy: SandboxPolicy;
  private readonly env: NodeJS.ProcessEnv;
  private readonly allowAll: boolean;
  private readonly denyRoots: readonly string[];
  private readonly denyGlobs: ReadonlyArray<{ base: string | null; pattern: string }>;
  private readonly alwaysAsk: boolean;
  private readonly readOnly: boolean;
  private readonly network: { enabled: boolean; domains: Record<string, 'allow' | 'deny'> };
  private readonly sessionDir: string | undefined;

  constructor(
    options: PolicyRuntimeOptions,
    resolved: {
      readRoots: string[];
      writeRoots: string[];
      denyRoots: string[];
      denyGlobs: Array<{ base: string | null; pattern: string }>;
      allowAll: boolean;
      gitHooksWritable: boolean;
      gitConfigWritable: boolean;
    },
    profile: PermissionProfile,
  ) {
    this.profileName = options.config.defaultProfile;
    this.approvalPolicy = options.approvalPolicy;
    this.reviewer = options.reviewer;
    this.yolo = resolved.allowAll;
    this.cwd = options.cwd;
    this.additionalDirs = [...options.additionalDirs];
    this.readRoots = resolved.readRoots;
    this.writeRoots = resolved.writeRoots;
    this.env = options.env;
    this.allowAll = resolved.allowAll;
    this.denyRoots = resolved.denyRoots;
    this.denyGlobs = resolved.denyGlobs;
    this.alwaysAsk = options.alwaysAsk === true;
    this.readOnly = profile.name === ':read-only' || profile.extends === ':read-only';
    this.network = profile.network;
    this.sessionDir = options.sessionDir;
    const home = homeOf(this.env);
    const tmpdir =
      this.env.TMPDIR !== undefined && this.env.TMPDIR.length > 0 ? this.env.TMPDIR : os.tmpdir();
    this.sandboxPolicy = {
      profileName: this.profileName,
      cwd: this.cwd,
      home,
      tmpdir,
      readRoots: this.readRoots,
      writeRoots: this.writeRoots,
      denyRoots: this.denyRoots,
      denyGlobs: this.denyGlobs,
      additionalDirs: this.additionalDirs,
      network: this.network,
      ...(this.sessionDir === undefined ? {} : { sessionDir: this.sessionDir }),
      yolo: this.yolo,
      gitHooksWritable: resolved.gitHooksWritable,
      gitConfigWritable: resolved.gitConfigWritable,
    };
  }

  rootsFor(access: 'read' | 'write'): readonly string[] {
    return access === 'read' ? this.readRoots : this.writeRoots;
  }

  isPathDenied(absolutePath: string): boolean {
    if (this.allowAll) return false;
    if (isInsideAny(this.denyRoots, absolutePath)) return true;
    if (this.sessionDir && isPathInside(this.sessionDir, absolutePath)) return true;
    return this.denyGlobs.some((glob) => matchesPathGlob(absolutePath, glob));
  }

  private askOrDeny(
    action: PolicyAction,
    reason: string,
    rule: string,
    risk: 'low' | 'medium' | 'high',
  ): PolicyDecision {
    if (this.approvalPolicy === 'never') {
      return denied(action, reason + ' Approval policy is "never", so the action was denied.', rule, 'PERMISSION_DENIED', risk);
    }
    return {
      verdict: 'ask',
      code: 'APPROVAL_REQUIRED',
      reason,
      rule,
      action,
      risk,
    };
  }

  private allow(action: PolicyAction, risk: 'low' | 'medium' | 'high', rule: string): PolicyDecision {
    if (this.alwaysAsk) return this.askOrDeny(action, 'Approval mode "always-ask" requires confirmation for this tool call.', rule, risk);
    return { verdict: 'allow', action, risk, rule };
  }

  private async evaluateFile(tool: string, input: unknown): Promise<PolicyDecision> {
    const access = fileAccess(tool);
    const paths = extractFilePaths(tool, input);
    let strictest: PolicyDecision | undefined;
    for (const inputPath of paths) {
      if (inputPath === undefined) {
        const action: PolicyAction = { kind: access === 'write' ? 'file.write' : 'file.read', tool };
        const decision =
          access === 'write' && this.writeRoots.length === 0
            ? this.askOrDeny(action, 'The selected permission profile does not allow file writes.', 'profile.no-write', 'medium')
            : this.allow(action, 'low', 'profile.allow');
        strictest = strictest === undefined || severity(decision.verdict) > severity(strictest.verdict) ? decision : strictest;
        continue;
      }
      const absolute = await canonicalizePath(path.resolve(this.cwd, expandHome(inputPath, homeOf(this.env))));
      const action: PolicyAction = { kind: access === 'write' ? 'file.write' : 'file.read', tool, path: absolute };
      if (this.allowAll) {
        strictest = this.allow(action, access === 'write' ? 'high' : 'low', 'profile.danger-full-access');
        continue;
      }
      if (this.isPathDenied(absolute)) {
        const decision = denied(
          action,
          'Path "' + inputPath + '" is denied by the permission profile (credential or secret file).',
          'profile.deny',
          'PERMISSION_DENIED',
          access === 'write' ? 'high' : 'medium',
        );
        strictest = strictest === undefined || severity(decision.verdict) > severity(strictest.verdict) ? decision : strictest;
        continue;
      }
      const allowedRoots = access === 'write' ? this.writeRoots : this.readRoots;
      if (isInsideAny(allowedRoots, absolute)) {
        const decision = this.allow(action, access === 'write' ? 'medium' : 'low', 'profile.allow');
        strictest = strictest === undefined || severity(decision.verdict) > severity(strictest.verdict) ? decision : strictest;
        continue;
      }
      const readable = isInsideAny(this.readRoots, absolute);
      const decision = this.askOrDeny(
        action,
        readable
          ? 'The "' + this.profileName + '" permission profile allows reading "' + inputPath + '" but not writing it.'
          : 'Path "' + inputPath + '" is outside the "' + this.profileName + '" permission profile.',
        readable ? 'profile.no-write' : 'profile.outside',
        access === 'write' ? 'high' : 'medium',
      );
      strictest = strictest === undefined || severity(decision.verdict) > severity(strictest.verdict) ? decision : strictest;
    }
    return strictest ?? this.allow({ kind: access === 'write' ? 'file.write' : 'file.read', tool }, 'low', 'profile.allow');
  }

  private async evaluateShell(input: unknown): Promise<PolicyDecision> {
    const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const command = typeof record.command === 'string' ? record.command : '';
    const requestedCwd = typeof record.cwd === 'string' ? record.cwd : '.';
    const cwd = path.resolve(this.cwd, expandHome(requestedCwd, homeOf(this.env)));
    const action: PolicyAction = { kind: 'exec', tool: 'Shell', command, cwd, network: false };
    const parsed = parseShellCommand(command, cwd);
    if (pipelinePipesToShell(parsed.segments)) {
      return denied(action, 'Piping a download directly into a shell is forbidden.', 'exec.forbidden', 'POLICY_FORBIDDEN', 'high');
    }
    for (const segment of parsed.segments) {
      const forbidden = forbiddenSegment(segment, this.env);
      if (forbidden !== undefined) {
        return denied(action, forbidden + ' (segment: ' + segment.raw + ').', 'exec.forbidden', 'POLICY_FORBIDDEN', 'high');
      }
    }
    if (this.allowAll) return this.allow(action, 'high', 'profile.danger-full-access');
    if (parsed.hasUnsafeConstruct) {
      return this.askOrDeny(
        action,
        'Shell command uses a construct the policy parser cannot evaluate safely (substitution, heredoc or unbalanced syntax).',
        'exec.parse',
        'high',
      );
    }

    let strictest: PolicyDecision | undefined;
    const consider = (decision: PolicyDecision): void => {
      strictest = strictest === undefined || severity(decision.verdict) > severity(strictest.verdict) ? decision : strictest;
    };

    for (const segment of parsed.segments) {
      const segmentCwd = await canonicalizePath(segment.cwd);
      if (!isInsideAny(this.readRoots, segmentCwd)) {
        consider(
          this.askOrDeny(
            action,
            'Command runs from "' + segmentCwd + '", outside the permission profile roots.',
            'exec.cwd',
            'high',
          ),
        );
        continue;
      }
      let deniedArg: string | undefined;
      let outsideArg: string | undefined;
      for (const arg of segment.args) {
        if (arg.startsWith('-') || arg.length === 0 || arg.includes('://')) continue;
        const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
        if (value.length === 0 || value.startsWith('-') || !isPathLikeArg(value)) continue;
        const candidate = await canonicalizePath(normalizeCommandPath(value, segmentCwd, this.env));
        if (this.isPathDenied(candidate)) {
          deniedArg = arg;
          break;
        }
        if (!isInsideAny(this.readRoots, candidate)) {
          outsideArg = arg;
        }
      }
      if (deniedArg !== undefined) {
        consider(
          denied(
            action,
            'Shell command references a denied path: ' + deniedArg + '.',
            'profile.deny',
            'PERMISSION_DENIED',
            'high',
          ),
        );
        continue;
      }
      if (outsideArg !== undefined) {
        consider(
          this.askOrDeny(
            action,
            'Shell command references an absolute path outside the profile: ' + outsideArg + '.',
            'exec.path',
            'high',
          ),
        );
        continue;
      }
      if (isNetworkSegment(segment)) {
        action.network = true;
        if (!this.network.enabled) {
          consider(
            this.askOrDeny(
              action,
              'Network access is disabled by the "' + this.profileName + '" permission profile.',
              'network.disabled',
              'high',
            ),
          );
          continue;
        }
        if (!networkAllowed(this.network.domains, hostFromSegment(segment))) {
          consider(
            this.askOrDeny(
              action,
              'Network target is not allowed by the permission profile.',
              'network.domain',
              'high',
            ),
          );
          continue;
        }
      }
      if (this.readOnly && !isReadOnlyProgram(basenameOf(segment.program), segment.args)) {
        consider(
          this.askOrDeny(
            action,
            'The read-only profile only allows read-only commands; "' + segment.program + '" is not on the allowlist.',
            'profile.read-only',
            'high',
          ),
        );
        continue;
      }
      if (segment.program === 'cd' && segment.args.length > 0 && !segment.args[0]?.startsWith('-')) {
        const target = await canonicalizePath(normalizeCommandPath(segment.args[0] as string, segmentCwd, this.env));
        if (!isInsideAny(this.readRoots, target)) {
          consider(
            this.askOrDeny(
              action,
              'Changing into "' + segment.args[0] + '" leaves the permission profile roots.',
              'exec.cd',
              'high',
            ),
          );
          continue;
        }
      }
      for (const redirect of segment.redirects) {
        // 2>&1-style descriptor duplication and /dev/null are not file writes.
        if (redirect.path.startsWith('&')) continue;
        const target = await canonicalizePath(normalizeCommandPath(redirect.path, segmentCwd, this.env));
        if (target === '/dev/null' || target === 'NUL') continue;
        if (this.isPathDenied(target)) {
          consider(
            denied(
              action,
              'Shell redirection references a denied path: ' + redirect.path + '.',
              'profile.deny',
              'PERMISSION_DENIED',
              'high',
            ),
          );
          continue;
        }
        if (redirect.operator === '<') {
          if (!isInsideAny(this.readRoots, target)) {
            consider(
              this.askOrDeny(
                action,
                'Shell input redirection reads outside the permission profile: ' + redirect.path + '.',
                'exec.redirect',
                'high',
              ),
            );
          }
          continue;
        }
        if (!isInsideAny(this.writeRoots, target)) {
          consider(
            this.askOrDeny(
              action,
              'Shell redirection writes outside the permission profile: ' + redirect.path + '.',
              'exec.redirect',
              'high',
            ),
          );
        }
      }
    }

    if (strictest === undefined) {
      consider(this.allow(action, 'high', 'profile.allow'));
    }
    return strictest as PolicyDecision;
  }

  async evaluate(tool: string, input: unknown): Promise<PolicyDecision> {
    if (PASSIVE_TOOLS.has(tool)) {
      const action: PolicyAction = { kind: 'tool', tool };
      return this.allow(action, 'low', 'profile.passive');
    }
    if (tool === 'Shell') return this.evaluateShell(input);
    if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) return this.evaluateFile(tool, input);
    const action: PolicyAction = { kind: 'tool', tool };
    return this.askOrDeny(action, 'Tool "' + tool + '" has no declared permission action.', 'tool.unknown', 'medium');
  }
}

function severity(verdict: PolicyVerdict): number {
  return verdict === 'deny' ? 2 : verdict === 'ask' ? 1 : 0;
}

export async function createPolicyRuntime(options: PolicyRuntimeOptions): Promise<PolicyRuntime> {
  const profile = options.config.profiles[options.config.defaultProfile];
  if (!profile) {
    throw new ConfigError('Unknown permission profile "' + options.config.defaultProfile + '".', {
      details: { code: 'PERMISSION_PROFILE_UNKNOWN' },
    });
  }
  const canonicalCwd = await canonicalizePath(options.cwd);
  const additionalDirs = await Promise.all(options.additionalDirs.map((directory) => canonicalizePath(directory)));
  const resolved = await resolveProfileRoots(profile, {
    cwd: canonicalCwd,
    additionalDirs,
    env: options.env,
    ...(options.sessionDir === undefined ? {} : { sessionDir: options.sessionDir }),
  });
  return new Runtime(
    { ...options, cwd: canonicalCwd, additionalDirs },
    resolved,
    profile,
  );
}

export function approvalRequestFor(decision: PolicyDecision): ApprovalRequest {
  return {
    tool: decision.action.tool,
    action: decision.action,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    risk: decision.risk,
  };
}
