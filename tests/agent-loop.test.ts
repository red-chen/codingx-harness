import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  AgentLoop,
  TurnState,
  type AgentLoopOptions,
  type AgentModelClient,
  type UiEvent,
} from '../src/agent/index.js';
import type { PolicyRuntime } from '../src/policy/types.js';
import type { Message, ModelEvent, ModelRequest, StopReason } from '../src/providers/types.js';
import type { AppendEventInput, RolloutEvent, SessionHandle } from '../src/session/types.js';
import type { RouterSelection } from '../src/routing/router.js';
import {
  ToolRegistry,
  ReadFileTracker,
  askUserQuestionTool,
  updatePlanTool,
  type AskQuestion,
  type ToolDef,
} from '../src/tools/index.js';
import { abortError, ProviderError } from '../src/util/errors.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'codingx-loop-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

class RecordingSession implements SessionHandle {
  readonly id = 'a1b2c3d4e5f6';
  readonly filePath = '/tmp/fake-rollout.jsonl';
  readonly meta = {
    id: this.id,
    cwd: '/tmp/fake',
    model: 'model-a',
    createdAt: new Date().toISOString(),
    cliVersion: '0.1.0',
  };
  readonly writable = true;
  readonly events: RolloutEvent[] = [];
  private seq = 0;

  async append(input: AppendEventInput | AppendEventInput[]): Promise<RolloutEvent[]> {
    const list = Array.isArray(input) ? input : [input];
    return list.map((item) => {
      this.seq += 1;
      const event = {
        seq: this.seq,
        ts: new Date().toISOString(),
        eventId: 'event-' + this.seq,
        ...item,
      } as RolloutEvent;
      this.events.push(event);
      return event;
    });
  }

  async clear(): Promise<void> {
    this.events.length = 0;
    this.seq = 0;
  }

  async replay(): Promise<RolloutEvent[]> {
    return [...this.events];
  }

  async end(): Promise<RolloutEvent> {
    const [event] = await this.append({ type: 'session.end' });
    if (!event) throw new Error('no end event');
    return event;
  }

  async close(): Promise<void> {
    // no-op
  }
}

interface ClientStep {
  events: ModelEvent[];
  error?: Error;
}

class ScriptedClient implements AgentModelClient {
  readonly selection?: RouterSelection;
  attempts = 0;
  readonly requests: ModelRequest[] = [];
  private readonly steps: ClientStep[];

  constructor(steps: ClientStep[], selection?: RouterSelection) {
    this.steps = steps;
    this.selection = selection;
  }

  async countTokens(): Promise<number> {
    return 0;
  }

  async *stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    this.attempts += 1;
    this.requests.push(req);
    const step = this.steps[Math.min(this.attempts - 1, this.steps.length - 1)];
    if (!step) return;
    for (const event of step.events) {
      if (signal?.aborted) throw abortError();
      yield event;
    }
    if (step.error) throw step.error;
  }
}

interface ToolInput {
  text?: string;
}

const toolSchema = z.object({ text: z.string().optional() });

function createTools(log: string[] = []): ToolRegistry {
  const echo: ToolDef<typeof toolSchema> = {
    name: 'echo',
    description: 'echo text',
    schema: toolSchema,
    parallelSafe: true,
    approval: 'none',
    async execute(input: ToolInput) {
      log.push(input.text ?? '');
      return { content: 'echo:' + (input.text ?? ''), meta: { echo: true } };
    },
  };
  const fail: ToolDef<typeof toolSchema> = {
    name: 'fail',
    description: 'fail with an is_error result',
    schema: toolSchema,
    parallelSafe: false,
    approval: 'none',
    async execute() {
      return { content: 'business failure', isError: true };
    },
  };
  const boom: ToolDef<typeof toolSchema> = {
    name: 'boom',
    description: 'throw',
    schema: toolSchema,
    parallelSafe: false,
    approval: 'none',
    async execute() {
      throw new Error('boom');
    },
  };
  const abort: ToolDef<typeof toolSchema> = {
    name: 'abort_now',
    description: 'abort',
    schema: toolSchema,
    parallelSafe: false,
    approval: 'none',
    async execute() {
      throw abortError();
    },
  };
  const large: ToolDef<typeof toolSchema> = {
    name: 'large',
    description: 'return a large tool result',
    schema: toolSchema,
    parallelSafe: true,
    approval: 'none',
    async execute() {
      return { content: 'x'.repeat(20_000) };
    },
  };
  return new ToolRegistry([echo, fail, boom, abort, large, updatePlanTool]);
}

