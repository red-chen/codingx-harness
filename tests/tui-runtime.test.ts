import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE } from '../src/providers/types.js';
import type { TurnResult } from '../src/agent/index.js';
import type { SessionHandle } from '../src/session/index.js';
import { TuiApp, TuiRuntime, type Disposer, type SessionSignal, type TerminalIO } from '../src/tui/index.js';
import { TuiSession } from '../src/cli/tui-session.js';

class FakeIO implements TerminalIO {
  readonly writes: string[] = [];
  readonly rawModes: boolean[] = [];
  columns = 80;
  rows = 24;
  isTTY = true;
  dataHandler?: (chunk: string | Uint8Array) => void;
  resizeHandler?: (columns: number, rows: number) => void;
  readonly signals = new Map<SessionSignal, () => void>();

  write(text: string): void {
    this.writes.push(text);
  }

  setRawMode(enabled: boolean): void {
    this.rawModes.push(enabled);
  }

  onResize(listener: (columns: number, rows: number) => void): Disposer {
    this.resizeHandler = listener;
    return () => {
      this.resizeHandler = undefined;
    };
  }

  onData(listener: (chunk: string | Uint8Array) => void): Disposer {
    this.dataHandler = listener;
    return () => {
      this.dataHandler = undefined;
    };
  }

  onSignal(signal: SessionSignal, listener: () => void): Disposer {
    this.signals.set(signal, listener);
    return () => {
      this.signals.delete(signal);
    };
  }
}

function makeApp(): TuiApp {
  return new TuiApp({
    session: { sessionId: 's1', cwd: '/work', model: 'test-model' },
    version: '0.1.0',
    width: 80,
    height: 24,
    now: () => 1_000,
  });
}

function makeRuntime(
  app: TuiApp,
  io: FakeIO,
  commands: unknown[],
  local: string[],
  onCopy?: () => void,
  copySelection?: (text: string) => string,
): TuiRuntime {
  return new TuiRuntime({
    app,
    io,
    colorMode: 'none',
    onCommand: (command) => {
      commands.push(command);
    },
    onLocalCommand: (text) => {
      local.push(text);
    },
    ...(onCopy ? { onCopy } : {}),
    ...(copySelection ? { copySelection } : {}),
  });
}

