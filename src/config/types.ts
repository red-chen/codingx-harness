import type { Protocol, ReasoningEffort } from '../providers/types.js';
import type { ApprovalPolicy, ApprovalsReviewer, PermissionsConfig } from '../policy/types.js';
import type { HookConfig } from '../hooks/types.js';

export type ApprovalMode = 'on-request' | 'never' | 'always-ask';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type NetworkMode = 'none' | 'loopback' | 'local' | 'all';
export type RouteStrategy = 'failover' | 'weighted' | 'round-robin';
export type Affinity = 'session' | 'turn' | 'none';

export interface ProviderConfig {
  protocol: Protocol;
  endpoint: string;
  /** Name of the environment variable that holds the credential. */
  apiKeyEnv: string;
}

export interface TargetConfig {
  provider: string;
  model: string;
  weight: number;
}

export interface RouteConfig {
  strategy: RouteStrategy;
  affinity: Affinity;
  maxAttempts: number;
  failureThreshold: number;
  cooldownSeconds: number;
  targets: TargetConfig[];
}

export interface ApprovalConfig {
  mode: ApprovalMode;
  rememberInSession: boolean;
  /** Legacy always-ask compatibility: ask for every tool call. */
  alwaysAsk: boolean;
  allow: { exec: string[]; write: string[] };
  deny: { exec: string[]; write: string[] };
}

export interface SandboxConfig {
  mode: SandboxMode;
  network: NetworkMode;
  writableRoots: string[];
  readableRoots: string[];
  envPassthrough: string[];
}

export interface ToolsConfig {
  allowCustom: boolean;
  maxOutputChars: number;
}

export interface WebConfig {
  enabled: boolean;
  allowedDomains: string[];
}

export interface SessionConfig {
  /** Absolute path after config normalization. */
  dir: string;
  retentionDays: number;
}

export interface SessiondConfig {
  enabled: boolean;
  /** Absolute path after config normalization. */
  socket: string;
  autostart: boolean;
  idleTimeoutSeconds: number;
  /** Absolute path after config normalization. */
  log: string;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ModelConfig {
  route: string;
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens: number;
  temperature: number;
  contextWindow?: number;
}

export interface AgentConfig {
  maxSteps: number;
}

export interface Config {
  model: ModelConfig;
  agent: AgentConfig;
  /** New-style approval policy (Codex-aligned); legacy [approval].mode is kept for compatibility. */
  approvalPolicy: ApprovalPolicy;
  approvalsReviewer: ApprovalsReviewer;
  permissions: PermissionsConfig;
  providers: Record<string, ProviderConfig>;
  routes: Record<string, RouteConfig>;
  approval: ApprovalConfig;
  sandbox: SandboxConfig;
  tools: ToolsConfig;
  web: WebConfig;
  session: SessionConfig;
  sessiond: SessiondConfig;
  mcp: { servers: McpServerConfig[] };
  /** User-configured Agent Harness lifecycle hooks (global config only). */
  hooks: HookConfig[];
}

export interface ConfigOverrides {
  /** Explicit default clears a configured or restored effort. */
  reasoningEffort?: ReasoningEffort | 'default';
  route?: string;
  model?: string;
  provider?: string;
  /** Legacy approval.mode override (CODINGX_APPROVAL / CLI compatibility). */
  approvalMode?: ApprovalMode;
  /** New-style on-request / never override. */
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: ApprovalsReviewer;
  /** Named permission profile (or a built-in ":name"). */
  permissionProfile?: string;
  /** Legacy sandbox mode shorthand; maps to a built-in profile. */
  sandboxMode?: SandboxMode;
  /** --yolo: danger-full-access + never. */
  dangerouslyBypass?: boolean;
}

export interface ConfigFilePaths {
  global: string;
  project?: string;
}

export interface LoadedConfig {
  config: Config;
  overrides: ConfigOverrides;
  warnings: string[];
  codingxHome: string;
  configFiles: ConfigFilePaths;
  logLevel: 'info' | 'debug';
  /** Validated cwd-specific interactive defaults, below explicit CLI/env overrides. */
  workspacePreferences?: WorkspacePreferences;
}

export interface WorkspaceModelPreference {
  model: string;
  provider: string;
  route: string;
  reasoningEffort: ReasoningEffort | 'default';
}

export interface WorkspacePreferences {
  model?: WorkspaceModelPreference;
  permissionProfile?: string;
}

export interface LoadConfigOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Overrides ~/.codingx, usually for tests. */
  codingxHome?: string;
  /** CLI values; highest priority. */
  cli?: ConfigOverrides;
}
