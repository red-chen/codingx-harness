import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { ConfigError } from '../util/errors.js';
import { WorkspacePreferencesStore } from './workspace-preferences.js';
import { loadExecRules } from '../policy/rules/index.js';
import { REASONING_EFFORTS } from '../providers/types.js';
import { expandHome } from '../util/paths.js';
import type {
  Affinity,
  ApprovalMode,
  Config,
  ConfigOverrides,
  LoadConfigOptions,
  LoadedConfig,
  McpServerConfig,
  ProviderConfig,
  RouteConfig,
  RouteStrategy,
  SandboxConfig,
  SandboxMode,
  TargetConfig,
} from './types.js';
import type { ApprovalPolicy, ApprovalsReviewer } from '../policy/types.js';
import type { HookConfig, HookEvent } from '../hooks/types.js';
import { DEFAULT_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS } from '../hooks/types.js';
import { DANGER_PROFILE, parsePermissions, READ_ONLY_PROFILE, WORKSPACE_PROFILE } from '../policy/index.js';

const DEFAULT_ENV_PASSTHROUGH = ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'USER', 'SHELL'];
const reasoningEffortSchema = z.enum([...REASONING_EFFORTS, 'default']);

const httpUrl = z
  .string()
  .min(1)
  .url()
  .refine((value) => value.startsWith('https://') || value.startsWith('http://'), {
    message: 'must be an http(s) URL',
  });

const providerSchema = z.object({
  protocol: z.enum(['anthropic-messages', 'openai-responses']).default('anthropic-messages'),
  endpoint: httpUrl,
  api_key_env: z.string().min(1).default('API_KEY'),
});

const targetSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  weight: z.number().positive().optional(),
});

const routeSchema = z.object({
  strategy: z.enum(['failover', 'weighted', 'round-robin']).default('failover'),
  affinity: z.enum(['session', 'turn', 'none']).default('session'),
  max_attempts: z.number().int().positive().default(3),
  failure_threshold: z.number().int().positive().default(3),
  cooldown_seconds: z.number().int().nonnegative().default(30),
  targets: z.array(targetSchema).default([]),
});

const hookSchema = z.object({
  event: z.enum([
    'session_start',
    'session_end',
    'user_prompt_submit',
    'pre_tool_use',
    'post_tool_use',
    'stop',
  ]),
  command: z.string().min(1),
  timeout_ms: z.number().int().min(100).max(MAX_HOOK_TIMEOUT_MS).default(DEFAULT_HOOK_TIMEOUT_MS),
  matcher: z.string().min(1).optional(),
});

const mcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
});

const permissionProfileSchema = z.object({
  extends: z.string().min(1).optional(),
  filesystem: z.record(z.unknown()).optional(),
  network: z
    .object({
      enabled: z.boolean().optional(),
      mode: z.enum(['none', 'local', 'all']).optional(),
      domains: z.record(z.enum(['allow', 'deny'])).optional(),
    })
    .optional(),
});

const rawConfigSchema = z.object({
  status_bar: z.object({
    plugin: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    timeout_ms: z.number().int().min(100).max(10000).default(1000),
    refresh_ms: z.number().int().min(250).max(60000).default(1000),
  }).optional(),
  exec_policy: z.object({ rule_files: z.array(z.string().min(1)).default([]) }).default({}),
  approval_policy: z.enum(['on-request', 'never']).optional(),
  approvals_reviewer: z.enum(['user', 'auto_review']).optional(),
  default_permissions: z.string().min(1).optional(),
  permissions: z.record(permissionProfileSchema).default({}),
  model: z
    .object({
      route: z.string().min(1).default('default'),
      reasoning_effort: reasoningEffortSchema.optional(),
      max_output_tokens: z.number().int().positive().default(8192),
      temperature: z.number().min(0).max(2).default(0),
      context_window: z.number().int().positive().optional(),
    })
    .default({}),
  agent: z
    .object({
      max_steps: z.number().int().positive().default(64),
      max_parallel_tools: z.number().int().min(1).max(32).default(4),
    })
    .default({}),
  provider: z.record(providerSchema).default({}),
  routes: z.record(routeSchema).default({}),
  approval: z
    .object({
      mode: z.enum(['on-request', 'never', 'always-ask']).default('on-request'),
      remember_in_session: z.boolean().default(true),
      allow: z
        .object({
          exec: z.array(z.string()).default([]),
          write: z.array(z.string()).default([]),
        })
        .default({}),
      deny: z
        .object({
          exec: z.array(z.string()).default([]),
          write: z.array(z.string()).default([]),
        })
        .default({}),
    })
    .default({}),
  sandbox: z
    .object({
      mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
      network: z.enum(['none', 'loopback', 'local', 'all']).default('none'),
      writable_roots: z.array(z.string()).default([]),
      readable_roots: z.array(z.string()).default([]),
      env_passthrough: z.array(z.string()).default(DEFAULT_ENV_PASSTHROUGH),
    })
    .default({}),
  tools: z
    .object({
      allow_custom: z.boolean().default(false),
      max_output_chars: z.number().int().positive().default(30000),
    })
    .default({}),
  web: z
    .object({
      enabled: z.boolean().default(false),
      allowed_domains: z.array(z.string()).default([]),
    })
    .default({}),
  session: z
    .object({
      dir: z.string().min(1).optional(),
      retention_days: z.number().int().nonnegative().default(30),
    })
    .default({}),
  sessiond: z
    .object({
      enabled: z.boolean().default(true),
      socket: z.string().min(1).optional(),
      autostart: z.boolean().default(true),
      idle_timeout_seconds: z.number().int().nonnegative().default(1800),
      log: z.string().min(1).optional(),
    })
    .default({}),
  mcp: z
    .object({
      servers: z.array(mcpServerSchema).default([]),
    })
    .default({}),
  hooks: z.array(hookSchema).default([]),
});