function createLoop(
  client: AgentModelClient,
  session: SessionHandle,
  ui: UiEvent[],
  overrides: Partial<AgentLoopOptions> = {},
): AgentLoop {
  return new AgentLoop({
    session,
    router: client,
    tools: createTools(),
    systemPrompt: 'You are a test agent.',
    model: 'model-a',
    maxSteps: 4,
    maxOutputTokens: 512,
    temperature: 0,
    sessionId: session.id,
    cwd,
    maxOutputChars: 30_000,
    shell: { env: {}, timeoutMs: 1_000 },
    emit: (event) => ui.push(event),
    ...overrides,
  });
}

function eventsOf(session: RecordingSession, type: string): RolloutEvent[] {
  return session.events.filter((event) => event.type === type);
}

const textStep = (text: string, input = 10, output = 2): ClientStep => ({
  events: [
    { type: 'text.delta', text },
    { type: 'usage', inputTokens: input, outputTokens: output },
    { type: 'stop', reason: 'end_turn' },
  ],
});

const toolStep = (calls: Array<{ id: string; name: string; input: unknown }>): ClientStep => ({
  events: [
    ...calls.map((call) => ({ type: 'tool.call' as const, ...call })),
    { type: 'usage', inputTokens: 5, outputTokens: 1 },
    { type: 'stop', reason: 'tool_use' },
  ],
});

const selection: RouterSelection = {
  routeName: 'default',
  providerId: 'primary',
  model: 'model-a',
  strategy: 'failover',
  affinity: 'session',
  target: { provider: 'primary', model: 'model-a', weight: 1 },
};

describe('TurnState', () => {
  it('validates transitions and aggregates usage', () => {
    const state = new TurnState('turn-1');
    expect(state.phase).toBe('assembling');
    state.transition('streaming');
    state.transition('executing');
    state.transition('assembling');
    state.transition('streaming');
    state.transition('done');
    expect(state.isTerminal).toBe(true);
    expect(() => state.transition('streaming')).toThrow(/Invalid turn transition/);
    state.addUsage({ inputTokens: 3, outputTokens: 2 });
    state.addUsage({ inputTokens: 1, cacheReadTokens: 4 });
    expect(state.usage).toEqual({ inputTokens: 4, outputTokens: 2, cacheReadTokens: 4, cacheCreationTokens: 0 });
    state.incrementStep();
    expect(state.steps).toBe(1);
  });

  it('rejects impossible transitions from the start', () => {
    const state = new TurnState('turn-2');
    expect(() => state.transition('executing')).toThrow(/Invalid turn transition/);
  });
});

describe('AgentLoop approvals', () => {
  it('marks awaiting_approval, correlates the request, and records the decision', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const requests: Array<{ tool: string; turnId?: string; callId?: string }> = [];
    const policy: PolicyRuntime = {
      profileName: ':workspace',
      approvalPolicy: 'on-request',
      reviewer: 'user',
      yolo: false,
      cwd,
      additionalDirs: [],
      readRoots: [],
      writeRoots: [],
      rootsFor: () => [],
      isPathDenied: () => false,
      evaluate: async () => ({
        verdict: 'ask',
        code: 'APPROVAL_REQUIRED',
        reason: 'needs approval',
        action: { kind: 'tool', tool: 'echo' },
        risk: 'low',
      }),
    };
    const client = new ScriptedClient([
      toolStep([{ id: 'call-1', name: 'echo', input: { text: 'hi' } }]),
      textStep('done'),
    ]);
    const loop = createLoop(client, session, ui, {
      policy,
      approve: async (request) => {
        requests.push({ tool: request.tool, ...(request.turnId ? { turnId: request.turnId } : {}), ...(request.callId ? { callId: request.callId } : {}) });
        return { decision: 'allow', scope: 'once' };
      },
    });

    const result = await loop.runTurn('run the tool');
    expect(result.status).toBe('done');
    expect(requests).toEqual([{ tool: 'echo', turnId: expect.any(String), callId: 'call-1' }]);

    const statuses = session.events
      .filter((event) => event.type === 'turn.status')
      .map((event) => event.status);
    expect(statuses).toContain('awaiting_approval');
    expect(statuses).toContain('executing');
    expect(statuses.lastIndexOf('executing')).toBeGreaterThan(statuses.indexOf('awaiting_approval'));

    const toolResult = session.events.find((event) => event.type === 'tool.result');
    expect(toolResult?.meta).toMatchObject({ policy: { verdict: 'allow', profile: ':workspace' } });
  });
});

