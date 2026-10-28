import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AgentLoop, type AgentModelClient, type UiEvent } from '../src/agent/index.js';
import { HookRunner } from '../src/hooks/index.js';
import type { HookConfig } from '../src/hooks/types.js';
import type { Message, ModelEvent, ModelRequest } from '../src/providers/types.js';
import type { AppendEventInput, RolloutEvent, SessionHandle } from '../src/session/types.js';
import { ReadFileTracker, ToolRegistry, type ToolDef } from '../src/tools/index.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'codingx-hooks-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

class RecordingSession implements SessionHandle {
  readonly id = 'abcdef123456';
  readonly filePath = '/tmp/hooks.jsonl';
  readonly meta = { id: this.id, cwd: '/tmp/hooks', model: 'm', createdAt: new Date().toISOString(), cliVersion: '0.1.0' };
  readonly writable = true;
  readonly events: RolloutEvent[] = [];
  private seq = 0;

  async append(input: AppendEventInput | AppendEventInput[]): Promise<RolloutEvent[]> {
    const list = Array.isArray(input) ? input : [input];
    return list.map((item) => {
      this.seq += 1;
      const event = { seq: this.seq, ts: new Date().toISOString(), eventId: 'e' + this.seq, ...item } as RolloutEvent;
      this.events.push(event);
      return event;
    });
  }

  async clear(): Promise<void> {}
  async replay(): Promise<RolloutEvent[]> { return [...this.events]; }
  async end(): Promise<RolloutEvent> { return (await this.append({ type: 'session.end' }))[0] as RolloutEvent; }
  async close(): Promise<void> {}
}

class ScriptedClient implements AgentModelClient {
  attempts = 0;
  private readonly steps: ModelEvent[][];

  constructor(steps: ModelEvent[][]) {
    this.steps = steps;
  }

  async countTokens(): Promise<number> { return 0; }

  async *stream(_request: ModelRequest): AsyncIterable<ModelEvent> {
    const step = this.steps[Math.min(this.attempts, this.steps.length - 1)] ?? [];
    this.attempts += 1;
    for (const event of step) yield event;
  }
}

const toolSchema = z.object({ text: z.string().optional() });

function toolRegistry(log: string[]): ToolRegistry {
  const echo: ToolDef<typeof toolSchema> = {
    name: 'echo',
    description: 'echo',
    schema: toolSchema,
    parallelSafe: true,
    approval: 'none',
    async execute(input) {
      log.push(input.text ?? '');
      return { content: 'tool-output:' + (input.text ?? '') };
    },
  };
  return new ToolRegistry([echo]);
}

function runner(hooks: HookConfig[]): HookRunner {
  return new HookRunner(hooks, { cwd, env: { PATH: process.env.PATH ?? '', HOME: cwd } });
}

function makeLoop(
  session: RecordingSession,
  client: ScriptedClient,
  log: string[],
  hookRunner: HookRunner,
  ui: UiEvent[] = [],
): AgentLoop {
  return new AgentLoop({
    session,
    router: client,
    tools: toolRegistry(log),
    systemPrompt: 'test',
    model: 'm',
    maxSteps: 3,
    maxOutputTokens: 100,
    sessionId: session.id,
    cwd,
    maxOutputChars: 20_000,
    shell: { env: { PATH: process.env.PATH ?? '', HOME: cwd }, timeoutMs: 5000 },
    hooks: hookRunner,
    emit: (event) => ui.push(event),
    readTracker: new ReadFileTracker(),
  });
}

const toolStep = (name: string, input: unknown): ModelEvent[] => [
  { type: 'tool.call', id: 'call-1', name, input },
  { type: 'stop', reason: 'tool_use' },
];

const textStep = (text: string): ModelEvent[] => [
  { type: 'text.delta', text },
  { type: 'stop', reason: 'end_turn' },
];

