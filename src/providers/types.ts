export type Protocol = 'anthropic-messages' | 'openai-responses';

/**
 * Provider-agnostic reasoning effort. The provider adapter maps these values
 * to its wire format (Anthropic Messages: output_config.effort).
 */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export type Role = 'user' | 'assistant';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: Role;
  content: ContentBlock[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** Provider-agnostic tool declaration sent to the model. */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema object for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSchema[];
  maxOutputTokens: number;
  temperature?: number;
  /** Provider-specific reasoning level; absent means the provider default. */
  reasoningEffort?: ReasoningEffort;
  /** Session id, used by providers for cache affinity / metadata. */
  sessionId?: string;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type ModelEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'tool.call'; id: string; name: string; input: unknown }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    }
  | { type: 'stop'; reason: StopReason };

export interface ModelClient {
  stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
  countTokens(messages: Message[]): Promise<number>;
}

export interface Provider extends ModelClient {
  readonly id: string;
  readonly protocol: Protocol;
}

/** Default model context window used when config does not override it. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

export const EMPTY_USAGE: TokenUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

export function addUsage(
  total: TokenUsage,
  event: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  },
): TokenUsage {
  return {
    inputTokens: total.inputTokens + (event.inputTokens ?? 0),
    outputTokens: total.outputTokens + (event.outputTokens ?? 0),
    cacheReadTokens: total.cacheReadTokens + (event.cacheReadTokens ?? 0),
    cacheCreationTokens: total.cacheCreationTokens + (event.cacheCreationTokens ?? 0),
  };
}

export function assistantMessage(text: string, calls: readonly ToolCall[]): Message {
  const content: ContentBlock[] = [];
  if (text.length > 0) content.push({ type: 'text', text });
  for (const call of calls) {
    content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
  }
  return { role: 'assistant', content };
}

export function toolResultsMessage(
  results: ReadonlyArray<{ id: string; content: string; isError?: boolean }>,
): Message {
  return {
    role: 'user',
    content: results.map((result) => ({
      type: 'tool_result',
      tool_use_id: result.id,
      content: result.content,
      ...(result.isError ? { is_error: true } : {}),
    })),
  };
}

export function messageText(message: Message): string {
  return message.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
