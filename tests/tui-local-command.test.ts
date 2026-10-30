import { describe, expect, it } from 'vitest';
import type { TurnResult } from '../src/agent/index.js';
import type { ProcessCommandResult } from '../src/cli/process-command.js';
import type { LocalCommandOutcome } from '../src/cli/local-command.js';
import { TuiSession } from '../src/cli/tui-session.js';
import { EMPTY_USAGE } from '../src/providers/types.js';
import type { SessionHandle } from '../src/session/index.js';
import { TuiApp } from '../src/tui/state/app.js';
import type { LocalCommandCell } from '../src/tui/state/types.js';
import type { Disposer, SessionSignal, TerminalIO } from '../src/tui/terminal/session.js';
import { buildTranscriptCellLines } from '../src/tui/widgets/transcript.js';

class FakeIO implements TerminalIO {
  readonly writes: string[] = [];
  readonly isTTY = true;
  readonly columns = 100;
  readonly rows = 30;
  write(text: string): void {
    this.writes.push(text);
  }
  setRawMode(): void {}
  onResize(): Disposer {
    return () => undefined;
  }
  onData(): Disposer {
    return () => undefined;
  }
  onSignal(_signal: SessionSignal): Disposer {
    return () => undefined;
  }
}

class FakeSession {
  readonly id = 'session-1';
  readonly filePath = '/tmp/session-1.jsonl';
  readonly meta = { id: this.id, cwd: '/tmp/work', model: 'm', createdAt: '', cliVersion: '' };
  readonly writable = true;
  readonly events: Array<Record<string, unknown> & { type: string }> = [];
  async append(input: { type: string } | Array<{ type: string }>): Promise<never[]> {
    const list = Array.isArray(input) ? input : [input];
    for (const event of list) {
      this.events.push({ ...event, seq: this.events.length + 1, ts: '', eventId: String(this.events.length + 1) });
    }
    return [];
  }
  async replay(): Promise<never[]> {
    return [];
  }
  async end(): Promise<never> {
    return {} as never;
  }
  async close(): Promise<void> {}
  async clear(): Promise<void> {
    this.events.length = 0;
  }
}

const doneTurn = (turnId: string): TurnResult => ({
  turnId,
  status: 'done',
  usage: EMPTY_USAGE,
  steps: 0,
  durationMs: 1,
});

function makeApp(): TuiApp {
  return new TuiApp({
    session: { sessionId: 'session-1', cwd: '/tmp/work', model: 'test-model' },
    version: '0.1.0',
    width: 100,
    height: 30,
    now: () => 1000,
  });
}