function keyCtrlC(): string {
  return '\x03';
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const fakeSession = {
  id: 's1',
  filePath: '/tmp/s1.jsonl',
  meta: { id: 's1', cwd: '/work', model: 'm', createdAt: '2026-01-01T00:00:00Z', cliVersion: '0.1.0' },
  writable: true,
} as unknown as SessionHandle;

describe('TuiRuntime', () => {
  it('enters the terminal, renders, submits text and stops idempotently', () => {
    const io = new FakeIO();
    const app = makeApp();
    const commands: unknown[] = [];
    const runtime = makeRuntime(app, io, commands, []);
    expect(runtime.start()).toBe(true);
    expect(io.rawModes).toEqual([true]);
    expect(io.writes.join('')).toContain('codingx');

    runtime.feed('hello');
    expect(commands).toEqual([]);
    runtime.feed('\r');
    expect(commands).toEqual([{ type: 'submit', text: 'hello' }]);
    expect(app.transcript[0]).toMatchObject({ type: 'user', text: 'hello' });

    runtime.stop();
    runtime.stop();
    expect(io.rawModes).toEqual([true, false]);
    expect(io.writes.join('')).toContain('\x1b[?1049l');
  });

  it('shows and positions the hardware cursor at the composer insertion point', () => {
    const io = new FakeIO();
    const app = makeApp();
    const runtime = makeRuntime(app, io, [], []);
    runtime.start();
    const output = io.writes.join('');
    expect(output).toContain('\x1b[?25h');
    expect(output).toMatch(/\x1b\[(22|23);3H/u);
    app.openHelp();
    runtime.render(true);
    expect(io.writes.join('')).toContain('\x1b[?25l');
    runtime.stop();
  });

  it('copies the text selected with the mouse on release', async () => {
    const io = new FakeIO();
    const app = makeApp();
    const rows: string[] = [];
    const frame = app.frame();
    for (let y = 0; y < frame.height; y++) {
      let row = '';
      for (let x = 0; x < frame.width; x++) row += frame.get(x, y)?.symbol ?? ' ';
      rows.push(row);
    }
    const statusY = rows.findIndex((row) => row.includes('Ready'));
    expect(statusY).toBeGreaterThan(0);
    let copied = '';
    const runtime = makeRuntime(app, io, [], [], undefined, (text) => {
      copied = text;
      return 'test';
    });
    runtime.start();
    const y = statusY + 1;
    runtime.feed('\x1b[<0;1;' + y + 'M');
    runtime.feed('\x1b[<32;20;' + y + 'M');
    runtime.feed('\x1b[<0;20;' + y + 'm');
    await flush();
    expect(copied).toContain('Ready');
    runtime.stop();
  });

  it('invokes the copy hook for Ctrl+Y', () => {
    const io = new FakeIO();
    const app = makeApp();
    let copies = 0;
    const runtime = makeRuntime(app, io, [], [], () => copies++);
    runtime.start();
    runtime.feed('\x19');
    expect(copies).toBe(1);
    runtime.stop();
  });

  it('scrolls the transcript with SGR mouse wheel events', () => {
    const io = new FakeIO();
    const app = makeApp();
    for (let index = 0; index < 40; index++) app.addNotice('history ' + index);
    const runtime = makeRuntime(app, io, [], []);
    runtime.start();
    runtime.feed('\x1b[<64;10;5M');
    expect(app.scrollOffset).toBe(3);
    runtime.feed('\x1b[<65;10;5M');
    expect(app.scrollOffset).toBe(0);
    runtime.stop();
  });

  it('handles local slash commands and idle Ctrl+C without submitting', () => {
    const io = new FakeIO();
    const app = makeApp();
    let idleCtrlC = 0;
    const local: string[] = [];
    const runtime = new TuiRuntime({
      app,
      io,
      colorMode: 'none',
      onLocalCommand: (text) => local.push(text),
      onIdleCtrlC: () => {
        idleCtrlC += 1;
      },
    });
    runtime.start();
    runtime.feed('/help\r');
    expect(local).toEqual(['/help']);
    expect(app.transcript).toEqual([]);
    expect(app.composer.text).toBe('');
    runtime.feed(keyCtrlC());
    expect(idleCtrlC).toBe(1);
    runtime.stop();
  });

  it('dispatches interrupt while working and updates on resize/paste', () => {
    const io = new FakeIO();
    const app = makeApp();
    const commands: unknown[] = [];
    const runtime = makeRuntime(app, io, commands, []);
    runtime.start();
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    runtime.feed(keyCtrlC());
    expect(commands).toEqual([{ type: 'interrupt' }]);

    runtime.feed('\x1b[8;40;120t');
    expect(app.state.width).toBe(120);
    expect(app.state.height).toBe(40);

    runtime.feed('\x1b[200~hello\nworld\x1b[201~');
    expect(app.composer.text).toContain('hello\nworld');
    runtime.stop();
  });
});

describe('TuiSession', () => {
  it('runs one turn without duplicating the user cell and exits cleanly', async () => {
    const io = new FakeIO();
    const app = makeApp();
    const prompts: string[] = [];
    const runTurn = async (text: string): Promise<TurnResult> => {
      prompts.push(text);
      app.handleEvent({ type: 'turn.started', turnId: 't1' });
      app.handleEvent({ type: 'text.delta', turnId: 't1', text: 'answer' });
      app.handleEvent({
        type: 'turn.finished',
        turnId: 't1',
        status: 'done',
        usage: EMPTY_USAGE,
        durationMs: 3,
      });
      return { turnId: 't1', status: 'done', usage: EMPTY_USAGE, steps: 0, durationMs: 3 };
    };
    const controller = new TuiSession({ app, io, session: fakeSession, runTurn, initialPrompt: 'hello' });
    const running = controller.run();
    await flush();
    expect(prompts).toEqual(['hello']);
    expect(app.transcript.filter((cell) => cell.type === 'user')).toHaveLength(1);
    expect(app.transcript.filter((cell) => cell.type === 'assistant')).toHaveLength(1);
    controller.exit(0);
    await expect(running).resolves.toBe(0);
    expect(io.rawModes).toEqual([true, false]);
  });

  it('queues Enter while working and starts the queued prompt after the turn', async () => {
    const io = new FakeIO();
    const app = makeApp();
    const prompts: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runTurn = async (text: string): Promise<TurnResult> => {
      prompts.push(text);
      app.handleEvent({ type: 'turn.started', turnId: 't' + prompts.length });
      if (prompts.length === 1) await firstDone;
      app.handleEvent({ type: 'text.delta', turnId: 't' + prompts.length, text: 'ok' });
      app.handleEvent({
        type: 'turn.finished',
        turnId: 't' + prompts.length,
        status: 'done',
        usage: EMPTY_USAGE,
        durationMs: 1,
      });
      return { turnId: 't' + prompts.length, status: 'done', usage: EMPTY_USAGE, steps: 0, durationMs: 1 };
    };
    const controller = new TuiSession({ app, io, session: fakeSession, runTurn, initialPrompt: 'first' });
    const running = controller.run();
    await flush();
    controller.runtime.feed('second\r');
    expect(app.queue.map((item) => item.text)).toEqual(['second']);
    releaseFirst();
    await flush();
    await flush();
    expect(prompts).toEqual(['first', 'second']);
    expect(app.transcript.filter((cell) => cell.type === 'user').map((cell) => (cell as { text: string }).text)).toEqual([
      'first',
      'second',
    ]);
    controller.exit(0);
    await running;
  });

  it('interrupts an active turn through Esc and exits after two idle Ctrl+C presses', async () => {
    const io = new FakeIO();
    const app = makeApp();
    let aborted = false;
    const runTurn = async (_text: string, signal: AbortSignal): Promise<TurnResult> => {
      app.handleEvent({ type: 'turn.started', turnId: 't1' });
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          app.handleEvent({
            type: 'turn.finished',
            turnId: 't1',
            status: 'aborted',
            usage: EMPTY_USAGE,
            durationMs: 1,
          });
          resolve();
        });
      });
      return { turnId: 't1', status: 'aborted', usage: EMPTY_USAGE, steps: 0, durationMs: 1 };
    };
    const controller = new TuiSession({ app, io, session: fakeSession, runTurn, initialPrompt: 'long task' });
    const running = controller.run();
    await flush();
    controller.runtime.feed('\x03');
    await flush();
    expect(aborted).toBe(true);
    expect(app.status.outcome).toBe('aborted');

    controller.runtime.feed(keyCtrlC());
    controller.runtime.feed(keyCtrlC());
    await expect(running).resolves.toBe(0);
  });

  it('handles /session locally and /quit exits', async () => {
    const io = new FakeIO();
    const app = makeApp();
    let called = 0;
    const controller = new TuiSession({
      app,
      io,
      session: fakeSession,
      runTurn: async () => {
        called += 1;
        return { turnId: 't1', status: 'done', usage: EMPTY_USAGE, steps: 0, durationMs: 0 };
      },
    });
    const running = controller.run();
    await flush();
    controller.runtime.feed('/session\r');
    expect(called).toBe(0);
    expect(app.transcript.some((cell) => cell.type === 'notice' && cell.text.includes('/tmp/s1.jsonl'))).toBe(true);
    controller.runtime.feed('/quit\r');
    await expect(running).resolves.toBe(0);
  });
});