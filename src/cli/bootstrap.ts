import { LOCAL_NETWORK_NOTICE, networkMode } from '../policy/network.js';
import os from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import {
  getSelectedRoute,
  getSelectedRouteName,
  loadConfig,
  type Config,
  type ConfigOverrides,
  type LoadedConfig,
} from '../config/index.js';
import { createContextSnapshot, buildSystemPrompt, type ContextSnapshot } from '../agent/index.js';
import { createProvider } from '../providers/index.js';
import { ProviderRouter, selectRouteTarget, type RouterPins } from '../routing/index.js';
import { EmbeddedSessionStore, SessiondStore, ensureSessiond, type SessionStoreApi } from '../session/index.js';
import { ToolRegistry, createBuiltinTools } from '../tools/index.js';
import { createPolicyRuntime, type PolicyRuntime } from '../policy/index.js';
import { HookRunner } from '../hooks/index.js';
import { createSandboxBackend, sandboxSummary } from '../sandbox/index.js';
import type { SandboxBackend } from '../sandbox/types.js';
import { loadSkills, type SkillRegistry } from '../skills/index.js';
import { buildChildEnv } from '../exec/index.js';
import { ConfigError } from '../util/errors.js';
import { resolveApiKey } from '../util/auth.js';
import { canonicalizePath, expandHome, isPathInside } from '../util/paths.js';
import { VERSION } from '../version.js';