describe('AgentLoop happy path', () => {
  it('streams text, records rollout events and finishes the turn', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const client = new ScriptedClient([
      {
        events: [
          { type: 'text.delta', text: 'Hello' },
          { type: 'text.delta', text: ' world' },
          { type: 'usage', inputTokens: 10, outputTokens: 2 },
          { type: 'stop', reason: 'end_turn' },
        ],
      },
    ]);
    const loop = createLoop(client, session, ui);
    const result = await loop.runTurn('say hi');

    expect(result).toMatchObject({
      status: 'done',
      usage: { inputTokens: 10, outputTokens: 2 },
      steps: 1,
    });
    expect(result.turnId).toMatch(/^turn_[0-9a-f]{16}$/);
    expect(loop.history).toHaveLength(2);
    expect(loop.history[0]).toMatchObject({ role: 'user' });
    expect(loop.history[1]).toMatchObject({ role: 'assistant' });

    expect(session.events.map((event) => event.type)).toEqual([
      'turn.start',
      'user.message',
      'turn.status',
      'assistant.message',
      'turn.end',
    ]);
    expect(eventsOf(session, 'assistant.message')[0]).toMatchObject({
      text: 'Hello world',
      calls: [],
      stopReason: 'end_turn',
    });
    expect(eventsOf(session, 'turn.end')[0]).toMatchObject({
      status: 'done',
      usage: { inputTokens: 10, outputTokens: 2 },
      steps: 1,
    });

    expect(ui.map((event) => event.type)).toEqual([
      'turn.started',
      'context.updated',
      'text.delta',
      'text.delta',
      'llm.finished',
      'usage.updated',
      'turn.finished',
    ]);
    const finished = ui.at(-1);
    expect(finished).toMatchObject({ type: 'turn.finished', status: 'done' });
  });

  it('defaults to the 1M context window', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const client = new ScriptedClient([textStep('ok')]);
    const loop = createLoop(client, session, ui);
    expect((await loop.runTurn('hello')).status).toBe('done');
    const context = ui.find((event) => event.type === 'context.updated');
    expect(context).toMatchObject({ windowTokens: 1_000_000 });
  });

  it('records provider selection when the router exposes it', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const client = new ScriptedClient([textStep('ok')], selection);
    const loop = createLoop(client, session, ui);
    await loop.runTurn('hi');
    const selected = eventsOf(session, 'provider.selected');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      route: 'default',
      provider: 'primary',
      model: 'model-a',
      strategy: 'failover',
      affinity: 'session',
    });
  });
});