type RawConfig = z.infer<typeof rawConfigSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return structuredClone(value);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return clone(base);
  if (base === undefined) return clone(override);
  if (Array.isArray(base) || Array.isArray(override)) return clone(override);
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = clone(base);
    for (const [key, value] of Object.entries(override)) {
      if (!isSafeKey(key)) continue;
      out[key] = deepMerge(base[key], value);
    }
    return out;
  }
  return clone(override);
}

function asObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

async function readTomlFile(filePath: string, label: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigError(
      'Cannot read ' + label + ' config at ' + filePath + ': ' + (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
  try {
    const parsed: unknown = parseToml(text);
    if (!isPlainObject(parsed)) throw new Error('top-level value must be a table');
    return parsed;
  } catch (error) {
    throw new ConfigError(
      'Invalid TOML in ' + filePath + ': ' + (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
}

function sanitizeProjectConfig(raw: Record<string, unknown>, warnings: string[]): void {
  if (raw.provider !== undefined) {
    delete raw.provider;
    warnings.push('Project config cannot define or override [provider.*]; the section was ignored.');
  }
  if (raw.sessiond !== undefined) {
    delete raw.sessiond;
    warnings.push('Project config cannot override [sessiond]; the section was ignored.');
  }
  if (raw.sandbox !== undefined) {
    delete raw.sandbox;
    warnings.push('Project config cannot override [sandbox]; the section was ignored.');
  }
  for (const key of ['permissions', 'default_permissions', 'approval_policy', 'approvals_reviewer', 'projects', 'hooks', 'exec_policy', 'status_bar']) {
    if (raw[key] !== undefined) {
      delete raw[key];
      warnings.push('Project config cannot override ' + key + '; the value was ignored.');
    }
  }
  const session = asObject(raw.session);
  if (raw.session !== undefined && isPlainObject(raw.session)) {
    for (const key of ['dir', 'retention_days']) {
      if (key in session) {
        delete session[key];
        warnings.push('Project config cannot override session.' + key + '; the value was ignored.');
      }
    }
  }
}

function applyEnvOverrides(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): void {
  if (env.CODINGX_ROUTE) {
    raw.model = { ...asObject(raw.model), route: env.CODINGX_ROUTE };
  }
  if (env.CODINGX_APPROVAL) {
    raw.approval = { ...asObject(raw.approval), mode: env.CODINGX_APPROVAL };
  }
  if (env.CODINGX_APPROVAL_POLICY) raw.approval_policy = env.CODINGX_APPROVAL_POLICY;
  if (env.CODINGX_APPROVALS_REVIEWER) raw.approvals_reviewer = env.CODINGX_APPROVALS_REVIEWER;
  if (env.CODINGX_PERMISSION_PROFILE) raw.default_permissions = env.CODINGX_PERMISSION_PROFILE;
  if (env.CODINGX_SANDBOX) {
    raw.sandbox = { ...asObject(raw.sandbox), mode: env.CODINGX_SANDBOX };
  }
  if (env.CODINGX_SESSIOND !== undefined) {
    if (env.CODINGX_SESSIOND !== '0' && env.CODINGX_SESSIOND !== '1') {
      throw new ConfigError('CODINGX_SESSIOND must be 0 or 1 (got "' + env.CODINGX_SESSIOND + '").');
    }
    raw.sessiond = { ...asObject(raw.sessiond), enabled: env.CODINGX_SESSIOND === '1' };
  }
  if (env.CODINGX_SESSIOND_SOCKET) {
    raw.sessiond = { ...asObject(raw.sessiond), socket: env.CODINGX_SESSIOND_SOCKET };
  }
}

function parseRaw(raw: Record<string, unknown>, globalPath: string, projectPath?: string): RawConfig {
  const result = rawConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => '  - ' + (issue.path.length > 0 ? issue.path.join('.') : '<root>') + ': ' + issue.message)
      .join('\n');
    const files = projectPath ? globalPath + ' + ' + projectPath : globalPath;
    throw new ConfigError('Invalid codingx config (' + files + '):\n' + issues);
  }
  return result.data;
}

function expandEnvVars(input: string, env: NodeJS.ProcessEnv): string {
  let value = input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? '');
  value = value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => env[name] ?? '');
  return value;
}

function normalizeConfigPath(input: string, baseDir: string, env: NodeJS.ProcessEnv): string {
  const expanded = expandHome(expandEnvVars(input, env));
  return path.resolve(baseDir, expanded);
}

function normalizeProviders(raw: RawConfig): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, provider] of Object.entries(raw.provider)) {
    providers[id] = {
      protocol: provider.protocol,
      endpoint: provider.endpoint,
      apiKeyEnv: provider.api_key_env,
    };
  }
  return providers;
}

