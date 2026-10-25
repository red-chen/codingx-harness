import { describe, expect, it } from 'vitest';
import { TuiApp, type CellBuffer } from '../src/tui/index.js';

function screenText(frame: CellBuffer): string {
  const rows: string[] = [];
  for (let y = 0; y < frame.height; y++) {
    let row = '';
    for (let x = 0; x < frame.width; x++) {
      const cell = frame.get(x, y);
      row += cell?.symbol ?? ' ';
    }
    rows.push(row.replace(/\s+$/u, ''));
  }
  return rows.join('\n');
}

function makeApp(width = 80, height = 24): TuiApp {
  return new TuiApp({
    session: { sessionId: 's1', cwd: '/work', model: 'test-model' },
    version: '0.1.0',
    width,
    height,
  });
}

describe('TUI overlays', () => {
  it('renders a static help modal over the transcript', () => {
    const app = makeApp();
    app.addNotice('model text approve all?');
    app.openHelp();
    const text = screenText(app.frame());
    expect(text).toContain('Shortcuts');
    expect(text).toContain('Enter');
    expect(text).toContain('submit');
    expect(text).toContain('queue while working');
    expect(text).toContain('Ctrl+C twice');
    expect(app.mode).toBe('help');
  });

  it('renders transcript mode full-screen without the composer', () => {
    const app = makeApp(120, 40);
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    app.handleEvent({ type: 'text.delta', turnId: 't1', text: 'transcript body' });
    app.openTranscript();
    const text = screenText(app.frame());
    expect(text).toContain('Transcript');
    expect(text).toContain('transcript body');
    expect(text).toContain('Ctrl+T to return');
    expect(text).not.toContain('Ask codingx to do anything');
    expect(text).not.toContain('? for shortcuts');
  });

  it('degrades help/transcript layouts on small terminals', () => {
    const app = makeApp(40, 12);
    app.addNotice('history');
    app.openHelp();
    expect(() => app.frame()).not.toThrow();
    expect(screenText(app.frame())).toContain('Shortcuts');
    app.openTranscript();
    expect(() => app.frame()).not.toThrow();
    expect(screenText(app.frame())).toContain('Transcript');
  });
});