function wait(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface HarnessOptions {
  runProcess?: (line: string) => Promise<ProcessCommandResult>;
  runTurn?: (text: string, signal: AbortSignal) => Promise<TurnResult>;
  runLocal?: (command: string, signal: AbortSignal) => Promise<LocalCommandOutcome>;
  initialPrompt?: string;
}

function makeHarness(app: TuiApp, options: HarnessOptions = {}) {
  const session = new FakeSession();
  const prompts: string[] = [];
  const localCalls: string[] = [];
  const runTurn = options.runTurn ?? (async (text: string) => {
    prompts.push(text);
    const turnId = 't' + prompts.length;
    app.handleEvent({ type: 'turn.started', turnId });
    app.handleEvent({ type: 'text.delta', turnId, text: 'ok' });
    app.handleEvent({ type: 'turn.finished', turnId, status: 'done', usage: EMPTY_USAGE, durationMs: 1 });
    return doneTurn(turnId);
  });
  const runLocal = options.runLocal ?? (async () => ({
    content: '/tmp/work',
    isError: false,
    exitCode: 0,
    durationMs: 1,
    timedOut: false,
    aborted: false,
  }));
  const controller = new TuiSession({
    app,
    io: new FakeIO(),
    session: session as unknown as SessionHandle,
    runTurn,
    runProcessCommand: options.runProcess,
    runLocalCommand: (command, signal) => {
      localCalls.push(command);
      return runLocal(command, signal);
    },
    ...(options.initialPrompt === undefined ? {} : { initialPrompt: options.initialPrompt }),
  });
  return { app, controller, session, prompts, localCalls };
}

function screenText(app: TuiApp): string {
  const frame = app.renderFrame();
  const rows: string[] = [];
  for (let y = 0; y < frame.height; y++) {
    let row = '';
    for (let x = 0; x < frame.width; x++) row += frame.get(x, y)?.symbol ?? ' ';
    rows.push(row.replace(/\s+$/u, ''));
  }
  return rows.join('\n');
}

function notices(app: TuiApp): string[] {
  return app.transcript
    .filter((cell) => cell.type === 'notice')
    .map((cell) => (cell.type === 'notice' ? cell.text : ''));
}

describe('TuiSession local commands', () => {
  it('runs !pwd locally and records local.command/local.result', async () => {
    const app = makeApp();
    const { controller, session, localCalls } = makeHarness(app);
    expect(controller.runtime.start()).toBe(true);
    controller.runtime.feed('!pwd\r');
    await wait();

    expect(localCalls).toEqual(['pwd']);
    expect(app.composer.text).toBe('');
    expect(app.status.state).toBe('idle');
    const local = app.transcript.find((cell) => cell.type === 'local');
    expect(local).toMatchObject({ command: 'pwd', output: '/tmp/work', isError: false, running: false });
    const text = screenText(app);
    expect(text).toContain('› ! pwd');
    expect(text).toContain('/tmp/work');
    expect(session.events.map((event) => event.type)).toEqual(['local.command', 'local.result']);
    expect(session.events[0]).toMatchObject({ command: 'pwd' });
    expect(session.events[1]).toMatchObject({ content: '/tmp/work', isError: false, exitCode: 0 });
    controller.exit(0);
  });

  it('reports usage for a bare bang and keeps the composer', async () => {
    const app = makeApp();
    const { controller, localCalls } = makeHarness(app);
    expect(controller.runtime.start()).toBe(true);
    controller.runtime.feed('!\r');
    await wait();

    expect(localCalls).toEqual([]);
    expect(app.composer.text).toBe('!');
    expect(notices(app).at(-1)).toContain('Usage: !<command>');
    controller.exit(0);
  });

  it('renders the complete local output without the exec preview cap', () => {
    const cell: LocalCommandCell = {
      type: 'local',
      id: 'l1',
      command: 'seq 1 40',
      output: Array.from({ length: 40 }, (_, index) => 'line ' + (index + 1)).join('\n'),
      isError: false,
      durationMs: 5,
      running: false,
    };
    const lines = buildTranscriptCellLines(cell, 60);
    const text = lines.map((line) => line.segments.map((segment) => segment.text).join('')).join('\n');
    expect(text).toContain('› ! seq 1 40');
    expect(text).toContain('line 1');
    expect(text).toContain('line 40');
    expect(text).not.toContain('… +');
  });

  it('refuses to run a local command while a turn is active', async () => {
    const app = makeApp();
    let release!: () => void;
    let turnCalls = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, localCalls } = makeHarness(app, {
      initialPrompt: 'hello',
      runTurn: async (_text, _signal) => {
        turnCalls += 1;
        app.handleEvent({ type: 'turn.started', turnId: 't1' });
        await gate;
        app.handleEvent({ type: 'turn.finished', turnId: 't1', status: 'done', usage: EMPTY_USAGE, durationMs: 1 });
        return doneTurn('t1');
      },
    });
    const running = controller.run();
    await wait();
    controller.runtime.feed('!pwd\r');
    await wait();

    expect(turnCalls).toBe(1);
    expect(localCalls).toEqual([]);
    expect(app.composer.text).toBe('!pwd');
    expect(notices(app).at(-1)).toContain('A turn is already running');

    release();
    await wait();
    controller.exit(0);
    await running;
  });

  it('queues a prompt submitted while a local command runs', async () => {
    const app = makeApp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, localCalls, prompts } = makeHarness(app, {
      runLocal: async () => {
        await gate;
        return { content: 'done', isError: false, exitCode: 0, durationMs: 1, timedOut: false, aborted: false };
      },
    });
    expect(controller.runtime.start()).toBe(true);
    controller.runtime.feed('!pwd\r');
    await wait();
    expect(localCalls).toEqual(['pwd']);
    controller.runtime.feed('hello\r');
    await wait();
    expect(app.queue.map((item) => item.text)).toEqual(['hello']);

    release();
    await wait();
    await wait();
    expect(prompts).toEqual(['hello']);
    expect(app.transcript.filter((cell) => cell.type === 'local')).toHaveLength(1);
    controller.exit(0);
  });
});


describe('TUI /process', () => {
  it('runs management commands locally and renders results without a model turn', async () => {
    const app = makeApp();
    const calls: string[] = [];
    const { controller, prompts, session } = makeHarness(app, {
      runProcess: async (line) => { calls.push(line); return { content: 'abc running pid=123', isError: false }; },
    });
    expect(controller.runtime.start()).toBe(true);
    controller.runtime.feed('/process\r');
    await expect.poll(() => notices(app).join('\n')).toContain('abc running pid=123');
    expect(calls).toEqual(['/process']);
    expect(prompts).toEqual([]);
    expect(session.events).toEqual([]);
    controller.exit();
  });

  it('waits for an in-flight stop before allowing session shutdown', async () => {
    const app = makeApp();
    let finish!: (result: ProcessCommandResult) => void;
    const { controller } = makeHarness(app, {
      runProcess: () => new Promise((resolve) => { finish = resolve; }),
    });
    let closed = false;
    const running = controller.run().then(() => { closed = true; });
    controller.handleLocalCommand('/process stop abc');
    await expect.poll(() => typeof finish).toBe('function');
    controller.exit();
    await Promise.resolve();
    expect(closed).toBe(false);
    finish({ content: 'abc exited', isError: false });
    await running;
    expect(closed).toBe(true);
  });
});
