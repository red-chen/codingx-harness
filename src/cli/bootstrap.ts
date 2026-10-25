import path from 'node:path';
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
import { buildChildEnv } from '../exec/index.js';
import { ConfigError } from '../util/errors.js';
import { resolveApiKey } from '../util/auth.js';
import { VERSION } from '../version.js';

export interface BootstrapOptions {
  cwd: string;
  cli?: ConfigOverrides;
  env?: NodeJS.ProcessEnv;
}

export interface CliApp {
  loaded: LoadedConfig;
  config: Config;
  cwd: string;
  codingxHome: string;
  store: SessionStoreApi;
  router: ProviderRouter;
  tools: ToolRegistry;
  snapshot: ContextSnapshot;
  systemPrompt: string;
  shellEnv: Record<string, string>;
  warnings: string[];
  cliVersion: string;
}

/** Assemble the complete M1 runtime for one CLI invocation. */
export async function bootstrap(options: BootstrapOptions): Promise<CliApp> {
  const cwd = path.resolve(options.cwd);
  const env = options.env ?? process.env;
  const loaded = await loadConfig({ cwd, env, cli: options.cli });
  const warnings = [...loaded.warnings];

  warnings.push(
    'M1 has no approval prompts or OS-level sandbox; tool calls run with your user permissions. ' +
      'Use it only in repositories you trust.',
  );
  if (loaded.config.mcp.servers.length > 0) {
    warnings.push('MCP servers are configured but MCP tools are not implemented in M1; the servers are ignored.');
  }
  if (loaded.config.web.enabled) {
    warnings.push('web_fetch is not implemented in M1; [web] settings are ignored.');
  }
  if (loaded.config.tools.allowCustom) {
    warnings.push('Custom tools are not loaded in M1; tools.allow_custom is ignored.');
  }

  const routeName = getSelectedRouteName(loaded);
  const route = getSelectedRoute(loaded);
  const pins: RouterPins = {};
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
  const systemPrompt = buildSystemPrompt(snapshot);
  const tools = new ToolRegistry(createBuiltinTools());
  const shellEnv = buildChildEnv(loaded.config.sandbox.envPassthrough, env);
  let store: SessionStoreApi;
  if (loaded.config.sessiond.enabled) {
    const ensured = await ensureSessiond({
      socketPath: loaded.config.sessiond.socket,
      sessionDir: loaded.config.session.dir,
      idleTimeoutSeconds: loaded.config.sessiond.idleTimeoutSeconds,
      autostart: loaded.config.sessiond.autostart,
      cliVersion: VERSION,
      env,
    });
    store = new SessiondStore({ client: ensured.client });
  } else {
    store = new EmbeddedSessionStore({ directory: loaded.config.session.dir });
  }

  return {
    loaded,
    config: loaded.config,
    cwd,
    codingxHome: loaded.codingxHome,
    store,
    router,
    tools,
    snapshot,
    systemPrompt,
    shellEnv,
    warnings,
    cliVersion: VERSION,
  };
}