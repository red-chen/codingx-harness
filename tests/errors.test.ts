import { describe, expect, it } from 'vitest';
import {
  abortError,
  CodingxError,
  ConfigError,
  describeError,
  ProviderError,
  StepLimitError,
} from '../src/util/errors.js';
import {
  addUsage,
  assistantMessage,
  EMPTY_USAGE,
  messageText,
  toolResultsMessage,
} from '../src/providers/types.js';

describe('errors', () => {
  it('maps public error codes to documented exit codes', () => {
    expect(new ConfigError('bad config').exitCode).toBe(2);
    expect(new ProviderError('boom', { category: 'server', status: 500 }).exitCode).toBe(1);
    expect(abortError().exitCode).toBe(130);
    expect(new StepLimitError(3).maxSteps).toBe(3);
    expect(describeError(new ConfigError('bad config'))).toMatchObject({ code: 'CONFIG_ERROR', exitCode: 2 });
  });

  it('treats network/timeout/rate-limit/server provider errors as retryable', () => {
    expect(new ProviderError('x', { category: 'network' }).retryable).toBe(true);
    expect(new ProviderError('x', { category: 'rate_limit' }).retryable).toBe(true);
    expect(new ProviderError('x', { category: 'auth' }).retryable).toBe(false);
    expect(new ProviderError('x', { category: 'bad_request' }).retryable).toBe(false);
  });

  it('preserves cause and details', () => {
    const err = new CodingxError('INTERNAL', 'wrapped', { cause: new Error('root'), details: { a: 1 } });
    expect((err.cause as Error).message).toBe('root');
    expect(err.details).toEqual({ a: 1 });
  });
});

describe('provider message helpers', () => {
  it('builds assistant messages with text and tool calls', () => {
    const msg = assistantMessage('hello', [{ id: 't1', name: 'read_file', input: { path: 'a.ts' } }]);
    expect(msg.role).toBe('assistant');
    expect(msg.content).toHaveLength(2);
    expect(msg.content[1]).toMatchObject({ type: 'tool_use', name: 'read_file' });
    expect(messageText(msg)).toBe('hello');
  });

  it('builds a tool_result user message and marks errors', () => {
    const msg = toolResultsMessage([{ id: 't1', content: 'nope', isError: true }]);
    expect(msg).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'nope', is_error: true }],
    });
  });

  it('accumulates usage', () => {
    const usage = addUsage(EMPTY_USAGE, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 });
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 0 });
    expect(EMPTY_USAGE.inputTokens).toBe(0);
  });
});
