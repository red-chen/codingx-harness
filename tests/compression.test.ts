import { describe, expect, it } from 'vitest';
import {
  compactMessages,
  TOOL_OUTPUT_TRUNCATION_MARKER,
} from '../src/agent/compression.js';
import { estimateMessagesTokens } from '../src/providers/tokens.js';
import type { ContentBlock, Message } from '../src/providers/types.js';

function textMessage(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] };
}

function toolUseMessage(id: string, input: unknown = { path: 'src/util.ts' }): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'read_file', input }],
  };
}

function toolResultMessage(entries: ReadonlyArray<{ id: string; content: string }>): Message {
  return {
    role: 'user',
    content: entries.map(
      (entry): ContentBlock => ({
        type: 'tool_result',
        tool_use_id: entry.id,
        content: entry.content,
      }),
    ),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

describe('compactMessages', () => {
  it('is a no-op with a shallow copy when neither trigger fires', () => {
    const messages: Message[] = [
      textMessage('user', 'hello'),
      textMessage('assistant', 'hi there'),
      toolUseMessage('call-1'),
      toolResultMessage([{ id: 'call-1', content: 'small output' }]),
    ];

    const result = compactMessages(messages, { contextWindow: 100_000 });

    expect(result.applied).toEqual([]);
    expect(result.messages).toEqual(messages);
    expect(result.messages).not.toBe(messages);
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.droppedMessages).toBe(0);
    expect(result.truncatedToolResults).toBe(0);
    expect(result.estimatedTokensBefore).toBe(estimateMessagesTokens(messages));
    expect(result.estimatedTokensAfter).toBe(result.estimatedTokensBefore);
  });

  it('truncates oversized tool results with a marker and keeps pairing intact', () => {
    const longRequestText = 'q'.repeat(3_000);
    const longToolInput = { command: 'echo ' + 'i'.repeat(4_000) };
    const hugeOutput = 'A'.repeat(20_000);
    const messages: Message[] = [
      textMessage('user', 'original request ' + longRequestText),
      toolUseMessage('call-1', longToolInput),
      toolResultMessage([{ id: 'call-1', content: hugeOutput }]),
    ];
    const before = estimateMessagesTokens(messages);
    expect(before).toBeGreaterThan(3_200);

    const result = compactMessages(messages, {
      contextWindow: 4_000, // 0.8 * 4000 = 3200 token budget
      toolResultMaxChars: 200,
    });

    expect(result.applied).toEqual(['truncate']);
    expect(result.truncatedToolResults).toBe(1);
    expect(result.droppedMessages).toBe(0);
    expect(result.messages).toHaveLength(messages.length);

    const toolUseBlock = result.messages[1]?.content[0];
    expect(toolUseBlock).toMatchObject({ type: 'tool_use', id: 'call-1', input: longToolInput });

    const toolResultBlock = result.messages[2]?.content[0];
    expect(toolResultBlock).toMatchObject({ type: 'tool_result', tool_use_id: 'call-1' });
    const truncatedContent = toolResultBlock?.type === 'tool_result' ? toolResultBlock.content : '';
    expect(truncatedContent).toHaveLength(200);
    expect(truncatedContent).toContain(TOOL_OUTPUT_TRUNCATION_MARKER.trim());
    expect(truncatedContent.startsWith('A')).toBe(true);
    expect(truncatedContent.endsWith('A')).toBe(true);

    // User/assistant text and tool inputs are never rewritten.
    expect(result.messages[0]).toBe(messages[0]);
    expect(messages[2]?.content[0]).toMatchObject({ type: 'tool_result', content: hugeOutput });
    expect(result.estimatedTokensAfter).toBe(estimateMessagesTokens(result.messages));
    expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore);
  });

  it('triggers on message count and drops the middle', () => {
    const messages: Message[] = [textMessage('user', 'original request')];
    for (let i = 1; i <= 12; i += 1) {
      messages.push(textMessage('assistant', 'answer ' + i));
      messages.push(textMessage('user', 'follow-up ' + i));
    }
    expect(messages).toHaveLength(25);

    const result = compactMessages(messages, {
      contextWindow: 1_000_000, // token budget is never the trigger here
      maxMessages: 10,
      keepRecentMessages: 4,
    });

    expect(result.applied).toEqual(['drop']);
    expect(result.droppedMessages).toBe(20);
    expect(result.messages).toHaveLength(5);
    expect(result.messages.length).toBeLessThanOrEqual(10);
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages.slice(1)).toEqual(messages.slice(21));
    expect(result.estimatedTokensAfter).toBe(estimateMessagesTokens(result.messages));
    expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore);
  });

  it('drops the middle while preserving the first user message and the recent tail', () => {
    const messages: Message[] = [
      textMessage('user', 'original request'),
      textMessage('assistant', 'B'.repeat(20_000)),
      textMessage('user', 'recent question'),
      textMessage('assistant', 'recent answer'),
    ];
    const budget = 2_000 * 0.8;
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(budget);

    const result = compactMessages(messages, { contextWindow: 2_000, keepRecentMessages: 2 });

    expect(result.applied).toEqual(['drop']);
    expect(result.droppedMessages).toBe(1);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1]).toBe(messages[2]);
    expect(result.messages[2]).toBe(messages[3]);
    expect(result.estimatedTokensAfter).toBe(estimateMessagesTokens(result.messages));
    expect(result.estimatedTokensAfter).toBeLessThanOrEqual(budget);
  });

  it('moves the tail start back so a split tool_use/tool_result pair survives together', () => {
    const messages: Message[] = [
      textMessage('user', 'original request'),
      textMessage('assistant', 'first step'),
      toolUseMessage('call-1'),
      toolResultMessage([{ id: 'call-1', content: 'file contents' }]),
      textMessage('assistant', 'finished reading'),
      textMessage('user', 'recent question'),
      textMessage('assistant', 'recent answer'),
    ];

    // 7 messages, keepRecentMessages 4 -> the naive tail starts at index 3,
    // which is the user tool_result message. It must grow back to the tool_use.
    const result = compactMessages(messages, {
      contextWindow: 1_000_000,
      maxMessages: 6,
      keepRecentMessages: 4,
    });

    expect(result.applied).toEqual(['drop']);
    expect(result.droppedMessages).toBe(1);
    expect(result.messages).toHaveLength(6);
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1]).toBe(messages[2]);
    expect(result.messages[1]?.content[0]).toMatchObject({ type: 'tool_use', id: 'call-1' });
    expect(result.messages[2]).toBe(messages[3]);
    expect(result.messages[2]?.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call-1' });
  });

  it('drops a tool_use/tool_result pair together when it falls entirely in the middle', () => {
    const messages: Message[] = [
      textMessage('user', 'original request'),
      toolUseMessage('call-1'),
      toolResultMessage([{ id: 'call-1', content: 'middle output' }]),
      textMessage('assistant', 'after the tool call'),
      textMessage('user', 'recent question'),
      textMessage('assistant', 'recent answer'),
    ];

    // 6 messages, keepRecentMessages 3 -> tail starts at index 3, so the pair
    // at indices 1-2 is dropped as a unit.
    const result = compactMessages(messages, {
      contextWindow: 1_000_000,
      maxMessages: 5,
      keepRecentMessages: 3,
    });

    expect(result.applied).toEqual(['drop']);
    expect(result.droppedMessages).toBe(2);
    expect(result.messages).toHaveLength(4);
    const blockTypes = result.messages.flatMap((message) => message.content.map((block) => block.type));
    expect(blockTypes).not.toContain('tool_use');
    expect(blockTypes).not.toContain('tool_result');
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages.slice(1)).toEqual(messages.slice(3));
  });

  it('re-estimates after truncation and drops as well when still over budget', () => {
    const messages: Message[] = [
      textMessage('user', 'original request'),
      toolUseMessage('call-1'),
      toolResultMessage([{ id: 'call-1', content: 'A'.repeat(20_000) }]),
      textMessage('assistant', 'C'.repeat(20_000)),
      textMessage('user', 'recent question'),
      textMessage('assistant', 'recent answer'),
    ];
    const budget = 2_000 * 0.8;

    const result = compactMessages(messages, {
      contextWindow: 2_000,
      keepRecentMessages: 2,
      toolResultMaxChars: 100,
    });

    expect(result.applied).toEqual(['truncate', 'drop']);
    // Level 1 did truncate one block; level 2 then dropped that message too.
    expect(result.truncatedToolResults).toBe(1);
    expect(result.droppedMessages).toBe(3);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1]).toBe(messages[4]);
    expect(result.messages[2]).toBe(messages[5]);
    expect(result.estimatedTokensAfter).toBe(estimateMessagesTokens(result.messages));
    expect(result.estimatedTokensAfter).toBeLessThanOrEqual(budget);
  });

  it('never mutates the input messages or content blocks', () => {
    const hugeOutput = 'Z'.repeat(20_000);
    const messages: Message[] = [
      textMessage('user', 'original request'),
      toolUseMessage('call-1', { command: 'cat big.log' }),
      toolResultMessage([{ id: 'call-1', content: hugeOutput }]),
      textMessage('assistant', 'Y'.repeat(20_000)),
      textMessage('user', 'recent question'),
      textMessage('assistant', 'recent answer'),
    ];
    const snapshot = structuredClone(messages);
    deepFreeze(messages);

    const result = compactMessages(messages, {
      contextWindow: 1_000,
      keepRecentMessages: 2,
      toolResultMaxChars: 100,
    });

    expect(result.messages).not.toBe(messages);
    expect(result.applied).toEqual(['truncate', 'drop']);
    expect(result.truncatedToolResults).toBe(1);
    expect(result.droppedMessages).toBe(3);
    expect(messages).toEqual(snapshot);
    expect(messages).toHaveLength(6);
    expect(messages[2]?.content[0]).toMatchObject({ type: 'tool_result', content: hugeOutput });
  });
});