export interface BootstrapOptions {
  cwd: string;
  cli?: ConfigOverrides;
  /** Extra directories writable alongside cwd (CLI --add-dir). */
  addDirs?: readonly string[];
  /** Bypass all application-level permission checks (CLI --yolo). */
  yolo?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface CliApp {
  loaded: LoadedConfig;
  config: Config;
  cwd: string;
  /** Canonical extra writable directories from --add-dir. */
  additionalDirs: string[];
  /** True when the selected profile has no filesystem sandbox (danger-full-access). */
  yolo: boolean;
  /** Resolved permission profile and approval policy. */
  policy: PolicyRuntime;
  /** OS sandbox backend selected for this host (probed during bootstrap). */
  sandbox: SandboxBackend;
  codingxHome: string;
  store: SessionStoreApi;
  router: ProviderRouter;
  tools: ToolRegistry;
  /** Lifecycle hooks configured in the global config. */
  hooks: HookRunner;
  /** Successful session_start hook stdout, kept for prompt rebuilds. */
  sessionHookContext?: string;
  snapshot: ContextSnapshot;
  skills: SkillRegistry;
  systemPrompt: string;
  shellEnv: Record<string, string>;
  warnings: string[];
  cliVersion: string;
}

/** Validate and canonicalize --add-dir inputs; relative paths resolve from cwd. */
async function resolveAdditionalDirs(
  inputs: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const home = env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : os.homedir();
  const directories: string[] = [];
  for (const input of inputs) {
    if (input.length === 0) throw new ConfigError('--add-dir requires a directory path.');
    const candidate = path.resolve(cwd, expandHome(input, home));
    let info;
    try {
      info = await stat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ConfigError('Additional directory does not exist: ' + input);
      }
      throw new ConfigError(
        'Cannot access additional directory ' + input + ': ' + (error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    }
    if (!info.isDirectory()) throw new ConfigError('Additional directory is not a directory: ' + input);
    const canonical = await canonicalizePath(candidate);
    if (!directories.includes(canonical)) directories.push(canonical);
  }
  return directories;
}

/** Assemble the complete M1 runtime for one CLI invocation. */
export async function bootstrap(options: BootstrapOptions): Promise<CliApp> {
  const cwd = path.resolve(options.cwd);
  const env = options.env ?? process.env;
  const cli = { ...(options.cli ?? {}) };
  if (options.yolo === true) {
    if (
      cli.approvalMode !== undefined ||
      cli.approvalPolicy !== undefined ||
      cli.approvalsReviewer !== undefined ||
      cli.permissionProfile !== undefined ||
      cli.sandboxMode !== undefined ||
      cli.dangerouslyBypass === true
    ) {
      throw new ConfigError('--yolo cannot be combined with other permission flags.');
    }
    cli.dangerouslyBypass = true;
  }
  const loaded = await loadConfig({ cwd, env, cli });
  const warnings = [...loaded.warnings];
  const additionalDirs = await resolveAdditionalDirs(options.addDirs ?? [], cwd, env);
  const policy = await createPolicyRuntime({
    cwd,
    additionalDirs,
    env,
    config: loaded.config.permissions,
    execRules: loaded.config.execRules,
    approvalPolicy: loaded.config.approvalPolicy,
    reviewer: loaded.config.approvalsReviewer,
    alwaysAsk: loaded.config.approval.alwaysAsk,
    sessionDir: loaded.config.session.dir,
  });
  const yolo = policy.yolo;
  const sandbox = await createSandboxBackend();
  const sandboxStatus = sandbox.status;
  if (!yolo && additionalDirs.length > 0) {
    const notAllowed = additionalDirs.filter(
      (directory) => !policy.writeRoots.some((root) => isPathInside(root, directory)),
    );
    if (notAllowed.length > 0) {
      throw new ConfigError(
        '--add-dir "' + notAllowed[0] + '" is not allowed by permission profile "' + policy.profileName +
          '". Use a profile that grants write access to that directory.',
      );
    }
  }
  const explicitYolo = options.yolo === true || loaded.overrides.dangerouslyBypass === true;

  if (yolo) {
    if (sandboxStatus.required && !sandboxStatus.available) {
      throw new ConfigError(
        '--yolo / :danger-full-access requires an OS sandbox on this platform, but none is available: ' +
          (sandboxStatus.reason ?? 'unknown reason'),
      );
    }
    warnings.push(
      (explicitYolo
        ? '--yolo: all permission checks are bypassed (except hard-deny rules).'
        : 'Permission profile ":danger-full-access" bypasses the sandbox and approvals.') +
        ' File and Shell tools can access any path your user can reach; OS sandbox and network isolation are disabled for this run. ' +
        'Use it only in a disposable, externally sandboxed environment.',
    );
  } else {
    if (sandboxStatus.available) {
      warnings.push(
        'M3.1 enforces the permission profile for file tools and Shell. macOS Seatbelt is active: ' +
          'file writes are limited to the profile roots and network access is ' +
          (Object.keys(policy.sandboxPolicy.network.domains).length > 0 && networkMode(policy.sandboxPolicy.network) !== 'none' ? 'restricted to the managed domain proxy' : networkMode(policy.sandboxPolicy.network) === 'local' ? 'limited to this host (including its interface addresses)' : policy.sandboxPolicy.network.enabled ? 'allowed wholesale' : 'denied') + '.',
      );
      warnings.push(
        'OS sandbox: Seatbelt (sandbox-exec). Interactive approvals are available in TUI/plain mode; ' +
          'non-interactive runs fail closed when an action needs approval.',
      );
      warnings.push(
        'Permission profile "' + policy.profileName + '" with approval policy "' + policy.approvalPolicy +
          '" is enforced for file tools and Shell.',
      );
      warnings.push(...sandboxStatus.warnings);
      if (networkMode(policy.sandboxPolicy.network) === 'local') warnings.push(LOCAL_NETWORK_NOTICE);
      if (networkMode(policy.sandboxPolicy.network) !== 'none' && Object.keys(policy.sandboxPolicy.network.domains).length > 0) {
        warnings.push('Domain-restricted HTTP(S) proxy enabled per execution. Direct connections are blocked; private destinations require an exact IP allow.');
      }
    } else {
      warnings.push(
        'M3.1 enforces the permission profile for file tools, but no OS-level sandbox is available: ' +
          (sandboxStatus.reason ?? 'unknown reason') +
          (sandboxStatus.required
            ? ' Shell commands fail closed on this platform.'
            : ' Shell commands run with your user permissions.'),
      );
      warnings.push(
        'Permission profile "' + policy.profileName + '" with approval policy "' + policy.approvalPolicy +
          '" is enforced for file tools. Interactive approvals are available in TUI/plain mode; ' +
          'non-interactive runs fail closed. Use it only in repositories you trust.',
      );
    }
    if (policy.sandboxPolicy.gitHooksWritable || policy.sandboxPolicy.gitConfigWritable) {
      warnings.push(
        'Git hook/config writes are enabled by permission profile "' + policy.profileName +
          '". Git may execute repository-controlled hooks; use this only in trusted repositories.',
      );
    }
    if (policy.reviewer === 'auto_review') {
      warnings.push('approvals_reviewer = "auto_review" is not implemented yet; approvals fall back to fail-closed.');
    }
  }
  if (loaded.config.mcp.servers.length > 0) {
    warnings.push('MCP servers are configured but MCP tools are not implemented in M1; the servers are ignored.');
  }
  if (loaded.config.tools.allowCustom) {
    warnings.push('Custom tools are not loaded in M1; tools.allow_custom is ignored.');
  }

  const routeName = getSelectedRouteName(loaded);
  const configuredRoute = getSelectedRoute(loaded);
  const savedModel = loaded.overrides.model || loaded.overrides.provider || loaded.overrides.route
    ? undefined : loaded.workspacePreferences?.model;
  const route = savedModel
    ? { ...configuredRoute, targets: [{ provider: savedModel.provider, model: savedModel.model, weight: 1 }] }
    : configuredRoute;
  const pins: RouterPins = {};
  if (savedModel) {
    pins.provider = savedModel.provider;
    pins.model = savedModel.model;
  }
  if (loaded.overrides.provider) pins.provider = loaded.overrides.provider;
  if (loaded.overrides.model) pins.model = loaded.overrides.model;
  const target = selectRouteTarget(routeName, route, pins);

  const providerConfig = loaded.config.providers[target.provider];
  if (!providerConfig) throw new ConfigError('Provider "' + target.provider + '" is not configured.');
  const credential = await resolveApiKey({
    providerId: target.provider,
    provider: providerConfig,
    codingxHome: loaded.codingxHome,
    env,
  });
  const provider = createProvider(target.provider, providerConfig, credential.apiKey);
  const router = new ProviderRouter({
    routeName,
    route,
    providers: { [target.provider]: provider },
    pins,
  });

  const snapshot = await createContextSnapshot({ cwd, env });
  warnings.push(...snapshot.warnings);
  const home = env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : os.homedir();
  const loadedSkills = await loadSkills({
    codingxHome: loaded.codingxHome,
    projectRoot: snapshot.projectRoot,
    agentsSkillsDir: path.join(home, '.agents', 'skills'),
  });
  warnings.push(...loadedSkills.warnings);
  const skills = loadedSkills.registry;
  const systemPrompt = buildSystemPrompt(snapshot, {
    skills: skills.summaries(),
    ...(additionalDirs.length > 0 ? { additionalDirs } : {}),
    permissionProfile: policy.profileName,
    approvalPolicy: policy.approvalPolicy,
    sandbox: sandboxSummary(sandboxStatus, policy.sandboxPolicy),
    ...(yolo ? { yolo: true } : {}),
  });
  const tools = new ToolRegistry(createBuiltinTools());
  const shellEnv = buildChildEnv(loaded.config.sandbox.envPassthrough, env);
  const hooks = new HookRunner(loaded.config.hooks, {
    cwd,
    env: shellEnv,
    maxOutputChars: loaded.config.tools.maxOutputChars,
  });
  if (loaded.config.hooks.length > 0) {
    warnings.push(
      'Agent Harness hooks are configured (' + loaded.config.hooks.length +
        '). They run local commands from the global config; only add hooks you trust.',
    );
  }
  let store: SessionStoreApi;
  if (loaded.config.sessiond.enabled) {
    const ensured = await ensureSessiond({
      socketPath: loaded.config.sessiond.socket,
      sessionDir: loaded.config.session.dir,
      idleTimeoutSeconds: loaded.config.sessiond.idleTimeoutSeconds,
      autostart: loaded.config.sessiond.autostart,
      cliVersion: VERSION,
      env,
      cwd,
    });
    store = new SessiondStore({ client: ensured.client });
    if (ensured.replacedStale === true) {
      warnings.push(
        'sessiond was running an older build; it was restarted to match this codingx binary.',
      );
    }
  } else {
    store = new EmbeddedSessionStore({ directory: loaded.config.session.dir, cwd });
  }

  return {
    loaded,
    config: loaded.config,
    cwd,
    additionalDirs,
    yolo,
    policy,
    sandbox,
    codingxHome: loaded.codingxHome,
    store,
    router,
    tools,
    hooks,
    snapshot,
    skills,
    systemPrompt,
    shellEnv,
    warnings,
    cliVersion: VERSION,
  };
}
