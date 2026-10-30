import type { Config } from '../config/types.js';
import type { AgentLoop, StoredModelSelection } from '../agent/index.js';
import type { SessionHandle } from '../session/index.js';
import { createProvider } from '../providers/index.js';
import { ProviderRouter } from '../routing/index.js';
import { ConfigError } from '../util/errors.js';
import { WorkspacePreferencesStore } from '../config/workspace-preferences.js';
import { resolveApiKey } from '../util/auth.js';
import type { CliApp } from './bootstrap.js';
import type { ModelSelection } from './model-command.js';
import type { ModelSelectionUpdate } from './model-command.js';

export interface ConfiguredModelSelection extends ModelSelection {
  provider: string;
  route: string;
}

/** Each configured provider/model is one manual choice, independent of route strategy. */
export function configuredModels(config: Config): ConfiguredModelSelection[] {
  const choices: ConfiguredModelSelection[] = [];
  for (const [route, settings] of Object.entries(config.routes)) {
    for (const target of settings.targets) {
      if (!choices.some((choice) => choice.provider === target.provider && choice.model === target.model)) {
        choices.push({ model: target.model, provider: target.provider, route });
      }
    }
  }
  return choices;
}

export function currentModelSelection(app: CliApp, reasoningEffort?: ModelSelection['reasoningEffort']): ConfiguredModelSelection {
  return {
    model: app.router.model,
    provider: app.router.providerId,
    route: app.router.selection.routeName,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

export function resolveModelSelection(app: CliApp, requested: ModelSelection): ConfiguredModelSelection {
  let { model, provider, route } = requested;
  const choices = configuredModels(app.config);
  // Prefer an exact configured model ID, which may itself contain a slash.
  if (!provider && !choices.some((choice) => choice.model === model)) {
    const slash = model.indexOf('/');
    const prefix = model.slice(0, slash);
    if (slash > 0 && app.config.providers[prefix]) {
      provider = prefix;
      model = model.slice(slash + 1);
    }
  }
  if (!model.trim() || /\s/u.test(model)) throw new ConfigError('Enter one non-empty model name.');
  const matches = choices.filter((choice) => choice.model === model && (!provider || choice.provider === provider));
  const match = matches.find((choice) => choice.provider === app.router.providerId) ??
    (matches.length === 1 ? matches[0] : undefined);
  if (!provider && matches.length > 1 && !match) {
    throw new ConfigError('Model "' + model + '" has multiple providers. Use /model <provider>/' + model + '.');
  }
  provider ??= match?.provider ?? app.router.providerId;
  route ??= match?.route ?? app.router.selection.routeName;
  if (!app.config.providers[provider]) throw new ConfigError('Provider "' + provider + '" is not configured.');
  if (!app.config.routes[route]) throw new ConfigError('Route "' + route + '" is not configured.');
  return { model, provider, route, ...(requested.reasoningEffort === undefined ? {} : { reasoningEffort: requested.reasoningEffort }) };
}

async function prepareModelSelection(app: CliApp, requested: ModelSelection, env: NodeJS.ProcessEnv) {
  const selection = resolveModelSelection(app, requested);
  const config = app.config.providers[selection.provider]!;
  const credential = await resolveApiKey({
    providerId: selection.provider, provider: config, codingxHome: app.codingxHome, env,
  });
  const provider = createProvider(selection.provider, config, credential.apiKey);
  const router = new ProviderRouter({
    routeName: selection.route,
    // A user choice pins exactly one target. It does not enable automatic routing.
    route: { ...app.config.routes[selection.route]!, targets: [{ provider: selection.provider, model: selection.model, weight: 1 }] },
    providers: { [selection.provider]: provider },
  });
  return { selection, router };
}

export async function changeModelSelection(
  app: CliApp, session: SessionHandle, loop: AgentLoop, requested: ModelSelection, env: NodeJS.ProcessEnv,
): Promise<ConfiguredModelSelection & ModelSelectionUpdate> {
  const { selection, router } = await prepareModelSelection(app, requested, env);
  await session.append({ type: 'model.changed', ...selection });
  app.router = router;
  loop.setRouter(router, selection.model);
  loop.setReasoningEffort(selection.reasoningEffort);
  try {
    const store = await WorkspacePreferencesStore.open(app.codingxHome, app.cwd);
    await store.saveModel({ ...selection, reasoningEffort: selection.reasoningEffort ?? 'default' });
  } catch {
    return { ...selection, persistenceWarning: 'Model changed for this session, but cwd preferences could not be saved.' };
  }
  return selection;
}

export async function restoreModelSelection(app: CliApp, stored: StoredModelSelection, env: NodeJS.ProcessEnv): Promise<void> {
  if (!stored.model) return;
  if (app.loaded.workspacePreferences?.model) return;
  const overrides = app.loaded.overrides;
  if (overrides.model || overrides.provider || overrides.route) return;
  const { router } = await prepareModelSelection(app, { ...stored, model: stored.model }, env);
  app.router = router;
}
