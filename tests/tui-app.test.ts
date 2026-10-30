import { describe, expect, it } from 'vitest';
import { TuiApp } from '../src/tui/state/app.js';
import type { KeyEvent, KeyMods } from '../src/tui/terminal/input.js';
import type { CellBuffer } from '../src/tui/terminal/buffer.js';
import type { TokenUsage } from '../src/providers/types.js';

const SESSION = { sessionId: 'abcdefghijkl', cwd: '/tmp/work', model: 'test-model' };
const NO_MODS: KeyMods = { ctrl: false, alt: false, shift: false, meta: false };
const USAGE: TokenUsage = {
  inputTokens: 1200,
  outputTokens: 345,
  cacheReadTokens: 67,
  cacheCreationTokens: 0,
};

function makeApp(now: () => number = () => 1000): TuiApp {
  return new TuiApp({ session: SESSION, version: '0.1.0', width: 80, height: 24, now });
}

function key(code: string, mods: Partial<KeyMods> = {}, text?: string): KeyEvent {
  return {
    type: 'key',
    code,
    mods: { ...NO_MODS, ...mods },
    ...(text === undefined ? {} : { text }),
  };
}

function printable(text: string): KeyEvent {
  const code = text === ' ' ? 'space' : text.toLowerCase();
  return key(code, /[A-Z]/u.test(text) ? { shift: true } : {}, text);
}

function typeText(app: TuiApp, text: string): void {
  for (const char of text) app.handleKey(printable(char));
}

function ctrl(app: TuiApp, code: string): ReturnType<TuiApp['handleKey']> {
  return app.handleKey(key(code, { ctrl: true }));
}

function shift(app: TuiApp, code: string): ReturnType<TuiApp['handleKey']> {
  return app.handleKey(key(code, { shift: true }));
}

function enter(app: TuiApp): ReturnType<TuiApp['handleKey']> {
  return app.handleKey(key('enter'));
}

function rowText(buffer: CellBuffer, y: number): string {
  let text = '';
  for (let x = 0; x < buffer.width; x++) {
    const cell = buffer.get(x, y);
    if (cell === undefined || cell.width === 0) continue;
    text += cell.symbol;
  }
  return text.replace(/ +$/u, '');
}

function screenText(buffer: CellBuffer): string {
  const rows: string[] = [];
  for (let y = 0; y < buffer.height; y++) rows.push(rowText(buffer, y));
  return rows.join('\n');
}

