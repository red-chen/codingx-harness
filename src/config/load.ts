import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { ConfigError } from '../util/errors.js';
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
  TargetConfig,
} from './types.js';

const DEFAULT_ENV_PASSTHROUGH = ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'USER', 'SHELL'];

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

const mcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
});

const rawConfigSchema = z.object({
  model: z
    .object({
      route: z.string().min(1).default('default'),
      max_output_tokens: z.number().int().positive().default(8192),
      temperature: z.number().min(0).max(2).default(0),
      context_window: z.number().int().positive().optional(),
    })
    .default({}),
  agent: z
    .object({
      max_steps: z.number().int().positive().default(64),
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
      network: z.enum(['none', 'loopback', 'all']).default('none'),
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
  const route = cli?.route ?? env.CODINGX_ROUTE;
  const model = cli?.model ?? env.CODINGX_MODEL;
  const provider = cli?.provider ?? env.CODINGX_PROVIDER;
  const approvalMode = cli?.approvalMode ?? (env.CODINGX_APPROVAL as ApprovalMode | undefined);
  const overrides: ConfigOverrides = {};
  if (route) overrides.route = route;
  if (model) overrides.model = model;
  if (provider) overrides.provider = provider;
  if (approvalMode) overrides.approvalMode = approvalMode;
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
  const raw = parseRaw(merged, globalPath, projectRaw ? projectPath : undefined);

  const config: Config = {
    model: {
      route: raw.model.route,
      maxOutputTokens: raw.model.max_output_tokens,
      temperature: raw.model.temperature,
      ...(raw.model.context_window === undefined ? {} : { contextWindow: raw.model.context_window }),
    },
    agent: { maxSteps: raw.agent.max_steps },
    providers: normalizeProviders(raw),
    routes: normalizeRoutes(raw),
    approval: {
      mode: raw.approval.mode,
      rememberInSession: raw.approval.remember_in_session,
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
  };
  validateRoutes(config);

  const overrides = collectOverrides(env, options.cli);
  if (overrides.approvalMode) config.approval.mode = overrides.approvalMode;

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
