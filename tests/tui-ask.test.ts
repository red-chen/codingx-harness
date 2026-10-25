import { describe, expect, it } from 'vitest';
import type { AskQuestion } from '../src/tools/types.js';
import { TuiApp } from '../src/tui/state/app.js';
import type { KeyEvent, KeyMods } from '../src/tui/terminal/input.js';
import type { CellBuffer } from '../src/tui/terminal/buffer.js';
import { statusLabel } from '../src/tui/widgets/status.js';
import { askPanelHeight } from '../src/tui/widgets/ask.js';

const SESSION = { sessionId: 'abcdefghijkl', cwd: '/tmp/work', model: 'test-model' };
const NO_MODS: KeyMods = { ctrl: false, alt: false, shift: false, meta: false };

const QUESTIONS: AskQuestion[] = [
  {
    id: 'approach',
    header: 'Plan',
    question: 'Which approach should I use?',
    multiSelect: false,
    options: [
      { label: 'Fast', description: 'Change one file.' },
      { label: 'Safe', description: 'Add tests first.' },
    ],
  },
];

function makeApp(width = 80, height = 24): TuiApp {
  return new TuiApp({ session: SESSION, version: '0.1.0', width, height, now: () => 1000 });
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

function shown(questions: AskQuestion[] = QUESTIONS): TuiApp {
  const app = makeApp();
  app.handleEvent({ type: 'turn.started', turnId: 't1' });
  app.showQuestion(questions);
  return app;
}

describe('TuiApp ask overlay', () => {
  it('opens an awaiting modal and renders the question, options and keys', () => {
    const app = shown();
    expect(app.mode).toBe('ask');
    expect(app.status).toMatchObject({ state: 'awaiting', turnId: 't1' });

    const screen = screenText(app.frame());
    expect(screen).toContain('Ask user');
    expect(screen).toContain('Plan');
    expect(screen).toContain('Which approach should I use?');
    expect(screen).toContain('Fast');
    expect(screen).toContain('Safe');
    expect(screen).toContain('Other');
    expect(screen).toContain('Esc cancel');
  });

  it('selects the highlighted option with Enter and returns an answer command', () => {
    const app = shown();
    const command = app.handleKey(key('enter'));
    expect(command).toEqual({
      type: 'answer',
      answers: [{ id: 'approach', selected: ['Fast'] }],
    });
    expect(app.mode).toBe('main');
    expect(app.state.ask).toBeUndefined();
    expect(app.status.state).toBe('working');
  });

  it('supports arrow keys and digit shortcuts', () => {
    const app = shown();
    app.handleKey(key('down'));
    expect(app.state.ask?.optionIndex).toBe(1);
    app.handleKey(printable('2'));
    expect(app.state.ask?.selections).toEqual([['Safe']]);
    expect(app.handleKey(key('enter'))).toEqual({
      type: 'answer',
      answers: [{ id: 'approach', selected: ['Safe'] }],
    });
  });

  it('collects a custom answer through the Other row', () => {
    const app = shown();
    app.handleKey(key('down'));
    app.handleKey(key('down'));
    expect(app.state.ask?.optionIndex).toBe(2);
    expect(app.handleKey(key('enter'))).toBeUndefined();
    expect(app.state.ask?.editing).toBe(true);

    typeText(app, 'Ship it');
    expect(app.state.ask?.custom).toEqual(['Ship it']);
    const command = app.handleKey(key('enter'));
    expect(command).toEqual({
      type: 'answer',
      answers: [{ id: 'approach', selected: [], custom: 'Ship it' }],
    });
  });

  it('handles multi-select questions and advances between questions', () => {
    const app = shown([
      {
        id: 'files',
        question: 'Which files should change?',
        multiSelect: true,
        options: [{ label: 'src' }, { label: 'tests' }, { label: 'docs' }],
      },
      {
        id: 'why',
        question: 'Why now?',
        multiSelect: false,
        options: [{ label: 'Bug' }, { label: 'Feature' }],
      },
    ]);

    app.handleKey(key('space'));
    app.handleKey(key('down'));
    app.handleKey(key('space'));
    expect(app.state.ask?.selections).toEqual([['src', 'tests'], []]);
    expect(app.handleKey(key('enter'))).toBeUndefined();
    expect(app.state.ask?.index).toBe(1);
    expect(app.mode).toBe('ask');

    app.handleKey(key('space'));
    expect(app.handleKey(key('enter'))).toEqual({
      type: 'answer',
      answers: [
        { id: 'files', selected: ['src', 'tests'] },
        { id: 'why', selected: ['Bug'] },
      ],
    });
  });

  it('keeps answers when going back to a previous question', () => {
    const app = shown([
      { id: 'one', question: 'First?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'two', question: 'Second?', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] },
    ]);
    app.handleKey(key('enter'));
    expect(app.state.ask?.index).toBe(1);
    app.handleKey(key('left'));
    expect(app.state.ask?.index).toBe(0);
    expect(app.state.ask?.selections[0]).toEqual(['A']);
    app.handleKey(key('enter'));
    expect(app.state.ask?.index).toBe(1);
  });

  it('accepts free-text answers when no options are given', () => {
    const app = shown([{ id: 'notes', question: 'Anything else?', multiSelect: false }]);
    expect(app.state.ask?.editing).toBe(true);
    typeText(app, 'Keep the API stable');
    expect(app.handleKey(key('enter'))).toEqual({
      type: 'answer',
      answers: [{ id: 'notes', selected: [], custom: 'Keep the API stable' }],
    });
  });

  it('cancels the question on Esc and interrupts the turn on Ctrl+C', () => {
    const dismissed = shown();
    expect(dismissed.handleKey(key('escape'))).toEqual({ type: 'cancel-ask' });
    expect(dismissed.mode).toBe('main');
    expect(dismissed.status.state).toBe('working');

    const interrupted = shown();
    expect(interrupted.handleKey(key('c', { ctrl: true }))).toEqual({ type: 'interrupt' });
  });

  it('closes the modal if the turn finishes while it is open', () => {
    const app = shown();
    app.handleEvent({
      type: 'turn.finished',
      turnId: 't1',
      status: 'error',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      durationMs: 10,
      error: { code: 'ABORTED', message: 'turn aborted' },
    });
    expect(app.mode).toBe('main');
    expect(app.state.ask).toBeUndefined();
    expect(app.status.state).toBe('idle');
  });

  it('renders without crashing on narrow and short terminals', () => {
    const app = makeApp(30, 10);
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    app.showQuestion(QUESTIONS);
    const screen = screenText(app.frame(30, 10));
    expect(screen).toContain('Ask user');
    expect(askPanelHeight(app.state.ask as NonNullable<typeof app.state.ask>, 30)).toBeGreaterThan(1);
  });

  it('labels the status row as awaiting an answer', () => {
    const label = statusLabel({ state: 'awaiting', startedAt: 1000, elapsedMs: 0 }, 5000, 80);
    expect(label).toContain('Awaiting answer');
  });
});