describe('TuiApp state transitions', () => {
  it('starts in main mode with an empty transcript and idle status', () => {
    const app = makeApp();
    expect(app.state.mode).toBe('main');
    expect(app.state.session).toEqual(SESSION);
    expect(app.state.version).toBe('0.1.0');
    expect(app.state.width).toBe(80);
    expect(app.state.height).toBe(24);
    expect(app.state.transcript).toEqual([]);
    expect(app.state.activeAssistant).toBeNull();
    expect(app.state.queue).toEqual([]);
    expect(app.state.status).toMatchObject({ state: 'idle', elapsedMs: 0 });
    expect(app.composer.text).toBe('');
  });

  it('updates session fields from session.info', () => {
    const app = makeApp();
    app.handleEvent({
      type: 'session.info',
      session: { sessionId: 'zzzzzzzzzzzz', cwd: '/repo', model: 'other-model' },
    });
    expect(app.state.session).toEqual({ sessionId: 'zzzzzzzzzzzz', cwd: '/repo', model: 'other-model' });
  });

  it('updates model and effort state and preserves them on clear', () => {
    const app = makeApp();
    app.setModel('next-model', 'high');
    expect(app.state.session).toMatchObject({ model: 'next-model', reasoningEffort: 'high' });

    app.handleEvent({
      type: 'session.info',
      session: { sessionId: 'zzzzzzzzzzzz', cwd: '/repo', model: 'info-model' },
    });
    expect(app.state.session).toMatchObject({ model: 'info-model', reasoningEffort: 'high' });

    app.setModel('next-model');
    expect(app.state.session.model).toBe('next-model');
    expect(app.state.session.reasoningEffort).toBeUndefined();

    app.setModel('final-model', 'low');
    app.resetSession();
    expect(app.state.session).toMatchObject({ model: 'final-model', reasoningEffort: 'low' });
  });

  it('resets session-scoped state while keeping identity and composer history', () => {
    const app = makeApp();
    app.submitText('first task');
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    app.handleEvent({ type: 'text.delta', turnId: 't1', text: 'working' });
    app.handleEvent({ type: 'plan.updated', turnId: 't1', steps: [{ step: 'do it', status: 'in_progress' }] });
    app.handleEvent({ type: 'context.updated', turnId: 't1', usedTokens: 1234, windowTokens: 200_000, steps: 2 });
    app.handleEvent({ type: 'turn.finished', turnId: 't1', status: 'done', usage: USAGE, durationMs: 10 });
    app.enqueue('queued task');
    app.openHelp();

    app.resetSession();

    expect(app.state.mode).toBe('main');
    expect(app.state.session).toEqual(SESSION);
    expect(app.state.transcript).toEqual([]);
    expect(app.state.activeAssistant).toBeNull();
    expect(app.state.plan).toEqual([]);
    expect(app.state.queue).toEqual([]);
    expect(app.state.status).toMatchObject({ state: 'idle', elapsedMs: 0 });
    expect(app.state.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(app.state.totalUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(app.state.turnNumber).toBe(0);
    expect(app.state.currentTurnSteps).toBe(0);
    expect(app.state.contextUsedTokens).toBe(0);
    expect(app.state.contextWindowTokens).toBe(200_000);
    expect(app.state.contextPercent).toBeUndefined();
    expect(app.composer.text).toBe('');
    expect(app.composer.history).toEqual(['first task']);
  });

  it('moves to working on turn.started and records the injected clock', () => {
    const app = makeApp(() => 5000);
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    expect(app.status).toMatchObject({ state: 'working', turnId: 't1', startedAt: 5000, elapsedMs: 0 });
    expect(app.state.activeAssistant?.turnId).toBe('t1');
    expect(app.state.activeAssistant?.text).toBe('');
  });

  it('accumulates text.delta in the active cell without adding history', () => {
    const app = makeApp();
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    app.handleEvent({ type: 'text.delta', turnId: 't1', text: 'hello ' });
    app.handleEvent({ type: 'text.delta', turnId: 't1', text: 'world' });
    expect(app.state.activeAssistant?.text).toBe('hello world');
    expect(app.transcript).toEqual([]);
  });

  it('finalizes the active cell and status on a done turn', () => {
    const app = makeApp();
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    app.handleEvent({ type: 'text.delta', turnId: 't1', text: 'done text' });
    app.handleEvent({ type: 'turn.finished', turnId: 't1', status: 'done', usage: USAGE, durationMs: 1234 });
    expect(app.state.activeAssistant).toBeNull();
    expect(app.transcript).toHaveLength(2);
    expect(app.transcript[0]).toMatchObject({ type: 'assistant', text: 'done text' });
    expect(app.transcript[1]).toMatchObject({
      type: 'turn',
      outcome: 'done',
      durationMs: 1234,
      usage: USAGE,
    });
    expect((app.transcript[1] as { completedAt: number }).completedAt).toBe(1000);
    expect(app.status).toMatchObject({ state: 'idle', outcome: 'done', elapsedMs: 1234 });
    expect(app.state.usage).toEqual(USAGE);
  });

  it('turns an error message into a notice cell and an error status', () => {
    const app = makeApp();
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    app.handleEvent({ type: 'text.delta', turnId: 't1', text: 'partial' });
    app.handleEvent({
      type: 'turn.finished',
      turnId: 't1',
      status: 'error',
      usage: USAGE,
      durationMs: 20,
      error: { code: 'E_PROVIDER', message: 'boom' },
    });
    expect(app.transcript.map((cell) => cell.type)).toEqual(['assistant', 'notice', 'turn']);
    const notice = app.transcript[1];
    expect(notice).toMatchObject({ type: 'notice', level: 'error', text: 'E_PROVIDER: boom' });
    expect(app.status).toMatchObject({ state: 'idle', outcome: 'error', elapsedMs: 20 });
    expect(app.status.error).toEqual({ code: 'E_PROVIDER', message: 'boom' });
  });

  it('records aborted turns without appending an empty assistant cell', () => {
    const app = makeApp();
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    app.handleEvent({ type: 'turn.finished', turnId: 't1', status: 'aborted', usage: USAGE, durationMs: 7 });
    expect(app.transcript).toHaveLength(1);
    expect(app.transcript[0]).toMatchObject({ type: 'turn', outcome: 'aborted', durationMs: 7 });
    expect(app.status).toMatchObject({ state: 'idle', outcome: 'aborted', elapsedMs: 7 });
  });

  it('tool.started flushes streamed text and tool.finished updates the same exec cell', () => {
    const app = makeApp();
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    app.handleEvent({ type: 'text.delta', turnId: 't1', text: 'I will look.' });
    app.handleEvent({
      type: 'tool.started',
      turnId: 't1',
      call: { id: 'call-1', name: 'Shell', input: { command: 'ls -la' } },
    });
    expect(app.transcript.map((cell) => cell.type)).toEqual(['assistant', 'exec']);
    const started = app.transcript[1];
    expect(started).toMatchObject({
      type: 'exec',
      callId: 'call-1',
      command: 'ls -la',
      output: '',
      running: true,
    });

    app.handleEvent({
      type: 'tool.finished',
      turnId: 't1',
      callId: 'call-1',
      name: 'Shell',
      result: { content: 'a.txt\nb.txt', isError: false },
      durationMs: 12,
    });
    expect(app.transcript).toHaveLength(2);
    expect(app.transcript[1]).toMatchObject({
      type: 'exec',
      command: 'ls -la',
      output: 'a.txt\nb.txt',
      running: false,
      durationMs: 12,
    });
  });

  it('tool.finished without tool.started still records a completed exec cell', () => {
    const app = makeApp();
    app.handleEvent({
      type: 'tool.finished',
      turnId: 't1',
      callId: 'orphan',
      name: 'Read',
      result: { content: 'data', isError: true },
      durationMs: 3,
    });
    expect(app.transcript).toHaveLength(1);
    expect(app.transcript[0]).toMatchObject({
      type: 'exec',
      callId: 'orphan',
      command: 'Read',
      isError: true,
      running: false,
    });
  });

  it('plan.updated stores the latest plan and appends plan cells', () => {
    const app = makeApp();
    app.handleEvent({
      type: 'plan.updated',
      turnId: 't1',
      steps: [
        { step: 'inspect', status: 'completed' },
        { step: 'implement', status: 'in_progress' },
      ],
    });
    expect(app.state.plan).toEqual([
      { step: 'inspect', status: 'completed' },
      { step: 'implement', status: 'in_progress' },
    ]);
    expect(app.transcript).toHaveLength(1);
    expect(app.transcript[0]?.type).toBe('plan');

    app.handleEvent({
      type: 'plan.updated',
      turnId: 't1',
      steps: [{ step: 'verify', status: 'pending' }],
    });
    expect(app.state.plan).toEqual([{ step: 'verify', status: 'pending' }]);
    expect(app.transcript.map((cell) => cell.type)).toEqual(['plan', 'plan']);
  });

  it('copies usage from usage.updated and turn.finished', () => {
    const app = makeApp();
    app.handleEvent({ type: 'usage.updated', turnId: 't1', usage: { ...USAGE, outputTokens: 1 } });
    expect(app.state.usage.outputTokens).toBe(1);
    app.handleEvent({ type: 'turn.finished', turnId: 't1', status: 'done', usage: USAGE, durationMs: 1 });
    expect(app.state.usage).toEqual(USAGE);
    expect(app.state.usage).not.toBe(USAGE);
  });
});

describe('TuiApp composer and commands', () => {
  it('submits non-empty text, appends the user cell and clears the composer', () => {
    const app = makeApp();
    typeText(app, 'make it work');
    const command = enter(app);
    expect(command).toEqual({ type: 'submit', text: 'make it work' });
    expect(app.composer.text).toBe('');
    expect(app.composer.cursor).toBe(0);
    expect(app.transcript).toHaveLength(1);
    expect(app.transcript[0]).toMatchObject({ type: 'user', text: 'make it work' });
    expect(app.composer.history).toEqual(['make it work']);
  });

  it('refuses to submit whitespace-only input', () => {
    const app = makeApp();
    typeText(app, '   ');
    expect(enter(app)).toBeUndefined();
    expect(app.transcript).toEqual([]);
    expect(app.composer.text).toBe('   ');
  });

  it('inserts newlines for Shift+Enter and Ctrl+J', () => {
    const app = makeApp();
    typeText(app, 'ab');
    expect(shift(app, 'enter')).toBeUndefined();
    typeText(app, 'cd');
    expect(app.composer.text).toBe('ab\ncd');
    expect(ctrl(app, 'j')).toBeUndefined();
    expect(app.composer.text).toBe('ab\ncd\n');
    expect(app.transcript).toEqual([]);
  });

  it('edits with arrows, backspace/delete, home/end and Ctrl+A/E', () => {
    const app = makeApp();
    typeText(app, 'hello');
    expect(app.composer.cursor).toBe(5);
    app.handleKey(key('left'));
    expect(app.composer.cursor).toBe(4);
    app.handleKey(key('backspace'));
    expect(app.composer.text).toBe('helo');
    app.handleKey(key('home'));
    expect(app.composer.cursor).toBe(0);
    app.handleKey(key('delete'));
    expect(app.composer.text).toBe('elo');
    app.handleKey(key('end'));
    expect(app.composer.cursor).toBe(3);
    expect(ctrl(app, 'a')).toBeUndefined();
    expect(app.composer.cursor).toBe(0);

    typeText(app, 'xy');
    ctrl(app, 'e');
    expect(app.composer.cursor).toBe(app.composer.text.length);
  });

  it('supports Ctrl+W, Ctrl+K and Ctrl+U line deletion', () => {
    const word = makeApp();
    typeText(word, 'hello world');
    ctrl(word, 'w');
    expect(word.composer.text).toBe('hello ');

    const end = makeApp();
    typeText(end, 'abcdef');
    ctrl(end, 'a');
    appMoveRight(end, 3);
    ctrl(end, 'k');
    expect(end.composer.text).toBe('abc');

    const start = makeApp();
    typeText(start, 'abcdef');
    ctrl(start, 'a');
    appMoveRight(start, 3);
    ctrl(start, 'u');
    expect(start.composer.text).toBe('def');
  });

  it('browses submitted history with Up/Down', () => {
    const app = makeApp();
    typeText(app, 'alpha');
    enter(app);
    typeText(app, 'beta');
    enter(app);
    app.handleKey(key('up'));
    expect(app.composer.text).toBe('beta');
    app.handleKey(key('up'));
    expect(app.composer.text).toBe('alpha');
    app.handleKey(key('down'));
    expect(app.composer.text).toBe('beta');
    app.handleKey(key('down'));
    expect(app.composer.text).toBe('');
  });

  it('returns interrupt for Esc/Ctrl+C during a turn without clearing it locally', () => {
    const app = makeApp();
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    app.handleEvent({ type: 'text.delta', turnId: 't1', text: 'partial' });
    expect(app.handleKey(key('escape'))).toEqual({ type: 'interrupt' });
    expect(app.status.state).toBe('working');
    expect(app.state.activeAssistant?.text).toBe('partial');
    expect(ctrl(app, 'c')).toEqual({ type: 'interrupt' });
    expect(app.transcript).toEqual([]);
  });

  it('ignores Esc while idle', () => {
    const app = makeApp();
    expect(app.handleKey(key('escape'))).toBeUndefined();
    expect(ctrl(app, 'c')).toBeUndefined();
  });

  it('queues the composer on Tab while working and never auto-submits', () => {
    const idle = makeApp();
    typeText(idle, 'not yet');
    expect(idle.handleKey(key('tab'))).toBeUndefined();
    expect(idle.queue).toEqual([]);
    expect(idle.composer.text).toBe('not yet');

    const app = makeApp();
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    typeText(app, 'later');
    expect(app.handleKey(key('tab'))).toBeUndefined();
    expect(app.queue).toHaveLength(1);
    expect(app.queue[0]?.text).toBe('later');
    expect(app.composer.text).toBe('');
    expect(app.transcript).toEqual([]);

    typeText(app, 'second');
    app.handleKey(key('tab'));
    expect(app.queue.map((item) => item.text)).toEqual(['later', 'second']);
    expect(app.transcript).toEqual([]);
  });

  it('keeps multi-line cursor movement intact when the composer is not empty', () => {
    const app = makeApp();
    typeText(app, 'abc');
    ctrl(app, 'j');
    typeText(app, 'def');
    expect(app.composer.cursor).toBe(7);
    app.handleKey(key('up'));
    expect(app.composer.cursor).toBe(3);
    app.handleKey(key('down'));
    expect(app.composer.cursor).toBe(7);
  });

  it('never splits emoji or CJK graphemes while editing', () => {
    const app = makeApp();
    typeText(app, 'a👩‍💻b');
    app.handleKey(key('backspace'));
    expect(app.composer.text).toBe('a👩‍💻');
    app.handleKey(key('left'));
    app.handleKey(key('backspace'));
    expect(app.composer.text).toBe('👩‍💻');
    app.handleKey(key('delete'));
    expect(app.composer.text).toBe('');
  });
});

describe('TuiApp modes, scrolling and frames', () => {
  it('toggles transcript mode, ignores submit there and closes with q', () => {
    const app = makeApp();
    typeText(app, 'draft');
    expect(ctrl(app, 't')).toBeUndefined();
    expect(app.mode).toBe('transcript');
    typeText(app, 'ish');
    expect(app.composer.text).toBe('draft');
    expect(enter(app)).toBeUndefined();
    expect(app.mode).toBe('transcript');
    app.handleKey(printable('q'));
    expect(app.mode).toBe('main');
  });

  it('opens help with ? and closes with q or escape', () => {
    const app = makeApp();
    expect(app.handleKey(printable('?'))).toBeUndefined();
    expect(app.mode).toBe('help');
    expect(enter(app)).toBeUndefined();
    expect(app.mode).toBe('help');
    app.handleKey(printable('q'));
    expect(app.mode).toBe('main');

    app.handleKey(printable('?'));
    app.handleKey(key('escape'));
    expect(app.mode).toBe('main');

    typeText(app, 'text');
    app.handleKey(printable('?'));
    expect(app.mode).toBe('main');
    expect(app.composer.text).toBe('text?');
  });

  it('scrolls with PgUp/PgDn and Shift+Up/Down inside the content bounds', () => {
    const app = makeApp();
    for (let index = 0; index < 60; index++) {
      typeText(app, 'history message ' + index);
      enter(app);
    }
    app.handleKey(key('pageup'));
    expect(app.state.scroll.offset).toBe(12);
    const scrolled = screenText(app.renderFrame());
    expect(scrolled).not.toContain('history message 59');
    expect(scrolled).toMatch(/history message\s+\d+/u);
    shift(app, 'up');
    expect(app.state.scroll.offset).toBe(13);
    shift(app, 'down');
    expect(app.state.scroll.offset).toBe(12);
    app.handleKey(key('pagedown'));
    expect(app.state.scroll.offset).toBe(0);
    app.handleKey(key('pagedown'));
    expect(app.state.scroll.offset).toBe(0);
  });

  it('can scroll all the way back to the welcome card and first history block', () => {
    const app = makeApp();
    for (let index = 0; index < 60; index++) {
      typeText(app, 'history message ' + index);
      enter(app);
    }
    app.scrollUp(100_000);
    const text = screenText(app.renderFrame());
    expect(text).toContain('_ codingx');
    expect(text).toContain('history message 0');
    expect(text).not.toContain('history message 59');
  });

  it('keeps a short transcript visible when trying to scroll past it', () => {
    const app = makeApp();
    typeText(app, 'only message');
    enter(app);
    app.handleKey(key('pageup'));
    expect(app.state.scroll.offset).toBe(0);
    expect(screenText(app.renderFrame())).toContain('only message');
  });

  it('exports transcript text and the last assistant message for copying', () => {
    const app = makeApp();
    typeText(app, 'question');
    enter(app);
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    app.handleEvent({ type: 'text.delta', turnId: 't1', text: 'final answer' });
    app.handleEvent({ type: 'turn.finished', turnId: 't1', status: 'done', usage: USAGE, durationMs: 10 });
    app.addNotice('a notice');
    const text = app.transcriptText();
    expect(text).toContain('› question');
    expect(text).toContain('final answer');
    expect(text).toContain('a notice');
    expect(text).toContain('✓ turn done');
    expect(app.lastAssistantText()).toBe('final answer');
    expect(app.copyText('status')).toContain('Ready');
    expect(app.copyText('status')).toContain('ctx 0/1m');
    expect(app.copyText('meta')).toContain('test-model');
    expect(app.copyText('meta')).toContain('/tmp/work');
    typeText(app, 'draft input');
    expect(app.copyText('input')).toBe('draft input');
    expect(app.copyText('screen')).toContain('_ codingx');
    const all = app.copyText('all');
    expect(all).toContain('== Transcript ==');
    expect(all).toContain('== StatusRow ==');
    expect(all).toContain('== Composer ==');
    expect(all).toContain('== MetaBar ==');
  });

  it('resizes the viewport and renders a full 80x24 frame', () => {
    const app = makeApp();
    const frame = app.renderFrame();
    expect(frame.width).toBe(80);
    expect(frame.height).toBe(24);
    const text = screenText(frame);
    expect(text).toContain('codingx (v0.1.0)');
    expect(text).toContain('model: test-model');
    expect(text).toContain('directory: /tmp/work');
    expect(text).toContain('session: abcdefghijkl');
    expect(rowText(frame, 18)).toContain('Ready');
    expect(rowText(frame, 21)).toContain('› Ask codingx to do anything');
    expect(rowText(frame, 23)).toContain('test-model');
    expect(rowText(frame, 23)).toContain('New session');

    app.setSize(120, 40);
    const wide = app.frame();
    expect(wide.width).toBe(120);
    expect(wide.height).toBe(40);
  });

  it('renders streamed text, queued input and elapsed working time', () => {
    let clock = 1000;
    const app = makeApp(() => clock);
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    clock = 13000;
    app.handleEvent({ type: 'text.delta', turnId: 't1', text: 'answering now' });
    typeText(app, 'question');
    enter(app);
    const text = screenText(app.renderFrame());
    expect(text).toContain('↳ question');
    expect(text).not.toContain('› question');
    expect(text).toContain('• answering now');
    expect(text).toContain('Working (12s');
    expect(text).toContain('esc to interrupt');
  });

  it('shows context token usage in the status row and a turn summary', () => {
    const app = new TuiApp({
      session: SESSION,
      version: '0.1.0',
      width: 120,
      height: 40,
      now: () => 1000,
      contextPercent: 72,
    });
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    app.handleEvent({
      type: 'context.updated',
      turnId: 't1',
      usedTokens: 280_000,
      windowTokens: 1_000_000,
      steps: 1,
    });
    app.handleEvent({ type: 'turn.finished', turnId: 't1', status: 'done', usage: USAGE, durationMs: 2000 });
    const frame = app.renderFrame();
    expect(rowText(frame, 34)).toContain('ctx 280k/1m');
    expect(rowText(frame, 37)).toContain('› Ask codingx to do anything');
    expect(app.state.contextUsedTokens).toBe(280_000);
    expect(app.state.contextWindowTokens).toBe(1_000_000);
    expect(rowText(frame, 39)).toContain('test-model');
    expect(rowText(frame, 39)).toContain('New session');
    app.setContextPercent(40);
    expect(app.state.contextPercent).toBe(40);
  });
});

function appMoveRight(app: TuiApp, count: number): void {
  for (let index = 0; index < count; index++) app.handleKey(key('right'));
}

describe('input recall and search', () => {
  it('limits history to 200 and restores a draft after browsing', () => {
    const saved: string[] = [];
    const app = new TuiApp({ session: SESSION, version: 'test',
      inputHistory: Array.from({ length: 205 }, (_, i) => 'entry ' + i),
      onInputHistory: (text) => saved.push(text),
    });
    expect(app.composer.history).toHaveLength(200);
    typeText(app, 'draft');
    app.handleKey(key('up'));
    expect(app.composer.text).toBe('entry 204');
    app.handleKey(key('down'));
    expect(app.composer.text).toBe('draft');
    enter(app);
    expect(saved).toEqual(['draft']);
    expect(app.composer.history).toHaveLength(200);
    expect(app.composer.history[0]).toBe('entry 6');
  });

  it('searches newest first, accepts without submitting and cancels to the original cursor', () => {
    const app = new TuiApp({ session: SESSION, version: 'test', inputHistory: ['old APPLE', '/apple', 'other'] });
    typeText(app, 'draft');
    app.handleKey(key('left'));
    ctrl(app, 'r');
    typeText(app, 'apple');
    expect(app.composer.text).toBe('/apple');
    expect(app.slashMenu).toEqual([]);
    expect(screenText(app.frame())).toContain('Ctrl+R search: apple');
    ctrl(app, 'r');
    expect(app.composer.text).toBe('old APPLE');
    ctrl(app, 'r');
    expect(screenText(app.frame())).toContain('No match: apple');
    app.handleKey(key('escape'));
    expect(app.composer.text).toBe('draft');
    expect(app.composer.cursor).toBe(4);
    ctrl(app, 'r');
    typeText(app, 'applex');
    expect(app.composer.search?.index).toBe(-1);
    app.handleKey(key('backspace'));
    expect(app.composer.text).toBe('/apple');
    expect(enter(app)).toBeUndefined();
    expect(app.composer.search).toBeUndefined();
    expect(app.composer.text).toBe('/apple');
    expect(app.transcript).toEqual([]);
  });
});
