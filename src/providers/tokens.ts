import { estimateJsonTokens, estimateTokens } from '../util/tokens.js';
import type { Message, ToolSchema } from './types.js';

/** Approximate message tokens for budget checks; provider usage is authoritative. */
export function estimateMessagesTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += 8;
    for (const block of message.content) {
      if (block.type === 'image') total += 1600;
      else if (block.type === 'text') total += estimateTokens(block.text);
      else if (block.type === 'tool_use') total += 16 + estimateJsonTokens(block.input) + estimateTokens(block.name);
      else if (block.type === 'tool_result') total += 16 + estimateTokens(block.content);
    }
  }
  return total;
}

export function estimateToolsTokens(tools: readonly ToolSchema[]): number {
  let total = 0;
  for (const tool of tools) {
    total += estimateTokens(tool.name) + estimateTokens(tool.description) + estimateJsonTokens(tool.inputSchema);
  }
  return total;
}