function normalizeRoutes(raw: RawConfig): Record<string, RouteConfig> {
  const routes: Record<string, RouteConfig> = {};
  for (const [name, route] of Object.entries(raw.routes)) {
    const targets: TargetConfig[] = route.targets.map((target) => ({
      provider: target.provider,
      model: target.model,
      weight: target.weight ?? 1,
    }));
    routes[name] = {
      strategy: route.strategy as RouteStrategy,
      affinity: route.affinity as Affinity,
      maxAttempts: route.max_attempts,
      failureThreshold: route.failure_threshold,
      cooldownSeconds: route.cooldown_seconds,
      targets,
    };
  }
  return routes;
}

function normalizeSandbox(raw: RawConfig, cwd: string, env: NodeJS.ProcessEnv): SandboxConfig {
  return {
    mode: raw.sandbox.mode,
    network: raw.sandbox.network,
    writableRoots: raw.sandbox.writable_roots.map((root) => normalizeConfigPath(root, cwd, env)),
    readableRoots: raw.sandbox.readable_roots.map((root) => normalizeConfigPath(root, cwd, env)),
    envPassthrough: [...raw.sandbox.env_passthrough],
  };
}

const PROFILE_BY_SANDBOX: Record<SandboxMode, string> = {
  'read-only': READ_ONLY_PROFILE,
  'workspace-write': WORKSPACE_PROFILE,
  'danger-full-access': DANGER_PROFILE,
};

const APPROVAL_BY_MODE: Record<ApprovalMode, ApprovalPolicy> = {
  'on-request': 'on-request',
  never: 'never',
  'always-ask': 'on-request',
};

function conflict(message: string): ConfigError {
  return new ConfigError(message, { details: { code: 'PERMISSION_CONFIG_CONFLICT' } });
}

