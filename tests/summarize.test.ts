import { describe, expect, it } from 'vitest';
import type { Message, ModelEvent, ModelRequest } from '../src/providers/types.js';
import type { ModelClient } from '../src/providers/types.js';
import {
  SUMMARY_SYSTEM_PROMPT,
  serializeMessagesForSummary,
  summarizeDroppedMessages,
} from '../src/agent/index.js';
import { abortError, ProviderError } from '../src/util/errors.js';

class FakeRouter implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private readonly script: Array<{ events: ModelEvent[]; error?: Error }>;

  constructor(script: Array<{ events: ModelEvent[]; error?: Error }>) {
    this.script = script;
  }

  async countTokens(): Promise<number> {
    return 0;
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(req);
    const step = this.script[this.requests.length - 1];
    if (!step) return;
    for (const event of step.events) yield event;
    if (step.error) throw step.error;
  }
}

const dropped: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'inspect the repo' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'reading files' },
      { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'src/a.ts' } },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'line 1\nline 2', is_error: false }],
  },
];

const summaryText = '## Completed\n- inspected src/a.ts\n\n## Key files\n- src/a.ts\n\n## Open questions\n- none';

function summaryEvents(text = summaryText): { events: ModelEvent[] } {
  return {
    events: [
      { type: 'text.delta', text },
      { type: 'usage', inputTokens: 100, outputTokens: 20 },
      { type: 'stop', reason: 'end_turn' },
    ],
  };
}

describe('serializeMessagesForSummary', () => {
  it('labels roles and block kinds, including tool calls/results', () => {
    const transcript = serializeMessagesForSummary(dropped, 10_000);
    expect(transcript).toContain('## user');
    expect(transcript).toContain('inspect the repo');
    expect(transcript).toContain('## assistant');
    expect(transcript).toContain('tool_use read_file');
    expect(transcript).toContain('src/a.ts');
    expect(transcript).toContain('tool_result');
    expect(transcript).toContain('line 1');
  });

  it('bounds the transcript with an explicit marker', () => {
    const transcript = serializeMessagesForSummary(dropped, 80);
    expect(transcript.length).toBe(80);
    expect(transcript).toContain('conversation excerpt truncated');
  });
});

describe('summarizeDroppedMessages', () => {
  it('requests a tool-less structured summary and returns its usage', async () => {
    const router = new FakeRouter([summaryEvents()]);
    const outcome = await summarizeDroppedMessages({
      router,
      messages: dropped,
      model: 'model-a',
      sessionId: 's1',
      maxOutputTokens: 500,
    });

    expect(outcome.summary).toContain('## Completed');
    expect(outcome.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(outcome.error).toBeUndefined();
    expect(router.requests).toHaveLength(1);
    const request = router.requests[0];
    if (!request) throw new Error('missing summary request');
    expect(request).toMatchObject({
      model: 'model-a',
      system: SUMMARY_SYSTEM_PROMPT,
      maxOutputTokens: 500,
      temperature: 0,
      sessionId: 's1',
      tools: [],
    });
    expect(request.messages).toHaveLength(1);
    expect(String(request.messages[0]?.content[0]?.type)).toBe('text');
  });

  it('falls back on provider failures without throwing', async () => {
    const router = new FakeRouter([
      { events: [], error: new ProviderError('upstream failed', { category: 'server', status: 500 }) },
    ]);
    const outcome = await summarizeDroppedMessages({
      router,
      messages: dropped,
      model: 'model-a',
      sessionId: 's1',
    });
    expect(outcome.summary).toBeUndefined();
    expect(outcome.error).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(outcome.usage.inputTokens).toBe(0);
  });

  it('handles empty and refused summary responses', async () => {
    const empty = await summarizeDroppedMessages({
      router: new FakeRouter([{ events: [{ type: 'usage', inputTokens: 3, outputTokens: 0 }, { type: 'stop', reason: 'end_turn' }] }]),
      messages: dropped,
      model: 'model-a',
      sessionId: 's1',
    });
    expect(empty.error?.code).toBe('SUMMARY_EMPTY');

    const refused = await summarizeDroppedMessages({
      router: new FakeRouter([{ events: [{ type: 'stop', reason: 'refusal' }] }]),
      messages: dropped,
      model: 'model-a',
      sessionId: 's1',
    });
    expect(refused.error?.code).toBe('SUMMARY_REFUSED');
  });

  it('propagates aborts and skips empty input', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      summarizeDroppedMessages({
        router: new FakeRouter([summaryEvents()]),
        messages: dropped,
        model: 'model-a',
        sessionId: 's1',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });

    const empty = await summarizeDroppedMessages({
      router: new FakeRouter([]),
      messages: [],
      model: 'model-a',
      sessionId: 's1',
    });
    expect(empty.summary).toBeUndefined();
    expect(empty.usage.inputTokens).toBe(0);
  });

  it('propagates an abort thrown by the provider', async () => {
    const router = new FakeRouter([{ events: [], error: abortError() }]);
    await expect(
      summarizeDroppedMessages({ router, messages: dropped, model: 'model-a', sessionId: 's1' }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
