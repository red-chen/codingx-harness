import { describe, expect, it } from 'vitest';
import { TuiApp, type CellBuffer } from '../src/tui/index.js';
import { slashMatches } from '../src/tui/state/slash.js';

function key(code: string, text?: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) {
  return {
    type: 'key' as const,
    code,
    ...(text === undefined ? {} : { text }),
    mods: { ctrl: false, alt: false, shift: false, meta: false, ...mods },
  };
}

function type(app: TuiApp, text: string): void {
  for (const char of text) app.handleKey(key(char, char));
}

function screenText(frame: CellBuffer): string {
  const rows: string[] = [];
  for (let y = 0; y < frame.height; y++) {
    let row = '';
    for (let x = 0; x < frame.width; x++) row += frame.get(x, y)?.symbol ?? ' ';
    rows.push(row.replace(/\s+$/u, ''));
  }
  return rows.join('\n');
}

function makeApp(): TuiApp {
  return new TuiApp({
    session: { sessionId: 's1', cwd: '/work', model: 'test-model' },
    version: '0.1.0',
    width: 80,
    height: 24,
  });
}

describe('slash completion', () => {
  it('filters commands and renders a menu above the composer', () => {
    const app = makeApp();
    type(app, '/se');
    expect(app.slashMenu.map((command) => command.name)).toEqual(['/session']);
    const text = screenText(app.frame());
    expect(text).toContain('/session');
    expect(text).toContain('show session id and file');
  });

  it('offers /model as a completable command', () => {
    const app = makeApp();
    type(app, '/mo');
    expect(app.slashMenu.map((command) => command.name)).toEqual(['/model']);
    const text = screenText(app.frame());
    expect(text).toContain('/model');
    expect(text).toContain('model and reasoning effort');
    app.handleKey(key('tab'));
    expect(app.composer.text).toBe('/model ');
  });

  it('offers /clear as a completable command', () => {
    const app = makeApp();
    type(app, '/cl');
    expect(app.slashMenu.map((command) => command.name)).toEqual(['/clear']);
    const text = screenText(app.frame());
    expect(text).toContain('/clear');
    expect(text).toContain('clear session history');
    app.handleKey(key('tab'));
    expect(app.composer.text).toBe('/clear ');
  });

  it('completes on Tab and Enter, with arrow selection', () => {
    const app = makeApp();
    type(app, '/he');
    expect(app.handleKey(key('tab'))).toBeUndefined();
    expect(app.composer.text).toBe('/help ');
    expect(app.slashMenu).toEqual([]);

    app.clearComposer();
    type(app, '/');
    expect(app.slashMenu).toHaveLength(7);
    expect(app.slashSelected).toBe(0);
    app.handleKey(key('down'));
    expect(app.slashSelected).toBe(1);
    app.handleKey(key('up'));
    expect(app.slashSelected).toBe(0);
    app.handleKey(key('down'));
    app.handleKey(key('enter'));
    expect(app.composer.text).toBe('/session ');
    expect(app.transcript).toEqual([]);
  });

  it('dismisses with Escape and reopens when editing continues', () => {
    const app = makeApp();
    type(app, '/');
    expect(app.slashMenu).toHaveLength(7);
    app.handleKey(key('escape'));
    expect(app.slashMenu).toEqual([]);
    expect(app.state.slashDismissed).toBe(true);
    type(app, 'h');
    expect(app.slashMenu.map((command) => command.name)).toEqual(['/help']);
  });

  it('submits an exact command instead of completing it', () => {
    const app = makeApp();
    app.handleKey(key('/', '/'));
    app.handleKey(key('h', 'h'));
    app.handleKey(key('e', 'e'));
    app.handleKey(key('l', 'l'));
    app.handleKey(key('p', 'p'));
    const command = app.handleKey(key('enter'));
    expect(command).toEqual({ type: 'submit', text: '/help' });
    expect(app.transcript[0]).toMatchObject({ type: 'user', text: '/help' });
  });

  it('handles a bare slash and empty query matching all commands', () => {
    expect(slashMatches('/')).toHaveLength(7);
    expect(slashMatches('/x')).toEqual([]);
    expect(slashMatches('/help now')).toEqual([]);
    expect(slashMatches('hello')).toEqual([]);
  });
});