/** Resolve legacy sections, new top-level policy keys and CLI overrides into one policy. */
function resolvePolicySettings(
  raw: RawConfig,
  merged: Record<string, unknown>,
  config: Config,
  overrides: ConfigOverrides,
  warnings: string[],
): void {
  const legacyApprovalExplicit = asObject(merged.approval).mode !== undefined;
  const legacySandboxExplicit = asObject(merged.sandbox).mode !== undefined;
  const hasNewPermissionConfig =
    raw.default_permissions !== undefined || Object.keys(raw.permissions as Record<string, unknown>).length > 0;
  if (legacySandboxExplicit && !hasNewPermissionConfig) {
    warnings.push('Legacy [sandbox] config is supported; prefer default_permissions / [permissions.*] in new configs.');
  }
  if (legacyApprovalExplicit && raw.approval_policy === undefined) {
    warnings.push('Legacy [approval].mode is supported; prefer approval_policy in new configs.');
  }
  const cli = overrides;

  if (cli.dangerouslyBypass) {
    if (
      cli.approvalMode !== undefined ||
      cli.approvalPolicy !== undefined ||
      cli.approvalsReviewer !== undefined ||
      cli.permissionProfile !== undefined ||
      cli.sandboxMode !== undefined
    ) {
      throw conflict('--yolo / --allow-dangerously-skip-permissions cannot be combined with other permission flags.');
    }
  }
  if (cli.permissionProfile !== undefined && cli.sandboxMode !== undefined) {
    throw conflict('Use either --permission-profile or --sandbox, not both.');
  }
  if (
    raw.default_permissions !== undefined &&
    legacySandboxExplicit &&
    cli.permissionProfile === undefined &&
    cli.sandboxMode === undefined &&
    cli.dangerouslyBypass !== true
  ) {
    throw conflict(
      'default_permissions and legacy sandbox.mode cannot both be set. Remove one of them or override with --permission-profile.',
    );
  }
  if (
    raw.approval_policy !== undefined &&
    legacyApprovalExplicit &&
    cli.approvalPolicy === undefined &&
    cli.approvalMode === undefined &&
    cli.dangerouslyBypass !== true
  ) {
    throw conflict(
      'approval_policy and legacy approval.mode cannot both be set. Remove one of them or override with --ask-for-approval.',
    );
  }

  const effectiveLegacyApproval = cli.approvalMode ?? raw.approval.mode;
  const alwaysAsk =
    cli.dangerouslyBypass !== true &&
    cli.approvalPolicy === undefined &&
    raw.approval_policy === undefined &&
    effectiveLegacyApproval === 'always-ask';

  let profileName =
    cli.permissionProfile ??
    (cli.sandboxMode === undefined ? undefined : PROFILE_BY_SANDBOX[cli.sandboxMode]) ??
    raw.default_permissions ??
    PROFILE_BY_SANDBOX[raw.sandbox.mode];
  if (cli.dangerouslyBypass === true) profileName = DANGER_PROFILE;

  let approvalPolicy =
    cli.approvalPolicy ??
    (cli.approvalMode === undefined ? undefined : APPROVAL_BY_MODE[cli.approvalMode]) ??
    raw.approval_policy ??
    APPROVAL_BY_MODE[raw.approval.mode];
  if (cli.dangerouslyBypass === true) approvalPolicy = 'never';

  let reviewer: ApprovalsReviewer = cli.approvalsReviewer ?? raw.approvals_reviewer ?? 'user';
  if (cli.dangerouslyBypass === true) reviewer = 'user';

  config.permissions = parsePermissions(raw.permissions as Record<string, unknown>, profileName);

  // Legacy [sandbox] writable_roots/network should keep working until the
  // profile migration is complete. Only apply them when no new permission
  // profile config is present; conflicts are handled above.
  const legacySandbox = asObject(merged.sandbox);
  const hasLegacySandboxRules =
    legacySandbox.writable_roots !== undefined ||
    legacySandbox.readable_roots !== undefined ||
    legacySandbox.network !== undefined;
  if (hasLegacySandboxRules && !hasNewPermissionConfig) {
    const profile = config.permissions.profiles[profileName];
    if (profile) {
      const extraRules = [
        ...(config.sandbox.mode === 'workspace-write'
          ? config.sandbox.writableRoots.map((root) => ({ scope: root, access: 'write' as const }))
          : []),
        ...config.sandbox.readableRoots.map((root) => ({ scope: root, access: 'read' as const })),
      ];
      const network = legacySandbox.network === undefined ? profile.network :
        config.sandbox.network === 'all'
          ? { enabled: true, domains: {} }
          : (config.sandbox.network === 'loopback' || config.sandbox.network === 'local')
            ? {
                enabled: true,
                mode: 'local' as const,
                domains: {},
              }
            : { enabled: false, domains: {} };
      config.permissions.profiles[profileName] = {
        ...profile,
        filesystem: [...profile.filesystem, ...extraRules],
        network,
      };
    }
  }

  config.approvalPolicy = approvalPolicy;
  config.approvalsReviewer = reviewer;
  config.approval.alwaysAsk = alwaysAsk;
  config.approval.mode = alwaysAsk ? 'always-ask' : approvalPolicy;
  config.sandbox.mode =
    profileName === READ_ONLY_PROFILE
      ? 'read-only'
      : profileName === DANGER_PROFILE
        ? 'danger-full-access'
        : profileName === WORKSPACE_PROFILE
          ? 'workspace-write'
          : raw.sandbox.mode;
}

