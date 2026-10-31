import { AgentLoop, type UiEvent } from '../agent/index.js';
import type { ApprovalHandler } from '../policy/types.js';
import { DEFAULT_CONTEXT_WINDOW, type Message, type ReasoningEffort } from '../providers/types.js';
import type { SessionHandle } from '../session/index.js';
import type { AskHandler, PlanStep, ReadFileTracker } from '../tools/index.js';
import type { CliApp } from './bootstrap.js';
import type { StoredModelSelection } from '../agent/history.js';

export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;

/** Explicit CLI/env > cwd preferences > saved session selection > config. */
export async function initializeReasoningEffort(
  app: CliApp,
  session: SessionHandle,
  restored: StoredModelSelection = {},
): Promise<ReasoningEffort | undefined> {
  const explicit = app.loaded.overrides.reasoningEffort !== undefined || app.loaded.workspacePreferences?.model !== undefined;
  if (!explicit && restored.model !== undefined) return restored.reasoningEffort;
  const effort = app.config.model.reasoningEffort;
  if (explicit || effort !== undefined) {
    await session.append({
      type: 'model.changed',
      model: app.router.selection.model,
      provider: app.router.selection.providerId,
      route: app.router.selection.routeName,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    });
  }
  return effort;
}

export interface CreateLoopOptions {
  initialMessages?: readonly Message[];
  initialPlan?: readonly PlanStep[];
  readTracker?: ReadFileTracker;
  /** Resolved session effort; explicit undefined restores the provider default. */
  reasoningEffort?: ReasoningEffort;
  /** Present only when the caller can collect answers mid-turn (TUI). */
  ask?: AskHandler;
  /** Present only when the caller can collect approval decisions mid-turn (TUI). */
  approve?: ApprovalHandler;
}

/** Build an AgentLoop with the resolved app config (shared by exec and interactive). */
export function createLoop(
  app: CliApp,
  session: SessionHandle,
  emit: (event: UiEvent) => void,
  options: CreateLoopOptions = {},
): AgentLoop {
  return new AgentLoop({
    session,
    router: app.router,
    providerOrigin: () => {
      const endpoint = app.config.providers[app.router.selection.providerId]?.endpoint;
      return endpoint ? new URL(endpoint).origin : undefined;
    },
    tools: app.tools,
    systemPrompt: app.systemPrompt,
    model: app.router.selection.model,
    maxSteps: app.config.agent.maxSteps,
    maxParallelTools: app.config.agent.maxParallelTools,
    maxOutputTokens: app.config.model.maxOutputTokens,
    temperature: app.config.model.temperature,
    contextWindow: app.config.model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    sessionId: session.id,
    cwd: app.cwd,
    web: app.config.web,
    maxOutputChars: app.config.tools.maxOutputChars,
    shell: { env: app.shellEnv, timeoutMs: DEFAULT_SHELL_TIMEOUT_MS },
    skills: app.skills,
    ...(app.additionalDirs.length > 0 ? { additionalDirs: app.additionalDirs } : {}),
    ...(app.yolo ? { yolo: true } : {}),
    policy: app.policy,
    sandbox: app.sandbox,
    hooks: app.hooks,
    reasoningEffort: 'reasoningEffort' in options ? options.reasoningEffort : app.config.model.reasoningEffort,
    ...(options.ask === undefined ? {} : { ask: options.ask }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
    ...(options.readTracker ? { readTracker: options.readTracker } : {}),
    ...(options.initialMessages ? { initialMessages: options.initialMessages } : {}),
    ...(options.initialPlan ? { initialPlan: options.initialPlan } : {}),
    emit,
  });
}
