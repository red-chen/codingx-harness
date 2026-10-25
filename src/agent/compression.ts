import { estimateMessagesTokens } from '../providers/tokens.js';
import type { ContentBlock, Message } from '../providers/types.js';
import { truncateMiddle } from '../util/tokens.js';

/**
 * Deterministic context compression.
 *
 * This module implements only levels 1 and 2 from docs/agent-loop.md:
 *
 * 1. "truncate": replace oversized tool_result bodies with a head/tail view.
 * 2. "drop": keep the original user request plus a recent suffix and discard
 *    the middle of the conversation.
 *
 * Level 3 (a model-generated structured summary) is intentionally NOT part of
 * this module. It needs a provider round-trip, usage accounting and a failure
 * fallback, so it belongs to the AgentLoop integration instead of a pure,
 * deterministic message transform.
 */

export interface CompressionOptions {
  /** Model context window in tokens. */
  contextWindow: number;
  /** Compress once the estimate exceeds contextWindow * thresholdRatio. Defaults to 0.8. */
  thresholdRatio?: number;
  /** Compress once the history holds more than this many messages. Defaults to 200. */
  maxMessages?: number;
  /** Number of trailing messages preserved by the drop level. Defaults to 20. */
  keepRecentMessages?: number;
  /** tool_result bodies longer than this are head/tail truncated. Defaults to 4000. */
  toolResultMaxChars?: number;
}

export interface CompressionResult {
  messages: Message[];
  /** Levels that actually changed the history, in application order. */
  applied: Array<'truncate' | 'drop'>;
  /** Actual messages removed by level 2, in their original order. */
  dropped: Message[];
  droppedMessages: number;
  /** Number of tool_result blocks truncated by level 1 (even if drop removed them later). */
  truncatedToolResults: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

/** Visible marker inserted where a tool_result body was elided. */
export const TOOL_OUTPUT_TRUNCATION_MARKER = '\n[... tool output truncated ...]\n';

const DEFAULT_THRESHOLD_RATIO = 0.8;
const DEFAULT_MAX_MESSAGES = 200;
const DEFAULT_KEEP_RECENT_MESSAGES = 20;
const DEFAULT_TOOL_RESULT_MAX_CHARS = 4000;

interface ResolvedOptions {
  tokenLimit: number;
  maxMessages: number;
  keepRecentMessages: number;
  toolResultMaxChars: number;
}

function resolveOptions(options: CompressionOptions): ResolvedOptions {
  return {
    tokenLimit: options.contextWindow * (options.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO),
    maxMessages: options.maxMessages ?? DEFAULT_MAX_MESSAGES,
    keepRecentMessages: options.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES,
    toolResultMaxChars: options.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS,
  };
}

function isOverTrigger(messageCount: number, estimatedTokens: number, options: ResolvedOptions): boolean {
  return estimatedTokens > options.tokenLimit || messageCount > options.maxMessages;
}

interface TruncateResult {
  messages: Message[];
  truncated: number;
}

/**
 * Level 1: shorten oversized tool_result blocks only. Message count, block
 * order and tool_use/tool_result pairing stay untouched; text blocks and tool
 * inputs are never modified. Unchanged messages keep their identity.
 */
function truncateOversizedToolResults(messages: readonly Message[], maxChars: number): TruncateResult {
  let truncated = 0;
  const next = messages.map((message) => {
    let changed = false;
    const content: ContentBlock[] = message.content.map((block) => {
      if (block.type !== 'tool_result' || block.content.length <= maxChars) return block;
      truncated += 1;
      changed = true;
      return {
        ...block,
        content: truncateMiddle(block.content, maxChars, TOOL_OUTPUT_TRUNCATION_MARKER),
      };
    });
    return changed ? { ...message, content } : message;
  });
  return { messages: next, truncated };
}

interface DropResult {
  messages: Message[];
  dropped: Message[];
  droppedMessages: number;
}

function isToolResultUserMessage(message: Message | undefined): boolean {
  return (
    message !== undefined &&
    message.role === 'user' &&
    message.content.some((block) => block.type === 'tool_result')
  );
}

/**
 * A kept suffix must not start with a tool_result whose tool_use was dropped.
 * Walk the cut backwards until the assistant message carrying the call is part
 * of the suffix again, so the pair always survives or is dropped together.
 */
function alignTailStart(messages: readonly Message[], tailStart: number, minTailStart: number): number {
  let start = tailStart;
  while (start > minTailStart && isToolResultUserMessage(messages[start])) {
    start -= 1;
  }
  return start;
}

/**
 * Level 2: keep the first user message (the original request) and the newest
 * keepRecentMessages messages, dropping everything between them. If the recent
 * suffix would begin with an orphan tool_result, the suffix grows backwards by
 * the assistant tool_use message so the pair is never split. When even the
 * remaining history is over budget this is the best effort: the first message
 * and the recent tail are preserved anyway.
 */
function dropMiddle(messages: readonly Message[], keepRecentMessages: number): DropResult {
  const firstUserIndex = messages.findIndex((message) => message.role === 'user');
  const prefixEnd = firstUserIndex >= 0 ? firstUserIndex + 1 : 0;
  const keep = Math.max(0, keepRecentMessages);
  const requestedTailStart = Math.max(prefixEnd, messages.length - keep);
  const tailStart = alignTailStart(messages, requestedTailStart, prefixEnd);
  const next = [...messages.slice(0, prefixEnd), ...messages.slice(tailStart)];
  const dropped = messages.slice(prefixEnd, tailStart);
  return { messages: next, dropped, droppedMessages: dropped.length };
}

/**
 * Compact a message history deterministically.
 *
 * The function is pure: input messages and content blocks are never mutated.
 * When neither trigger fires the history is returned as a shallow copy with no
 * changes recorded. Level 3 summarisation is out of scope here (see the file
 * header).
 */
export function compactMessages(messages: readonly Message[], options: CompressionOptions): CompressionResult {
  const resolved = resolveOptions(options);
  const estimatedTokensBefore = estimateMessagesTokens(messages);

  if (!isOverTrigger(messages.length, estimatedTokensBefore, resolved)) {
    return {
      messages: [...messages],
      applied: [],
      dropped: [],
      droppedMessages: 0,
      truncatedToolResults: 0,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
    };
  }

  const applied: Array<'truncate' | 'drop'> = [];
  let working: Message[] = [...messages];

  const truncated = truncateOversizedToolResults(working, resolved.toolResultMaxChars);
  working = truncated.messages;
  if (truncated.truncated > 0) applied.push('truncate');

  let estimatedTokensAfter = truncated.truncated > 0 ? estimateMessagesTokens(working) : estimatedTokensBefore;
  let droppedMessages = 0;
  let dropped: Message[] = [];

  if (isOverTrigger(working.length, estimatedTokensAfter, resolved)) {
    const dropResult = dropMiddle(working, resolved.keepRecentMessages);
    working = dropResult.messages;
    dropped = dropResult.dropped;
    droppedMessages = dropResult.droppedMessages;
    if (droppedMessages > 0) applied.push('drop');
    estimatedTokensAfter = estimateMessagesTokens(working);
  }

  return {
    messages: working,
    applied,
    dropped,
    droppedMessages,
    truncatedToolResults: truncated.truncated,
    estimatedTokensBefore,
    estimatedTokensAfter,
  };
}
