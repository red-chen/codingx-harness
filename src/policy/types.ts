/** Permission primitives shared by config, tools and the CLI. */
export type ApprovalPolicy = 'on-request' | 'never';
export type ApprovalsReviewer = 'user' | 'auto_review';
export type FileAccess = 'read' | 'write' | 'deny';
export type PolicyVerdict = 'allow' | 'ask' | 'deny';

export type PolicyActionKind = 'file.read' | 'file.write' | 'file.delete' | 'exec' | 'network' | 'tool';

/** Structured description of what a tool is about to do. */
export interface PolicyAction {
  kind: PolicyActionKind;
  tool: string;
  /** Canonical absolute path for file actions. */
  path?: string;
  /** Raw command for exec actions (shown to the user, never executed by policy). */
  command?: string;
  cwd?: string;
  /** True when the action may use the network. */
  network?: boolean;
  /** Additional human-readable detail (for example the matched command segment). */
  detail?: string;
}

export type PolicyErrorCode =
  | 'PERMISSION_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'POLICY_FORBIDDEN'
  | 'SANDBOX_UNAVAILABLE'
  | 'PERMISSION_PROFILE_UNKNOWN'
  | 'PERMISSION_CONFIG_CONFLICT';

export interface PolicyDecision {
  verdict: PolicyVerdict;
  code?: PolicyErrorCode;
  reason?: string;
  /** Short, stable description of the rule that produced the decision. */
  rule?: string;
  action: PolicyAction;
  risk: 'low' | 'medium' | 'high';
}

export interface ApprovalRequest {
  tool: string;
  action: PolicyAction;
  reason?: string;
  risk: 'low' | 'medium' | 'high';
  /** Set by AgentLoop so the UI and rollout can correlate the request. */
  turnId?: string;
  callId?: string;
}

export type ApprovalDecision =
  | { decision: 'allow'; scope: 'once' | 'session' | 'prefix' }
  | { decision: 'deny'; reason?: string };

export type ApprovalHandler = (
  request: ApprovalRequest,
  signal?: AbortSignal,
) => Promise<ApprovalDecision>;

/** A filesystem rule from a profile. Scopes use Codex-style names. */
export interface FilesystemRule {
  /**
   * :minimal | :root | :workspace_roots | :tmpdir | :slash_tmp |
   * :git_hooks | :git_config | absolute path | ~/path
   */
  scope: string;
  /** Optional subpath/glob for nested ":workspace_roots" style tables. */
  subpath?: string;
  access: FileAccess;
}

export interface NetworkPolicy {
  enabled: boolean;
  /** Domain pattern (exact, *.example.com or **.example.com) to allow/deny. */
  domains: Record<string, 'allow' | 'deny'>;
}

export interface PermissionProfile {
  name: string;
  extends?: string;
  filesystem: FilesystemRule[];
  network: NetworkPolicy;
  source: 'builtin' | 'config';
}

export interface PermissionsConfig {
  /** Selected profile name, for example ":workspace" or "project-edit". */
  defaultProfile: string;
  profiles: Record<string, PermissionProfile>;
}

/** Snapshot of resolved roots consumed by the OS sandbox backend. */
export interface SandboxPolicy {
  profileName: string;
  cwd: string;
  home: string;
  tmpdir: string;
  readRoots: readonly string[];
  writeRoots: readonly string[];
  denyRoots: readonly string[];
  denyGlobs: ReadonlyArray<{ base: string | null; pattern: string }>;
  additionalDirs: readonly string[];
  network: NetworkPolicy;
  sessionDir?: string;
  yolo: boolean;
  /** True when the profile explicitly allows .git/hooks writes. */
  gitHooksWritable: boolean;
  /** True when the profile explicitly allows .git/config writes. */
  gitConfigWritable: boolean;
}

export interface PolicyRuntimeOptions {
  cwd: string;
  additionalDirs: readonly string[];
  env: NodeJS.ProcessEnv;
  config: PermissionsConfig;
  approvalPolicy: ApprovalPolicy;
  reviewer: ApprovalsReviewer;
  /** Legacy approval.mode = always-ask: ask for every tool call. */
  alwaysAsk?: boolean;
  /** Session directory that must never be readable by tools. */
  sessionDir?: string;
}

export interface PolicyRuntime {
  readonly profileName: string;
  readonly approvalPolicy: ApprovalPolicy;
  readonly reviewer: ApprovalsReviewer;
  /** True when the selected profile has no filesystem sandbox (:danger-full-access). */
  readonly yolo: boolean;
  readonly cwd: string;
  readonly additionalDirs: readonly string[];
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly sandboxPolicy: SandboxPolicy;
  evaluate(tool: string, input: unknown): Promise<PolicyDecision>;
  rootsFor(access: 'read' | 'write'): readonly string[];
  /** Sensitive-path guard used by the resolver as a second check. */
  isPathDenied(absolutePath: string): boolean;
}

export interface ShellSegment {
  /** Executable token, without quotes. */
  program: string;
  args: string[];
  /** Canonical-ish cwd after applying a literal cd in this segment. */
  cwd: string;
  /** Output/input redirection targets. */
  redirects: Array<{ operator: '>' | '>>' | '<'; path: string }>;
  raw: string;
}

export interface ParsedShellCommand {
  segments: ShellSegment[];
  parseError?: string;
  hasSubstitution: boolean;
  hasHeredoc: boolean;
  hasUnsafeConstruct: boolean;
}
