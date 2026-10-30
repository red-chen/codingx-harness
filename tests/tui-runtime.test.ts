import xterm from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_USAGE, type ReasoningEffort } from '../src/providers/types.js';
import type { TurnResult } from '../src/agent/index.js';
import type { SessionHandle } from '../src/session/index.js';
import { TuiApp, TuiRuntime, type Disposer, type SessionSignal, type TerminalIO } from '../src/tui/index.js';
import { TuiSession } from '../src/cli/tui-session.js';
import type { AskQuestion } from '../src/tools/types.js';

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

function makeApp(tip?: string): TuiApp {
  return new TuiApp({
    ...(tip ? { tip } : {}),
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
  clear: async () => undefined,
} as unknown as SessionHandle;

describe('TuiRuntime', () => {
  it('handles a terminal Tab as filling the current tip without emitting a command', () => {
    const app = makeApp('Review 当前修改');
    const io = new FakeIO();
    const commands: unknown[] = [];
    const local: string[] = [];
    const runtime = makeRuntime(app, io, commands, local);
    runtime.start();
    try {
      runtime.feed('\t');
      expect(app.composer.text).toBe('Review 当前修改');
      expect(commands).toEqual([]);
      expect(local).toEqual([]);
      expect(app.queue).toEqual([]);
    } finally { runtime.stop(); }
  });

  it('selects configured tips locally without provider calls or rollout writes', async () => {
    const app = makeApp('First');
    const io = new FakeIO();
    const runTurn = vi.fn(async (): Promise<TurnResult> => { throw new Error('unexpected turn'); });
    const append = vi.fn();
    const controller = new TuiSession({ app, io, session: { ...fakeSession, append }, runTurn,
      tips: ['First', '\u001b[31m第二条\u001b[0m\n完整提示'] });
    const done = controller.run();
    try {
      controller.runtime.feed('/tips\r');
      expect(app.mode).toBe('tips');
      expect(app.state.tips?.items).toEqual(['First', '第二条 完整提示']);
      controller.runtime.feed('\x1b[B\r');
      expect(app.mode).toBe('main');
      expect(app.state.tip).toBe('第二条 完整提示');
      expect(app.composer.text).toBe('第二条 完整提示');
      expect(app.composer.cursor).toBe(app.composer.text.length);
      expect(runTurn).not.toHaveBeenCalled();
      app.clearComposer();
      controller.runtime.feed('/tips\r');
      expect(app.state.tips?.index).toBe(1);
      controller.runtime.feed('\x1b[A\x03');
      expect(app.state.tip).toBe('第二条 完整提示');
      expect(app.mode).toBe('main');
      expect(app.composer.text).toBe('');
      expect(app.transcript).toEqual([]);
      expect(runTurn).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      app.resetSession();
      expect(app.state.tip).toBe('第二条 完整提示');
    } finally { controller.exit(); }
    expect(await done).toBe(0);
  });

  it('accepts searched commands without executing them and Ctrl+C cancels search', () => {
    const io = new FakeIO();
    const app = new TuiApp({ session: { sessionId: 's1', cwd: '/work', model: 'test' },
      version: 'test', inputHistory: ['/clear', '!pwd'] });
    const local: string[] = [];
    const commands: unknown[] = [];
    const runtime = makeRuntime(app, io, commands, local);
    runtime.start();
    try {
      io.dataHandler?.('draft');
      io.dataHandler?.('\x12');
      io.dataHandler?.('!pwd');
      io.dataHandler?.('\r');
      expect(app.composer.text).toBe('!pwd');
      expect(local).toEqual([]);
      expect(commands).toEqual([]);
      io.dataHandler?.('\x12');
      io.dataHandler?.('/clear');
      io.dataHandler?.('\x03');
      expect(app.composer.search).toBeUndefined();
      expect(app.composer.text).toBe('!pwd');
      io.dataHandler?.('\x12');
      io.dataHandler?.('/clear');
      io.dataHandler?.('\r');
      expect(app.composer.text).toBe('/clear');
      expect(local).toEqual([]);
      io.dataHandler?.('\r');
      expect(local).toEqual(['/clear']);
    } finally { runtime.stop(); }
  });

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
    expect(io.writes.join('')).not.toContain('\x1b[?1049h');
    expect(io.writes.join('')).not.toContain('\x1b[?1049l');
  });

  it('coalesces rapid render requests into one trailing frame', () => {
    vi.useFakeTimers();
    try {
      const io = new FakeIO();
      const app = makeApp();
      const runtime = makeRuntime(app, io, [], []);
      runtime.start();
      const before = io.writes.length;
      for (let index = 0; index < 20; index++) {
        app.addNotice('rapid ' + index);
        runtime.render();
      }
      expect(io.writes.length).toBe(before);
      vi.advanceTimersByTime(20);
      expect(io.writes.length).toBeGreaterThan(before);
      runtime.stop();
    } finally {
      vi.useRealTimers();
    }
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

  it('handles reported wheel events without capturing native terminal selection', () => {
    const io = new FakeIO();
    const app = makeApp();
    for (let index = 0; index < 40; index++) app.addNotice('history ' + index);
    const runtime = makeRuntime(app, io, [], []);
    runtime.start();
    runtime.feed('\x1b[<64;10;5M');
    runtime.feed('\x1b[<0;5;8M');
    runtime.feed('\x1b[<0;5;8m');
    expect(app.scrollOffset).toBe(3);
    const history = app.frame();
    runtime.feed('\x1b[<65;10;5M');
    expect(app.scrollOffset).toBe(0);
    expect(app.frame()).not.toEqual(history);
    app.openHelp();
    runtime.feed('\x1b[<64;10;5M');
    expect(app.scrollOffset).toBe(0);
    runtime.stop();
    const output = io.writes.join('');
    expect(output).not.toContain('\x1b[?1002h');
    expect(output).not.toContain('\x1b[?1006h');
    expect(output).not.toContain('\x1b[?1006l');
    expect(output).not.toContain('\x1b[?1002l');
  });

  it('archives hidden history once on the primary screen without capturing selection', () => {
    const io = new FakeIO();
    const app = makeApp();
    for (let index = 0; index < 80; index++) app.addNotice('history-' + index);
    const runtime = makeRuntime(app, io, [], []);
    runtime.start();
    const output = io.writes.join('');
    expect(output).toContain('history-0');
    expect(output).toContain('history-79');
    expect(output).not.toContain('\x1b[?1049h');
    expect(output).not.toContain('\x1b[?1002h');
    io.writes.length = 0;
    runtime.render(true);
    expect(io.writes.join('')).not.toContain('history-0');
    app.addNotice('history-80');
    runtime.render(true);
    expect(io.writes.join('')).toContain('history-80');
    expect(io.writes.join('')).not.toContain('history-0');
    runtime.stop();
  });

  it.each([0, 40])('starts scrollback at welcome and preserves history with %i restored rows', async (restoredRows) => {
    const terminal = new xterm.Terminal({ cols: 80, rows: 24, scrollback: 10000, allowProposedApi: true });
    await new Promise<void>((resolve) => terminal.write(
      'OLD_SHELL_OUTPUT\r\n'.repeat(50) + '$ codingx', resolve,
    ));
    const io = new FakeIO();
    const app = makeApp('Use /help for shortcuts.');
    for (let index = 0; index < restoredRows; index++) {
      app.addNotice('HISTORY_' + String(index).padStart(3, '0'));
    }
    const runtime = makeRuntime(app, io, [], []);
    runtime.start();
    const drain = async (): Promise<void> => {
      const output = io.writes.splice(0).join('');
      // iTerm2 may archive an entire viewport on ED2. Never emit it here.
      expect(output).not.toContain('\x1b[2J');
      await new Promise<void>((resolve) => terminal.write(output, resolve));
    };
    await drain();
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain('╭');
    if (restoredRows === 0) expect(terminal.buffer.active.baseY).toBe(0);
    for (let index = restoredRows; index < 60; index++) {
      if (index === 30) runtime.feed('\x1b[200~line1\nline2\nline3\nline4\x1b[201~');
      if (index === 35) app.clearComposer();
      app.addNotice('HISTORY_' + String(index).padStart(3, '0'));
      runtime.render(true);
      await drain();
    }
    const lines = Array.from({ length: terminal.buffer.active.length }, (_, i) =>
      terminal.buffer.active.getLine(i)?.translateToString(true) ?? '');
    expect(lines[0]).toContain('╭');
    expect(lines.join('\n')).not.toContain('OLD_SHELL_OUTPUT');
    expect(lines.join('\n')).not.toContain('$ codingx');
    expect(lines.join('\n').split('  └ Tip: Use /help for shortcuts.')).toHaveLength(2);
    const tipRow = lines.findIndex((line) => line.includes('  └ Tip:'));
    expect(tipRow).toBeGreaterThanOrEqual(terminal.buffer.active.baseY);
    expect(lines[tipRow - 1]).toContain('Ready');
    const ids = lines.flatMap((line) => line.match(/HISTORY_\d+/gu) ?? []);
    expect(ids).toEqual(Array.from({ length: 60 }, (_, i) => 'HISTORY_' + String(i).padStart(3, '0')));
    runtime.stop();
    terminal.dispose();
  });

  it.each([false, true])('preserves complete tables after /clear with coalesced output: %s', async (coalesced) => {
    const terminal = new xterm.Terminal({ cols: 80, rows: 24, scrollback: 10000, allowProposedApi: true });
    const io = new FakeIO();
    const app = makeApp();
    for (let index = 0; index < 40; index++) app.addNotice('OLD_HISTORY_' + index);
    const runtime = makeRuntime(app, io, [], []);
    const drain = async (): Promise<void> => {
      await new Promise<void>((resolve) => terminal.write(io.writes.splice(0).join(''), resolve));
    };
    const tools = ['Read', 'Write', 'Edit', 'ApplyPatch', 'ListDir', 'Glob', 'Grep'];
    const markdown = [
      '工具列表', '', '## 文件与搜索', '| 工具 | 用途 |', '|---|---|',
      ...tools.map((tool) => '| `' + tool + '` | 文件操作 |'),
      '', '## 执行', '| 工具 | 用途 |', '|---|---|', '| `Shell` | 执行命令 |',
      '', ...Array.from({ length: 20 }, (_, i) => '说明 ' + i),
    ].join('\n');
    try {
      runtime.start();
      await drain();
      // /clear adds its notice before rendering, so the runtime never sees an
      // empty transcript. A fast response can also arrive in that same frame.
      app.resetSession();
      app.addNotice('Session cleared');
      if (!coalesced) {
        runtime.render(true);
        await drain();
      }
      app.submitText('你有哪些Tools');
      app.handleEvent({ type: 'turn.started', turnId: 'table' });
      app.handleEvent({ type: 'text.delta', turnId: 'table', text: markdown });
      app.handleEvent({ type: 'turn.finished', turnId: 'table', status: 'done', usage: EMPTY_USAGE, durationMs: 1 });
      runtime.render(true);
      await drain();
      const text = Array.from({ length: terminal.buffer.active.length }, (_, i) =>
        terminal.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
      for (const label of ['工具列表', '文件与搜索']) {
        expect(text.split(label), label).toHaveLength(2);
      }
      for (const tool of [...tools, 'Shell']) {
        expect(text.match(new RegExp('│ ' + tool + ' +│', 'gu')), tool).toHaveLength(1);
      }
      expect(text).toMatch(/│ 工具\s+│ 用途/u);
      expect(text).not.toContain('OLD_HISTORY_');
      io.writes.length = 0;
      runtime.render(true);
      expect(io.writes.join('')).not.toContain('\x1b[3J');
      expect(io.writes.join('')).not.toContain('Read');
    } finally {
      runtime.stop();
      terminal.dispose();
    }
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

  it('fully repaints without ED2 when the terminal is resized', () => {
    const io = new FakeIO();
    const app = makeApp();
    const runtime = makeRuntime(app, io, [], []);
    runtime.start();
    app.addNotice('resize me');
    runtime.render(true);

    const before = io.writes.length;
    io.resizeHandler?.(120, 40);
    const output = io.writes.slice(before).join('');

    expect(app.state).toMatchObject({ width: 120, height: 40 });
    // A blank new front buffer would make the renderer skip blank cells and
    // leave content from the old layout on screen; repaint every cell without
    // ED2, which iTerm2 can copy into scrollback.
    expect(output).not.toContain('\x1b[2J');
    expect(output).toContain('\x1b[40;1H');
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
    expect(app.transcript.filter((cell) => cell.type === 'user').map((cell) => cell.text)).toEqual(['first']);
    expect(app.queue[0]?.submitted).toBe(false);
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

  it('moves the entire queue into the transcript at a step boundary and keeps the draft', async () => {
    const app = makeApp();
    const controller = new TuiSession({
      app, io: new FakeIO(), session: fakeSession,
      runTurn: async () => { throw new Error('must stay in the active turn'); },
    });
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    const running = controller.run();
    await flush();
    app.handleEvent({ type: 'text.delta', turnId: 't1', text: 'earlier output' });
    controller.runtime.feed('one\rtwo\rthree\rdraft');
    expect(app.transcript.filter((cell) => cell.type === 'user')).toHaveLength(0);
    expect(controller.takeQueuedPrompts()).toEqual(['one', 'two', 'three']);
    expect(app.queue).toHaveLength(0);
    expect(app.state.composer.text).toBe('draft');
    expect(app.transcript.filter((cell) => cell.type === 'user').map((cell) => cell.text)).toEqual(['one', 'two', 'three']);
    expect(app.transcript[0]?.type).toBe('assistant');
    expect(app.state.turnNumber).toBe(1);
    expect(controller.takeQueuedPrompts()).toEqual([]);
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

  it('bridges AskUserQuestion to the modal and settles on answers or abort', async () => {
    const io = new FakeIO();
    const app = makeApp();
    const controller = new TuiSession({
      app,
      io,
      session: fakeSession,
      runTurn: async () => ({ turnId: 't1', status: 'done', usage: EMPTY_USAGE, steps: 0, durationMs: 0 }),
    });
    const running = controller.run();
    await flush();

    const questions: AskQuestion[] = [
      { id: 'pick', question: 'Pick one', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
    ];
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    const answered = controller.ask(questions);
    expect(app.mode).toBe('ask');
    expect(app.status.state).toBe('awaiting');
    controller.runtime.feed('\r');
    await flush();
    await expect(answered).resolves.toEqual([{ id: 'pick', selected: ['A'] }]);
    expect(app.mode).toBe('main');

    const abort = new AbortController();
    const pending = controller.ask(questions, abort.signal);
    expect(app.mode).toBe('ask');
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(app.mode).toBe('main');

    controller.exit(0);
    await running;
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

  it('handles /clear by resetting the rollout, agent history and UI', async () => {
    const io = new FakeIO();
    const app = makeApp();
    let sessionCleared = 0;
    let agentCleared = 0;
    app.submitText('old prompt');
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    app.handleEvent({ type: 'turn.finished', turnId: 't1', status: 'done', usage: EMPTY_USAGE, durationMs: 1 });
    const session = {
      ...fakeSession,
      clear: async () => {
        sessionCleared += 1;
      },
    } as unknown as SessionHandle;
    const controller = new TuiSession({
      app,
      io,
      session,
      runTurn: async () => ({ turnId: 't2', status: 'done', usage: EMPTY_USAGE, steps: 0, durationMs: 0 }),
      onClear: () => {
        agentCleared += 1;
      },
    });
    const running = controller.run();
    await flush();

    controller.runtime.feed('/clear\r');
    await flush();

    expect(sessionCleared).toBe(1);
    expect(agentCleared).toBe(1);
    expect(app.transcript).toHaveLength(1);
    expect(app.transcript[0]).toMatchObject({ type: 'notice', level: 'info' });
    expect((app.transcript[0] as { text: string }).text).toMatch(/cleared/i);
    expect(app.state.turnNumber).toBe(0);
    expect(app.state.session.title).toBeUndefined();
    expect(app.state.usage).toEqual(EMPTY_USAGE);

    controller.runtime.feed('/quit\r');
    await expect(running).resolves.toBe(0);
  });

  it('refuses /clear while a turn is running', async () => {
    const io = new FakeIO();
    const app = makeApp();
    let sessionCleared = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = {
      ...fakeSession,
      clear: async () => {
        sessionCleared += 1;
      },
    } as unknown as SessionHandle;
    const controller = new TuiSession({
      app,
      io,
      session,
      runTurn: async () => {
        app.handleEvent({ type: 'turn.started', turnId: 't1' });
        await held;
        app.handleEvent({ type: 'turn.finished', turnId: 't1', status: 'aborted', usage: EMPTY_USAGE, durationMs: 1 });
        return { turnId: 't1', status: 'aborted', usage: EMPTY_USAGE, steps: 0, durationMs: 1 };
      },
      initialPrompt: 'long task',
    });
    const running = controller.run();
    await flush();

    controller.runtime.feed('/clear\r');
    await flush();
    expect(sessionCleared).toBe(0);
    expect(app.transcript.some((cell) => cell.type === 'notice' && cell.text.includes('while a turn is running'))).toBe(
      true,
    );

    release();
    await flush();
    controller.runtime.feed('/quit\r');
    await expect(running).resolves.toBe(0);
  });

  it('handles /model locally and updates the controller and session state', async () => {
    const io = new FakeIO();
    const app = makeApp();
    let selection: { model: string; reasoningEffort?: ReasoningEffort } = { model: 'm' };
    const updates: Array<{ model: string; reasoningEffort?: ReasoningEffort }> = [];
    const controller = new TuiSession({
      app,
      io,
      session: fakeSession,
      runTurn: async () => ({ turnId: 't1', status: 'done', usage: EMPTY_USAGE, steps: 0, durationMs: 0 }),
      model: {
        get: () => selection,
        set: (next) => {
          selection = next;
          updates.push(next);
        },
      },
    });
    const running = controller.run();
    await flush();

    controller.runtime.feed('/model --show\r');
    expect(
      app.transcript.some((cell) => cell.type === 'notice' && cell.text.includes('effort: default')),
    ).toBe(true);

    controller.runtime.feed('/model model-b --effort high\r');
    await flush();
    await flush();
    expect(updates).toEqual([{ model: 'model-b', reasoningEffort: 'high' }]);
    expect(app.state.session).toMatchObject({ model: 'model-b', reasoningEffort: 'high' });
    expect(app.transcript.some((cell) => cell.type === 'notice' && cell.text === 'Model set to model-b, effort: high.')).toBe(true);

    controller.runtime.feed('/model --effort default\r');
    await flush();
    await flush();
    expect(updates[1]).toEqual({ model: 'model-b' });
    expect(app.state.session.reasoningEffort).toBeUndefined();

    controller.runtime.feed('/quit\r');
    await expect(running).resolves.toBe(0);
  });

  it('selects model and effort atomically, supports custom models, cancellation and default', async () => {
    const app = makeApp();
    let selection: { model: string; reasoningEffort?: ReasoningEffort } = { model: 'm' };
    const updates: typeof selection[] = [];
    const controller = new TuiSession({
      app, io: new FakeIO(), session: fakeSession,
      runTurn: async () => { throw new Error('/model must not call the provider'); },
      model: {
        list: () => ['m', 'model-b', 'model-b'],
        get: () => selection,
        set: (next) => { selection = next; updates.push(next); },
      },
    });
    const running = controller.run();
    await flush();
    controller.runtime.feed('/model\r');
    expect(app.state.mode).toBe('ask');
    expect(app.state.ask?.questions[0]?.options.map((option) => option.label)).toEqual(['m', 'model-b']);
    controller.runtime.feed('2\r');
    expect(app.state.ask?.index).toBe(1);
    expect(updates).toEqual([]);
    controller.runtime.feed('\x1b'); // cancel after choosing a model
    await vi.waitFor(() => expect(app.state.mode).toBe('main'));
    expect(updates).toEqual([]);

    controller.runtime.feed('/model\r');
    controller.runtime.feed('2\r');
    controller.runtime.feed('4\r'); // high
    await flush();
    expect(updates).toEqual([{ model: 'model-b', reasoningEffort: 'high' }]);
    expect(app.state.session).toMatchObject(selection);

    controller.runtime.feed('/model\r');
    controller.runtime.feed('\x1b[A\r'); // Other
    controller.runtime.feed('custom-model\r');
    expect(updates).toHaveLength(1);
    controller.runtime.feed('2\r'); // default (current high is first)
    await flush();
    expect(updates[1]).toEqual({ model: 'custom-model' });
    expect(app.state.session.reasoningEffort).toBeUndefined();

    controller.runtime.feed('/model\r');
    controller.runtime.feed('\r'); // keep current model
    controller.runtime.feed('\x1b[A\r'); // Other effort
    controller.runtime.feed('turbo\r');
    await flush();
    expect(updates).toHaveLength(2);
    expect(app.transcript.some((cell) => cell.type === 'notice' && cell.text.includes('Unknown reasoning effort'))).toBe(true);

    controller.runtime.feed('/model\r');
    controller.exit(); // exiting a picker must not apply pending settings
    await expect(running).resolves.toBe(0);
    expect(updates).toHaveLength(2);
  });

  it('shows cross-provider candidates and submits the selected provider identity', async () => {
    const app = makeApp();
    const set = vi.fn((selection) => selection);
    const controller = new TuiSession({
      app, io: new FakeIO(), session: fakeSession,
      runTurn: async () => { throw new Error('unexpected turn'); },
      model: {
        list: () => [
          { model: 'same-model', provider: 'primary', route: 'default' },
          { model: 'same-model', provider: 'secondary', route: 'other' },
        ],
        get: () => ({ model: 'same-model', provider: 'primary', route: 'default' }), set,
      },
    });
    const running = controller.run();
    await flush();
    controller.runtime.feed('/model\r');
    expect(app.state.ask?.questions[0]?.options.map((option) => option.label)).toEqual([
      'same-model (primary)', 'same-model (secondary)',
    ]);
    controller.runtime.feed('2\r4\r');
    await flush();
    expect(set).toHaveBeenCalledWith({ model: 'same-model', provider: 'secondary', route: 'other', reasoningEffort: 'high' });
    expect(app.state.session.model).toBe('same-model');
    expect(app.transcript.some((cell) => cell.type === 'notice' && cell.text === 'Model set to same-model (secondary), effort: high.')).toBe(true);
    controller.exit();
    await expect(running).resolves.toBe(0);
  });

  it('keeps model settings when persisting a picker selection fails', async () => {
    const app = makeApp();
    const controller = new TuiSession({
      app, io: new FakeIO(), session: fakeSession,
      runTurn: async () => { throw new Error('unexpected turn'); },
      model: {
        list: () => ['model-b'], get: () => ({ model: 'test-model' }),
        set: async () => { throw new Error('rollout write failed'); },
      },
    });
    const running = controller.run();
    await flush();
    controller.runtime.feed('/model\r');
    controller.runtime.feed('2\r4\r');
    await flush();
    expect(app.state.session.model).toBe('test-model');
    expect(app.state.session.reasoningEffort).toBeUndefined();
    expect(app.transcript.some((cell) => cell.type === 'notice' && cell.text.includes('rollout write failed'))).toBe(true);
    controller.exit();
    await expect(running).resolves.toBe(0);
  });

  it.each(['select', 'cancel', 'save-error', 'permissions'])(
    'runs the next prompt after the idle picker closes: %s', async (action) => {
      const app = makeApp();
      const runTurn = vi.fn(async (): Promise<TurnResult> => {
        app.handleEvent({ type: 'turn.started', turnId: 't1' });
        app.handleEvent({ type: 'turn.finished', turnId: 't1', status: 'done', usage: EMPTY_USAGE, durationMs: 1 });
        return { turnId: 't1', status: 'done', usage: EMPTY_USAGE, durationMs: 1, steps: 1 };
      });
      const controller = new TuiSession({
        app, io: new FakeIO(), session: fakeSession, runTurn,
        model: {
          get: () => ({ model: 'test-model' }),
          set: () => { if (action === 'save-error') throw new Error('save failed'); },
        },
        permissions: {
          list: () => [':workspace'],
          current: () => ({ profile: ':workspace', approvalPolicy: 'on-request' }),
          set: async () => {},
        },
      });
      const running = controller.run();
      await flush();
      controller.runtime.feed(action === 'permissions' ? '/permissions\r' : '/model\r');
      if (action === 'cancel') {
        controller.runtime.feed('\x1b');
        await vi.waitFor(() => expect(app.status.state).toBe('idle'));
      } else {
        controller.runtime.feed(action === 'permissions' ? '\r' : '\r\r');
      }
      await flush();
      expect(app.status.state).toBe('idle');
      controller.runtime.feed('hello\r');
      await flush();
      expect(runTurn).toHaveBeenCalledExactlyOnceWith('hello', expect.any(AbortSignal));
      expect(app.queue).toHaveLength(0);
      controller.exit();
      await expect(running).resolves.toBe(0);
    },
  );

  it('waits for model persistence then consumes input queued during the switch', async () => {
    const app = makeApp();
    let release!: () => void;
    const saved = new Promise<void>((resolve) => { release = resolve; });
    let model = 'old-model';
    const requests: string[] = [];
    const controller = new TuiSession({
      app, io: new FakeIO(), session: fakeSession,
      model: {
        get: () => ({ model }), list: () => ['next-model'],
        set: async (selection) => { await saved; model = selection.model; },
      },
      runTurn: async () => {
        requests.push(model);
        app.handleEvent({ type: 'turn.started', turnId: 't1' });
        app.handleEvent({ type: 'turn.finished', turnId: 't1', status: 'done', usage: EMPTY_USAGE, durationMs: 1 });
        return { turnId: 't1', status: 'done', usage: EMPTY_USAGE, durationMs: 1, steps: 1 };
      },
    });
    const running = controller.run();
    await flush();
    controller.runtime.feed('/model\r2\r1\rhello\r');
    await flush();
    expect(requests).toEqual([]);
    expect(app.queue.map((item) => item.text)).toEqual(['hello']);
    release();
    await flush();
    expect(requests).toEqual(['next-model']);
    expect(app.queue).toEqual([]);
    controller.exit();
    await expect(running).resolves.toBe(0);
  });

  it('refuses /model changes while a turn is running', async () => {
    const io = new FakeIO();
    const app = makeApp();
    let updates = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new TuiSession({
      app,
      io,
      session: fakeSession,
      runTurn: async () => {
        app.handleEvent({ type: 'turn.started', turnId: 't1' });
        await held;
        app.handleEvent({ type: 'turn.finished', turnId: 't1', status: 'aborted', usage: EMPTY_USAGE, durationMs: 1 });
        return { turnId: 't1', status: 'aborted', usage: EMPTY_USAGE, steps: 0, durationMs: 1 };
      },
      model: {
        get: () => ({ model: 'm' }),
        set: () => {
          updates += 1;
        },
      },
      initialPrompt: 'long task',
    });
    const running = controller.run();
    await flush();

    controller.runtime.feed('/model model-b high\r');
    controller.runtime.feed('/model\r');
    await flush();
    expect(app.state.mode).not.toBe('ask');
    expect(updates).toBe(0);
    expect(
      app.transcript.some(
        (cell) => cell.type === 'notice' && cell.text.includes('while a turn is running'),
      ),
    ).toBe(true);

    release();
    await flush();
    controller.runtime.feed('/quit\r');
    await expect(running).resolves.toBe(0);
  });
});
