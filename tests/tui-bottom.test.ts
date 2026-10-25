import { describe, expect, it } from 'vitest';
import { colorsEqual, computeFrameLayout, TuiApp, TUI_COLORS } from '../src/tui/index.js';
import type { CellBuffer } from '../src/tui/index.js';

function key(code: string, text?: string) {
  return {
    type: 'key' as const,
    code,
    ...(text === undefined ? {} : { text }),
    mods: { ctrl: false, alt: false, shift: false, meta: false },
  };
}

function type(app: TuiApp, text: string): void {
  for (const char of text) app.handleKey(key(char, char));
}

function rowText(frame: CellBuffer, y: number): string {
  let row = '';
  for (let x = 0; x < frame.width; x++) row += frame.get(x, y)?.symbol ?? ' ';
  return row.replace(/\s+$/u, '');
}

function screenText(frame: CellBuffer): string {
  const rows: string[] = [];
  for (let y = 0; y < frame.height; y++) rows.push(rowText(frame, y));
  return rows.join('\n');
}

function makeApp(title?: string): TuiApp {
  return new TuiApp({
    session: { sessionId: 's1', cwd: '/tmp/work', model: 'glm-5.3', ...(title ? { title } : {}) },
    version: '0.1.0',
    width: 80,
    height: 24,
  });
}

function expectRowBackground(frame: CellBuffer, y: number, color: typeof TUI_COLORS.composerBg): void {
  for (let x = 0; x < frame.width; x++) {
    const cell = frame.get(x, y);
    expect(cell).toBeDefined();
    if (cell) expect(colorsEqual(cell.bg, color)).toBe(true);
  }
}

describe('TUI bottom surfaces', () => {
  it('gives the composer its own full-width background', () => {
    const app = makeApp();
    const layout = computeFrameLayout(app.state, 80, 24);
    expect(layout.composer.height).toBe(3);
    const empty = app.renderFrame();
    for (let y = layout.composer.y; y < layout.composer.y + layout.composer.height; y++) {
      expectRowBackground(empty, y, TUI_COLORS.composerBg);
    }
    expect(rowText(empty, layout.composer.y + 1)).toContain('Ask codingx to do anything');

    type(app, 'hello');
    const typed = app.renderFrame();
    for (let y = layout.composer.y; y < layout.composer.y + layout.composer.height; y++) {
      expectRowBackground(typed, y, TUI_COLORS.composerBg);
    }
    expect(rowText(typed, layout.composer.y + 1)).toContain('hello');
  });

  it('gives submitted user messages a distinct full-width background', () => {
    const app = makeApp();
    type(app, 'first prompt');
    app.handleKey(key('enter'));
    const layout = computeFrameLayout(app.state, 80, 24);
    const frame = app.renderFrame();
    const userRow = Array.from({ length: layout.transcript.height }, (_, y) => y).find((y) =>
      rowText(frame, y).includes('› first prompt'),
    );
    expect(userRow).toBeDefined();
    expectRowBackground(frame, userRow!, TUI_COLORS.userBg);
    expect(colorsEqual(TUI_COLORS.userBg, TUI_COLORS.composerBg)).toBe(false);

    type(app, 'second prompt');
    app.handleKey(key('enter'));
    const second = app.renderFrame();
    expect(screenText(second)).toContain('› first prompt');
    expect(screenText(second)).toContain('› second prompt');
    const secondRow = Array.from({ length: layout.transcript.height }, (_, y) => y).find((y) =>
      rowText(second, y).includes('› second prompt'),
    );
    expect(secondRow).toBeDefined();
    expectRowBackground(second, secondRow!, TUI_COLORS.userBg);
  });

  it('shows model, cwd and the explicit session title in the meta row', () => {
    const app = makeApp('Fix parser regression');
    const layout = computeFrameLayout(app.state, 80, 24);
    const frame = app.renderFrame();
    const meta = rowText(frame, layout.meta.y);
    expect(meta).toContain('glm-5.3');
    expect(meta).toContain('/tmp/work');
    expect(meta).toContain('Fix parser regression');
  });

  it('derives the title from the first submitted prompt and keeps it on session.info', () => {
    const app = makeApp();
    type(app, 'Please fix the parser bug');
    app.handleKey(key('enter'));
    expect(app.state.session.title).toBe('Please fix the parser bug');
    app.handleEvent({
      type: 'session.info',
      session: { sessionId: 's1', cwd: '/tmp/work', model: 'glm-5.3' },
    });
    expect(app.state.session.title).toBe('Please fix the parser bug');
    const layout = computeFrameLayout(app.state, 80, 24);
    expect(rowText(app.renderFrame(), layout.meta.y)).toContain('Please fix the parser bug');

    type(app, 'second message');
    app.handleKey(key('enter'));
    expect(app.state.session.title).toBe('Please fix the parser bug');
  });

  it('shows the home directory as ~ in welcome and meta', () => {
    const app = new TuiApp({
      session: {
        sessionId: 's1',
        cwd: '/Users/red/workspace/codingx-harness',
        home: '/Users/red',
        model: 'glm-5.3',
        title: 'Tilde path',
      },
      version: '0.1.0',
      width: 100,
      height: 30,
    });
    const text = screenText(app.renderFrame());
    expect(text).toContain('directory: ~/workspace/codingx-harness');
    const layout = computeFrameLayout(app.state, 100, 30);
    const meta = rowText(app.renderFrame(), layout.meta.y);
    expect(meta).toContain('~/workspace/codingx-harness');
    expect(meta).toContain('Tilde path');
  });

  it('renders compact metadata at 40 columns and hides it below 40', () => {
    const narrow = new TuiApp({
      session: { sessionId: 's1', cwd: '/very/long/path/to/project', model: 'glm-5.3', title: 'Narrow title' },
      version: '0.1.0',
      width: 40,
      height: 24,
    });
    const layout = computeFrameLayout(narrow.state, 40, 24);
    const text = rowText(narrow.renderFrame(), layout.meta.y);
    expect(text).toContain('glm-5.3');
    expect(text).toContain('Narrow title');

    const tiny = new TuiApp({
      session: { sessionId: 's1', cwd: '/tmp', model: 'm', title: 'Tiny' },
      version: '0.1.0',
      width: 39,
      height: 24,
    });
    expect(computeFrameLayout(tiny.state, 39, 24).meta.height).toBe(0);
  });
});