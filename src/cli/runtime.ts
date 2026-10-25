import { AgentLoop, type UiEvent } from '../agent/index.js';
import type { Message } from '../providers/types.js';
import type { SessionHandle } from '../session/index.js';
import type { PlanStep, ReadFileTracker } from '../tools/index.js';
import type { CliApp } from './bootstrap.js';

export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;

export interface CreateLoopOptions {
  initialMessages?: readonly Message[];
  initialPlan?: readonly PlanStep[];
  readTracker?: ReadFileTracker;
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
    tools: app.tools,
    systemPrompt: app.systemPrompt,
    model: app.router.selection.model,
    maxSteps: app.config.agent.maxSteps,
    maxOutputTokens: app.config.model.maxOutputTokens,
    temperature: app.config.model.temperature,
    contextWindow: app.config.model.contextWindow ?? 1_000_000,
    sessionId: session.id,
    cwd: app.cwd,
    maxOutputChars: app.config.tools.maxOutputChars,
    shell: { env: app.shellEnv, timeoutMs: DEFAULT_SHELL_TIMEOUT_MS },
    ...(options.readTracker ? { readTracker: options.readTracker } : {}),
    ...(options.initialMessages ? { initialMessages: options.initialMessages } : {}),
    ...(options.initialPlan ? { initialPlan: options.initialPlan } : {}),
    emit,
  });
}