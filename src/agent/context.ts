import type { Message, ModelRequest, ReasoningEffort, ToolSchema } from '../providers/types.js';
import { estimateMessagesTokens, estimateToolsTokens } from '../providers/tokens.js';
import { estimateTokens } from '../util/tokens.js';

/**
 * Merge consecutive user messages before sending. This happens when a resumed
 * rollout ends with a tool_result user message and the next turn adds a new
 * user prompt; mutating the saved history is avoided.
 */
export function mergeConsecutiveUserMessages(messages: readonly Message[]): Message[] {
  const merged: Message[] = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (message.role === 'user' && last?.role === 'user') {
      merged[merged.length - 1] = { role: 'user', content: [...last.content, ...message.content] };
    } else {
      merged.push({ role: message.role, content: [...message.content] });
    }
  }
  return merged;
}

export interface BuildRequestOptions {
  model: string;
  system: string;
  messages: readonly Message[];
  tools: readonly ToolSchema[];
  maxOutputTokens: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  sessionId?: string;
}

/** Assemble the provider request from the session snapshot and current history. */
export function buildModelRequest(options: BuildRequestOptions): ModelRequest {
  return {
    model: options.model,
    system: options.system,
    messages: mergeConsecutiveUserMessages(options.messages),
    tools: [...options.tools],
    maxOutputTokens: options.maxOutputTokens,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  };
}

export function estimateRequestTokens(request: ModelRequest): number {
  return estimateTokens(request.system) + estimateMessagesTokens(request.messages) + estimateToolsTokens(request.tools);
}