describe('AgentLoop tool execution', () => {
  it('executes multiple tool calls serially and continues to a final answer', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const log: string[] = [];
    const client = new ScriptedClient([
      toolStep([
        { id: 'call-1', name: 'echo', input: { text: 'one' } },
        { id: 'call-2', name: 'echo', input: { text: 'two' } },
      ]),
      textStep('finished', 2, 1),
    ]);
    const loop = createLoop(client, session, ui, { tools: createTools(log) });
    const result = await loop.runTurn('run both');

    expect(result.status).toBe('done');
    expect(result.steps).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(log).toEqual(['one', 'two']);
    expect(loop.history).toHaveLength(4);
    expect(loop.history[2]).toMatchObject({ role: 'user' });
    expect(eventsOf(session, 'tool.call')).toHaveLength(2);
    expect(eventsOf(session, 'tool.result')).toHaveLength(2);
    expect(eventsOf(session, 'tool.result').map((event) => event.content)).toEqual(['echo:one', 'echo:two']);
    expect(ui.filter((event) => event.type === 'tool.started')).toHaveLength(2);
    expect(ui.filter((event) => event.type === 'tool.finished')).toHaveLength(2);
    expect(client.requests[1]?.messages).toHaveLength(3);
  });

  it('feeds tool is_error results back to the model', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const client = new ScriptedClient([
      toolStep([{ id: 'call-1', name: 'fail', input: {} }]),
      textStep('recovered'),
    ]);
    const loop = createLoop(client, session, ui);
    const result = await loop.runTurn('fail once');

    expect(result.status).toBe('done');
    expect(eventsOf(session, 'tool.result')[0]).toMatchObject({ isError: true, content: 'business failure' });
    const toolResultMessage = client.requests[1]?.messages[2];
    expect(toolResultMessage).toMatchObject({ role: 'user' });
    expect(toolResultMessage?.content[0]).toMatchObject({ type: 'tool_result', is_error: true });
  });

  it('converts unknown tools and thrown errors into is_error tool results', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const client = new ScriptedClient([
      toolStep([
        { id: 'call-1', name: 'does_not_exist', input: {} },
        { id: 'call-2', name: 'boom', input: {} },
      ]),
      textStep('ok'),
    ]);
    const loop = createLoop(client, session, ui);
    const result = await loop.runTurn('bad tools');

    expect(result.status).toBe('done');
    const results = eventsOf(session, 'tool.result');
    expect(results).toHaveLength(2);
    expect(String(results[0]?.content)).toMatch(/Unknown tool/);
    expect(results[0]?.isError).toBe(true);
    expect(String(results[1]?.content)).toMatch(/boom/);
    expect(results[1]?.isError).toBe(true);
  });

  it('compacts oversized tool results before the next request and records context.compacted', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const client = new ScriptedClient([
      toolStep([{ id: 'call-1', name: 'large', input: {} }]),
      textStep('compressed'),
    ]);
    const loop = createLoop(client, session, ui, {
      contextWindow: 20_000,
      compression: { thresholdRatio: 0.05, toolResultMaxChars: 200 },
    });
    const result = await loop.runTurn('compress this');

    expect(result.status).toBe('done');
    const compacted = eventsOf(session, 'context.compacted');
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({
      levels: ['truncate'],
      truncatedToolResults: 1,
      droppedMessages: 0,
    });
    const secondMessages = client.requests[1]?.messages ?? [];
    const toolResult = secondMessages
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool_result');
    expect(toolResult).toBeDefined();
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.content).toContain('tool output truncated');
      expect(toolResult.content.length).toBeLessThan(1_000);
    }
  });

  it('survives 30 turns with large tool results by compacting requests', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const steps: ClientStep[] = [];
    for (let turn = 0; turn < 30; turn += 1) {
      steps.push(toolStep([{ id: 'call-' + turn, name: 'large', input: {} }]));
      steps.push(textStep('turn ' + turn + ' done'));
    }
    const client = new ScriptedClient(steps);
    const loop = createLoop(client, session, ui, {
      contextWindow: 10_000,
      compression: {
        thresholdRatio: 0.05,
        toolResultMaxChars: 200,
        keepRecentMessages: 10,
        summaryEnabled: false,
      },
    });

    for (let turn = 0; turn < 30; turn += 1) {
      const result = await loop.runTurn('turn ' + turn);
      expect(result.status).toBe('done');
    }

    expect(loop.history.length).toBe(120);
    expect(eventsOf(session, 'turn.end')).toHaveLength(30);
    expect(eventsOf(session, 'context.compacted').length).toBeGreaterThan(0);
    const lastRequest = client.requests.at(-1);
    expect(lastRequest?.messages.length ?? 999).toBeLessThanOrEqual(30);
  });

  it('forces one compaction and retries when the provider rejects the prompt size', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const initialMessages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', content: [{ type: 'text', text: 'three' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'four' }] },
      { role: 'user', content: [{ type: 'text', text: 'five' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'six' }] },
    ];
    const overflow = new ProviderError('prompt is too long', {
      category: 'context_overflow',
      retryable: false,
    });
    const summary = '## Completed\n- old work';
    const client = new ScriptedClient([
      { events: [], error: overflow },
      textStep(summary),
      textStep('recovered'),
    ]);
    const loop = createLoop(client, session, ui, {
      initialMessages,
      contextWindow: 1_000,
      compression: { keepRecentMessages: 1, summaryMaxTokens: 100 },
    });

    const result = await loop.runTurn('new request');
    expect(result.status).toBe('done');
    expect(client.attempts).toBe(3);
    expect(client.requests[1]?.system).toMatch(/You compress conversation history/);
    expect(client.requests[2]?.system).toContain(summary);
    const compacted = eventsOf(session, 'context.compacted');
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({ levels: ['drop'], droppedMessages: 5, summary });
  });

  it('does not re-summarize the same dropped messages on every turn', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const initialMessages: Message[] = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: [{ type: 'text' as const, text: 'history ' + index + ' ' + 'x'.repeat(80) }],
    }));
    const summary = '## Completed\n- summarized';
    const client = new ScriptedClient([
      textStep(summary),
      textStep('first answer'),
      textStep('second answer'),
    ]);
    const loop = createLoop(client, session, ui, {
      initialMessages,
      contextWindow: 1_000,
      compression: { keepRecentMessages: 4, summaryMaxTokens: 100 },
    });

    await loop.runTurn('first');
    const attemptsAfterFirst = client.attempts;
    await loop.runTurn('second');
    expect(attemptsAfterFirst).toBe(2);
    // The second turn only has the new user/assistant pair, and that tiny drop
    // is carried verbatim instead of paying for another summarization call.
    expect(client.attempts).toBe(3);
    const summaryRequests = client.requests.filter((request) => request.system.includes('You compress conversation history'));
    expect(summaryRequests).toHaveLength(1);
    expect(client.requests.at(-1)?.system).toContain(summary);
    expect(client.requests.at(-1)?.system).toContain('Additional omitted messages');
  });

  it('summarizes dropped history with the model and injects the summary into the request', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const initialMessages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'user one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'assistant one' }] },
      { role: 'user', content: [{ type: 'text', text: 'user two' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'assistant two' }] },
      { role: 'user', content: [{ type: 'text', text: 'user three' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'assistant three' }] },
    ];
    const summary = '## Completed\n- did earlier work\n\n## Key files\n- src/a.ts\n\n## Open questions\n- none';
    const client = new ScriptedClient([textStep(summary, 100, 20), textStep('final answer', 5, 1)]);
    const loop = createLoop(client, session, ui, {
      initialMessages,
      contextWindow: 1_000,
      compression: { thresholdRatio: 0.01, keepRecentMessages: 2, summaryMaxTokens: 100 },
    });

    const result = await loop.runTurn('new request');

    expect(result.status).toBe('done');
    expect(result.usage).toEqual({
      inputTokens: 105,
      outputTokens: 21,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(client.attempts).toBe(2);
    expect(client.requests[0]?.tools).toEqual([]);
    expect(client.requests[0]?.system).toMatch(/You compress conversation history/);
    expect(client.requests[1]?.system).toContain('## Completed');
    expect(client.requests[1]?.system).toContain('## Key files');
    const compacted = eventsOf(session, 'context.compacted');
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({
      levels: ['drop'],
      droppedMessages: 4,
      summary,
    });
    expect(loop.history).toHaveLength(8);
  });

  it('routes AskUserQuestion through the configured handler and records the result', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    let asked: readonly AskQuestion[] = [];
    const client = new ScriptedClient([
      toolStep([
        {
          id: 'ask-1',
          name: 'AskUserQuestion',
          input: {
            questions: [
              { id: 'q1', question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] },
            ],
          },
        },
      ]),
      textStep('done'),
    ]);
    const loop = createLoop(client, session, ui, {
      tools: new ToolRegistry([askUserQuestionTool]),
      ask: async (questions) => {
        asked = questions;
        return [{ id: 'q1', selected: ['B'] }];
      },
    });

    const result = await loop.runTurn('go');
    expect(result.status).toBe('done');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ id: 'q1', multiSelect: false });

    const toolResult = eventsOf(session, 'tool.result')[0] as
      | { name?: string; content?: string; isError?: boolean }
      | undefined;
    expect(toolResult).toMatchObject({ name: 'AskUserQuestion', isError: false });
    expect(toolResult?.content).toContain('selected: B');

    const followUp = client.requests[1]?.messages.at(-1)?.content[0];
    expect(followUp).toMatchObject({ type: 'tool_result' });
    if (followUp?.type === 'tool_result') expect(followUp.content).toContain('selected: B');
  });

  it('persists and emits UpdatePlan state', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const plan = [
      { step: 'inspect files', status: 'completed' as const },
      { step: 'apply edit', status: 'in_progress' as const },
      { step: 'run tests', status: 'pending' as const },
    ];
    const client = new ScriptedClient([
      toolStep([{ id: 'plan-call', name: 'UpdatePlan', input: { plan } }]),
      textStep('plan applied'),
    ]);
    const loop = createLoop(client, session, ui);
    const result = await loop.runTurn('plan the work');

    expect(result.status).toBe('done');
    expect(loop.plan).toEqual(plan);
    const planEvents = eventsOf(session, 'plan.updated');
    expect(planEvents).toHaveLength(1);
    expect(planEvents[0]?.steps).toEqual(plan);
    expect(ui.filter((event) => event.type === 'plan.updated')).toHaveLength(1);
    expect(eventsOf(session, 'tool.result')[0]?.content).toContain('✔ inspect files');
    expect(eventsOf(session, 'tool.result')[0]?.content).toContain('▶ apply edit');
  });

  it('preserves multi-turn history across successful turns', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const client = new ScriptedClient([textStep('first answer', 1, 1), textStep('second answer', 2, 2)]);
    const loop = createLoop(client, session, ui);
    await loop.runTurn('first');
    await loop.runTurn('second');
    expect(loop.history).toHaveLength(4);
    expect(client.requests[1]?.messages).toHaveLength(3);
    expect(client.requests[1]?.messages[0]).toMatchObject({ role: 'user' });
    expect(client.requests[1]?.messages[1]).toMatchObject({ role: 'assistant' });
    expect(client.requests[1]?.messages[2]).toMatchObject({ role: 'user' });
  });

  it('clearHistory drops messages, plan and read-before-write state', async () => {
    const session = new RecordingSession();
    const readTracker = new ReadFileTracker();
    readTracker.markRead('/tmp/already-read.ts');
    const client = new ScriptedClient([textStep('answer')]);
    const loop = createLoop(client, session, [], {
      readTracker,
      initialPlan: [{ step: 'old plan', status: 'pending' }],
    });
    await loop.runTurn('hello');
    expect(loop.history).toHaveLength(2);
    expect(loop.plan).toHaveLength(1);
    expect(readTracker.size).toBe(1);

    loop.clearHistory();

    expect(loop.history).toEqual([]);
    expect(loop.plan).toEqual([]);
    expect(readTracker.size).toBe(0);
  });

  it('applies model and reasoning effort changes to subsequent requests', async () => {
    const session = new RecordingSession();
    const client = new ScriptedClient([textStep('first'), textStep('second')]);
    const loop = createLoop(client, session, []);
    await loop.runTurn('first');
    expect(client.requests[0]).toMatchObject({ model: 'model-a' });

    loop.setModel('model-b');
    loop.setReasoningEffort('high');
    expect(loop.model).toBe('model-b');
    expect(loop.reasoningEffort).toBe('high');
    await loop.runTurn('second');

    expect(client.requests[1]).toMatchObject({ model: 'model-b', reasoningEffort: 'high' });

    loop.setReasoningEffort(undefined);
    expect(loop.reasoningEffort).toBeUndefined();
    expect(() => loop.setModel(' ')).toThrow(/empty/i);
  });
});

