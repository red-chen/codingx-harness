/**
 * Render two mocked AskUserQuestion panels into plain text for documentation.
 *
 * Usage: npx tsx scripts/mock-ask.ts   (or: npm run build && node dist/... )
 * Pure rendering only: it drives TuiApp in-memory, never touches the terminal,
 * the session store or a provider.
 */
import type { AskQuestion } from '../src/tools/types.js';
import { TuiApp } from '../src/tui/state/app.js';

const SESSION = {
  sessionId: 'abcdefghijkl',
  cwd: '/Users/red/workspace/codingx-harness',
  model: 'claude-test-model',
};

/** Variant 1: single-select with a header, descriptions and the Other row. */
const SINGLE: AskQuestion[] = [
  {
    id: 'approach',
    header: 'Plan',
    question: 'Which approach should I use to fix the failing vitest suite?',
    multiSelect: false,
    options: [
      { label: 'Fast', description: 'Patch the assertion only.' },
      { label: 'Safe', description: 'Add a regression test first.' },
      { label: 'Refactor', description: 'Extract the helper, then fix.' },
    ],
  },
];

/** Variant 2: multi-select across two questions with a counter and free text. */
const MULTI: AskQuestion[] = [
  {
    id: 'files',
    header: 'Scope',
    question: 'Which parts of the repo should I touch?',
    multiSelect: true,
    options: [
      { label: 'src/', description: 'Implementation.' },
      { label: 'tests/', description: 'Unit + e2e.' },
      { label: 'docs/', description: 'README + docs/.' },
    ],
  },
  {
    id: 'notes',
    question: 'Anything else I should keep in mind?',
    multiSelect: false,
    options: [{ label: 'Keep the API stable' }, { label: 'Feel free to break it' }],
  },
];

function printable(text: string): { type: 'key'; code: string; mods: Record<string, boolean>; text?: string } {
  const code = text === ' ' ? 'space' : text.toLowerCase();
  return {
    type: 'key',
    code,
    mods: { ctrl: false, alt: false, shift: /[A-Z]/u.test(text), meta: false },
    ...(text === undefined ? {} : { text }),
  };
}

function key(code: string): { type: 'key'; code: string; mods: Record<string, boolean> } {
  return { type: 'key', code, mods: { ctrl: false, alt: false, shift: false, meta: false } };
}

function screenText(app: TuiApp, width: number, height: number): string {
  const buffer = app.frame(width, height);
  const rows: string[] = [];
  for (let y = 0; y < buffer.height; y++) {
    let text = '';
    for (let x = 0; x < buffer.width; x++) {
      const cell = buffer.get(x, y);
      if (cell === undefined || cell.width === 0) continue;
      text += cell.symbol;
    }
    rows.push(text.replace(/ +$/u, ''));
  }
  return rows.join('\n').replace(/\n+$/u, '');
}

function render(label: string, questions: AskQuestion[], script?: (app: TuiApp) => void): void {
  const app = new TuiApp({ session: SESSION, version: '0.1.0', width: 80, height: 24, now: () => 1000 });
  app.handleEvent({ type: 'turn.started', turnId: 't1' });
  app.showQuestion(questions);
  script?.(app);
  console.log(`===== ${label} =====`);
  console.log(screenText(app, 80, 24));
  console.log();
}

render('AskUserQuestion mock 1: single select', SINGLE, (app) => {
  app.handleKey(key('down'));
  app.handleKey(printable('2'));
});

render('AskUserQuestion mock 2: multi select + counter', MULTI, (app) => {
  app.handleKey(key('space'));
  app.handleKey(key('down'));
  app.handleKey(key('space'));
});