describe('HookRunner', () => {
  it('passes a JSON payload on stdin and records successful context', async () => {
    const session = new RecordingSession();
    const hooks = runner([
      { event: 'session_start', command: 'cat', timeoutMs: 5_000 },
    ]);
    const result = await hooks.run(
      'session_start',
      { sessionId: session.id, cwd, turnId: 'turn-1' },
      { session, turnId: 'turn-1' },
    );
    expect(result.blocked).toBe(false);
    expect(result.context).toContain('"hook_event_name":"session_start"');
    expect(result.context).toContain('"session_id":"' + session.id + '"');
    const event = session.events.find((item) => item.type === 'hook.finished');
    expect(event).toMatchObject({ event: 'session_start', status: 'ok', command: 'cat' });
  });

  it('blocks blocking events on exit code 2 and honors tool matchers', async () => {
    const session = new RecordingSession();
    const hooks = runner([
      { event: 'pre_tool_use', matcher: 'Shell', command: 'echo blocked >&2; exit 2', timeoutMs: 5_000 },
    ]);
    const blocked = await hooks.run(
      'pre_tool_use',
      { sessionId: session.id, cwd, toolName: 'Shell', toolInput: { command: 'rm -rf /' } },
      { session },
    );
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain('blocked');
    expect(blocked.outcomes[0]).toMatchObject({ status: 'blocked', blocked: true });

    const skipped = await hooks.run(
      'pre_tool_use',
      { sessionId: session.id, cwd, toolName: 'ReadFile', toolInput: { path: 'a' } },
      { session },
    );
    expect(skipped.outcomes).toHaveLength(0);
    expect(skipped.blocked).toBe(false);
  });

  it('reports timeouts without blocking the turn', async () => {
    const session = new RecordingSession();
    const hooks = runner([
      { event: 'pre_tool_use', command: 'sleep 5', timeoutMs: 120 },
    ]);
    const result = await hooks.run(
      'pre_tool_use',
      { sessionId: session.id, cwd, toolName: 'Shell' },
      { session },
    );
    expect(result.blocked).toBe(false);
    expect(result.outcomes[0]?.status).toBe('timeout');
  });

  it('rejects matchers on non-tool events', () => {
    expect(
      () =>
        new HookRunner(
          [{ event: 'stop', command: 'true', timeoutMs: 1_000, matcher: 'Shell' }],
          { cwd, env: {} },
        ),
    ).toThrow(/matcher/);
  });
});

describe('AgentLoop hooks', () => {
  it('blocks a tool call from pre_tool_use and records the result', async () => {
    const session = new RecordingSession();
    const executed: string[] = [];
    const client = new ScriptedClient([toolStep('echo', { text: 'hi' }), textStep('done')]);
    const loop = makeLoop(
      session,
      client,
      executed,
      runner([{ event: 'pre_tool_use', command: 'echo denied >&2; exit 2', timeoutMs: 5_000 }]),
    );
    const result = await loop.runTurn('run echo');
    expect(result.status).toBe('done');
    expect(executed).toEqual([]);
    const toolResult = session.events.find((event) => event.type === 'tool.result');
    expect(toolResult).toMatchObject({ isError: true, meta: { code: 'HOOK_BLOCKED' } });
    expect(session.events.some((event) => event.type === 'hook.finished' && event.status === 'blocked')).toBe(true);
  });

  it('appends post_tool_use context to the tool result', async () => {
    const session = new RecordingSession();
    const executed: string[] = [];
    const client = new ScriptedClient([toolStep('echo', { text: 'hi' }), textStep('done')]);
    const loop = makeLoop(
      session,
      client,
      executed,
      runner([{ event: 'post_tool_use', command: 'echo post-hook', timeoutMs: 5_000 }]),
    );
    await loop.runTurn('run echo');
    expect(executed).toEqual(['hi']);
    const toolResult = session.events.find((event) => event.type === 'tool.result');
    expect(toolResult?.content).toContain('tool-output:hi');
    expect(toolResult?.content).toContain('[Hook context: post_tool_use]');
    expect(toolResult?.content).toContain('post-hook');
  });

  it('blocks a prompt before calling the provider', async () => {
    const session = new RecordingSession();
    const client = new ScriptedClient([textStep('should not run')]);
    const loop = makeLoop(
      session,
      client,
      [],
      runner([{ event: 'user_prompt_submit', command: 'echo prompt denied >&2; exit 2', timeoutMs: 5_000 }]),
    );
    const result = await loop.runTurn('blocked prompt');
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('HOOK_BLOCKED');
    expect(client.attempts).toBe(0);
  });

  it('runs stop hooks after a completed turn', async () => {
    const session = new RecordingSession();
    const client = new ScriptedClient([textStep('done')]);
    const loop = makeLoop(
      session,
      client,
      [],
      runner([{ event: 'stop', command: 'echo stopped', timeoutMs: 5_000 }]),
    );
    const result = await loop.runTurn('say done');
    expect(result.status).toBe('done');
    expect(session.events.some((event) => event.type === 'hook.finished' && event.event === 'stop')).toBe(true);
  });
});