describe('AgentLoop failures and cancellation', () => {
  it('aborts a streaming turn, trims history, and records turn.aborted', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const client = new ScriptedClient([
      {
        events: [
          { type: 'text.delta', text: 'partial' },
          { type: 'usage', inputTokens: 1, outputTokens: 1 },
        ],
        error: abortError(),
      },
    ]);
    const loop = createLoop(client, session, ui);
    const result = await loop.runTurn('cancel me');

    expect(result.status).toBe('aborted');
    expect(loop.history).toHaveLength(0);
    expect(eventsOf(session, 'turn.aborted')).toHaveLength(1);
    expect(eventsOf(session, 'assistant.message')).toHaveLength(0);
    expect(ui.at(-1)).toMatchObject({ type: 'turn.finished', status: 'aborted' });
    expect(ui).toContainEqual(expect.objectContaining({ type: 'text.delta', text: 'partial' }));
  });

  it('aborts during tool execution without writing a tool.result', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const client = new ScriptedClient([
      toolStep([{ id: 'call-1', name: 'abort_now', input: {} }]),
      textStep('never'),
    ]);
    const loop = createLoop(client, session, ui);
    const result = await loop.runTurn('abort tool');

    expect(result.status).toBe('aborted');
    expect(loop.history).toHaveLength(0);
    expect(eventsOf(session, 'tool.call')).toHaveLength(1);
    expect(eventsOf(session, 'tool.result')).toHaveLength(0);
    expect(eventsOf(session, 'turn.aborted')).toHaveLength(1);
  });

  it('handles a provider error as a failed turn and trims history', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const client = new ScriptedClient([
      { events: [], error: new ProviderError('upstream failed', { category: 'server', status: 500 }) },
    ]);
    const loop = createLoop(client, session, ui);
    const result = await loop.runTurn('fail');

    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({ code: 'PROVIDER_ERROR', category: 'server' });
    expect(loop.history).toHaveLength(0);
    const end = eventsOf(session, 'turn.end')[0];
    expect(end).toMatchObject({ status: 'error', error: { category: 'server' } });
    expect(ui.at(-1)).toMatchObject({ type: 'turn.finished', status: 'error' });
  });

  it('stops at maxSteps and reports STEP_LIMIT', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const client = new ScriptedClient([
      toolStep([{ id: 'call-1', name: 'echo', input: { text: 'again' } }]),
    ]);
    const loop = createLoop(client, session, ui, { maxSteps: 2 });
    const result = await loop.runTurn('loop forever');

    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({ code: 'STEP_LIMIT' });
    expect(client.attempts).toBe(2);
    expect(loop.history).toHaveLength(0);
    expect(eventsOf(session, 'tool.result')).toHaveLength(2);
    expect(eventsOf(session, 'turn.end')[0]).toMatchObject({ status: 'error', error: { code: 'STEP_LIMIT' } });
  });

  it('rejects max_tokens, refusals and empty responses', async () => {
    const cases: Array<{ step: ClientStep; code: string }> = [
      {
        step: {
          events: [
            { type: 'text.delta', text: 'truncated' },
            { type: 'stop', reason: 'max_tokens' as StopReason },
          ],
        },
        code: 'PROVIDER_ERROR',
      },
      {
        step: { events: [{ type: 'stop', reason: 'refusal' }] },
        code: 'PROVIDER_ERROR',
      },
      {
        step: { events: [{ type: 'usage', inputTokens: 1, outputTokens: 0 }, { type: 'stop', reason: 'end_turn' }] },
        code: 'PROVIDER_ERROR',
      },
    ];

    for (const item of cases) {
      const session = new RecordingSession();
      const ui: UiEvent[] = [];
      const client = new ScriptedClient([item.step]);
      const loop = createLoop(client, session, ui);
      const result = await loop.runTurn('bad response');
      expect(result.status).toBe('error');
      expect(result.error?.code).toBe(item.code);
      expect(eventsOf(session, 'assistant.message')).toHaveLength(0);
      expect(loop.history).toHaveLength(0);
    }
  });

  it('aborts before any model call when the signal is already aborted', async () => {
    const session = new RecordingSession();
    const ui: UiEvent[] = [];
    const client = new ScriptedClient([textStep('never')]);
    const loop = createLoop(client, session, ui);
    const controller = new AbortController();
    controller.abort();
    const result = await loop.runTurn('stop', { signal: controller.signal });

    expect(result.status).toBe('aborted');
    expect(client.attempts).toBe(0);
    expect(loop.history).toHaveLength(0);
    expect(eventsOf(session, 'turn.aborted')).toHaveLength(1);
    expect(ui.at(-1)).toMatchObject({ type: 'turn.finished', status: 'aborted' });
  });

  it('swallows renderer exceptions without failing the turn', async () => {
    const session = new RecordingSession();
    const client = new ScriptedClient([textStep('ok')]);
    const loop = createLoop(client, session, [], {
      emit: () => {
        throw new Error('renderer bug');
      },
    });
    await expect(loop.runTurn('ok')).resolves.toMatchObject({ status: 'done' });
  });
});