function normalizeHooks(raw: RawConfig): HookConfig[] {
  return raw.hooks.map((hook) => ({
    event: hook.event as HookEvent,
    command: hook.command,
    timeoutMs: hook.timeout_ms,
    ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
  }));
}

function normalizeMcpServers(raw: RawConfig): McpServerConfig[] {
  return raw.mcp.servers.map((server) => ({
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: { ...server.env },
  }));
}

function validateRoutes(config: Config): void {
  for (const [name, route] of Object.entries(config.routes)) {
    if (route.targets.length === 0) {
      throw new ConfigError(
        'Route "' + name + '" has no targets. Add [[routes.' + name + '.targets]] with provider and model.',
      );
    }
    for (const target of route.targets) {
      if (!config.providers[target.provider]) {
        throw new ConfigError(
          'Route "' + name + '" references unknown provider "' + target.provider + '". ' +
            'Providers can only be defined in the global config.',
        );
      }
    }
  }
}

function collectOverrides(env: NodeJS.ProcessEnv, cli: ConfigOverrides | undefined): ConfigOverrides {
  const effort = cli?.reasoningEffort ?? env.CODINGX_REASONING_EFFORT;
  const route = cli?.route ?? env.CODINGX_ROUTE;
  const model = cli?.model ?? env.CODINGX_MODEL;
  const provider = cli?.provider ?? env.CODINGX_PROVIDER;
  const approvalMode = cli?.approvalMode ?? (env.CODINGX_APPROVAL as ApprovalMode | undefined);
  const approvalPolicy = cli?.approvalPolicy ?? (env.CODINGX_APPROVAL_POLICY as ApprovalPolicy | undefined);
  const approvalsReviewer =
    cli?.approvalsReviewer ?? (env.CODINGX_APPROVALS_REVIEWER as ApprovalsReviewer | undefined);
  const permissionProfile = cli?.permissionProfile ?? env.CODINGX_PERMISSION_PROFILE;
  const sandboxMode = cli?.sandboxMode ?? (env.CODINGX_SANDBOX as SandboxMode | undefined);
  const overrides: ConfigOverrides = {};
  if (effort !== undefined) {
    const parsed = reasoningEffortSchema.safeParse(effort);
    if (!parsed.success) {
      throw new ConfigError('Invalid reasoning effort: ' + effort + '. Use ' + REASONING_EFFORTS.join('|') + '|default.');
    }
    overrides.reasoningEffort = parsed.data;
  }
  if (route) overrides.route = route;
  if (model) overrides.model = model;
  if (provider) overrides.provider = provider;
  if (approvalMode) overrides.approvalMode = approvalMode;
  if (approvalPolicy) overrides.approvalPolicy = approvalPolicy;
  if (approvalsReviewer) overrides.approvalsReviewer = approvalsReviewer;
  if (permissionProfile) overrides.permissionProfile = permissionProfile;
  if (sandboxMode) overrides.sandboxMode = sandboxMode;
  if (cli?.dangerouslyBypass === true) overrides.dangerouslyBypass = true;
  return overrides;
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd);
  const codingxHome = path.resolve(
    cwd,
    expandHome(options.codingxHome ?? env.CODINGX_HOME ?? path.join(os.homedir(), '.codingx')),
  );
  const globalPath = path.join(codingxHome, 'config.toml');
  const projectPath = path.join(cwd, '.codingx', 'config.toml');

  const warnings: string[] = [];
  const globalRaw = await readTomlFile(globalPath, 'global');
  const projectRaw = await readTomlFile(projectPath, 'project');
  if (projectRaw) sanitizeProjectConfig(projectRaw, warnings);

  const merged = deepMerge(globalRaw ?? {}, projectRaw ?? {}) as Record<string, unknown>;
  applyEnvOverrides(merged, env);
  const overrides = collectOverrides(env, options.cli);
  if (overrides.reasoningEffort !== undefined) {
    merged.model = { ...asObject(merged.model), reasoning_effort: overrides.reasoningEffort };
  }
  const raw = parseRaw(merged, globalPath, projectRaw ? projectPath : undefined);

  const config: Config = {
    execRules: await loadExecRules(codingxHome, raw.exec_policy.rule_files.map((file) => normalizeConfigPath(file, codingxHome, env))),
    model: {
      route: raw.model.route,
      ...(raw.model.reasoning_effort === undefined || raw.model.reasoning_effort === 'default'
        ? {} : { reasoningEffort: raw.model.reasoning_effort }),
      maxOutputTokens: raw.model.max_output_tokens,
      temperature: raw.model.temperature,
      ...(raw.model.context_window === undefined ? {} : { contextWindow: raw.model.context_window }),
    },
    agent: { maxSteps: raw.agent.max_steps, maxParallelTools: raw.agent.max_parallel_tools },
    providers: normalizeProviders(raw),
    routes: normalizeRoutes(raw),
    approval: {
      mode: raw.approval.mode,
      rememberInSession: raw.approval.remember_in_session,
      alwaysAsk: false,
      allow: { exec: [...raw.approval.allow.exec], write: [...raw.approval.allow.write] },
      deny: { exec: [...raw.approval.deny.exec], write: [...raw.approval.deny.write] },
    },
    sandbox: normalizeSandbox(raw, cwd, env),
    tools: { allowCustom: raw.tools.allow_custom, maxOutputChars: raw.tools.max_output_chars },
    web: { enabled: raw.web.enabled, allowedDomains: [...raw.web.allowed_domains] },
    session: {
      dir: normalizeConfigPath(raw.session.dir ?? path.join(codingxHome, 'sessions'), codingxHome, env),
      retentionDays: raw.session.retention_days,
    },
    sessiond: {
      enabled: raw.sessiond.enabled,
      socket: normalizeConfigPath(
        raw.sessiond.socket ?? path.join(codingxHome, 'run', 'sessiond.sock'),
        codingxHome,
        env,
      ),
      autostart: raw.sessiond.autostart,
      idleTimeoutSeconds: raw.sessiond.idle_timeout_seconds,
      log: normalizeConfigPath(
        raw.sessiond.log ?? path.join(codingxHome, 'logs', 'sessiond.log'),
        codingxHome,
        env,
      ),
    },
    mcp: { servers: normalizeMcpServers(raw) },
    hooks: normalizeHooks(raw),
    ...(raw.status_bar ? { statusBar: {
      plugin: raw.status_bar.plugin, timeoutMs: raw.status_bar.timeout_ms, refreshMs: raw.status_bar.refresh_ms,
    } } : {}),
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    permissions: parsePermissions({}, WORKSPACE_PROFILE),
  };
  validateRoutes(config);

  if (overrides.approvalMode) config.approval.mode = overrides.approvalMode;
  resolvePolicySettings(raw, merged, config, overrides, warnings);

  const workspacePreferences = await (await WorkspacePreferencesStore.open(codingxHome, cwd)).load(warnings);
  const saved = workspacePreferences.model;
  if (saved && (!config.providers[saved.provider] || !config.routes[saved.route])) {
    warnings.push('The saved cwd model references a removed provider or route; using configured defaults.');
    delete workspacePreferences.model;
  }
  if (workspacePreferences.model) {
    if (!overrides.model && !overrides.provider && !overrides.route) {
      config.model.route = workspacePreferences.model.route;
    }
    if (overrides.reasoningEffort === undefined) {
      const effort = workspacePreferences.model.reasoningEffort;
      config.model.reasoningEffort = effort === 'default' ? undefined : effort;
    }
  }
  const profile = workspacePreferences.permissionProfile;
  if (profile && !config.permissions.profiles[profile]) {
    warnings.push('The saved cwd permission profile no longer exists; using configured defaults.');
    delete workspacePreferences.permissionProfile;
  } else if (profile && overrides.permissionProfile === undefined && overrides.sandboxMode === undefined &&
    overrides.dangerouslyBypass !== true) {
    config.permissions = { ...config.permissions, defaultProfile: profile };
  }

  return {
    config,
    overrides,
    warnings,
    codingxHome,
    configFiles: {
      global: globalPath,
      ...(projectRaw ? { project: projectPath } : {}),
    },
    logLevel: env.CODINGX_LOG === 'debug' ? 'debug' : 'info',
    workspacePreferences,
  };
}

export function getRoute(config: Config, name: string): RouteConfig {
  const route = config.routes[name];
  if (!route) {
    const available = Object.keys(config.routes);
    const hint =
      available.length === 0
        ? 'No routes are configured. Add [provider.<id>], [routes.<name>] and [[routes.<name>.targets]] to ' +
          'the global config.'
        : 'Available routes: ' + available.join(', ') + '.';
    throw new ConfigError('Route "' + name + '" is not configured. ' + hint);
  }
  return route;
}

export function getSelectedRouteName(loaded: LoadedConfig): string {
  return loaded.overrides.route ?? loaded.config.model.route;
}

export function getSelectedRoute(loaded: LoadedConfig): RouteConfig {
  return getRoute(loaded.config, getSelectedRouteName(loaded));
}
