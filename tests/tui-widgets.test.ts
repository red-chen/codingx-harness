import { describe, expect, it } from 'vitest';
import { CellBuffer } from '../src/tui/terminal/buffer.js';
import { ATTR_REVERSE } from '../src/tui/terminal/buffer.js';
import type { KeyEvent, KeyMods } from '../src/tui/terminal/input.js';
import { rect } from '../src/tui/layout/index.js';
import { displayWidth } from '../src/tui/text/index.js';
import type { TokenUsage } from '../src/providers/types.js';
import { TuiApp } from '../src/tui/state/app.js';
import type {
  AssistantCell,
  ExecCell,
  NoticeCell,
  PlanCell,
  TranscriptCell,
  UserCell,
} from '../src/tui/state/types.js';
import { renderWelcomeCard, welcomeCardLines } from '../src/tui/widgets/welcome.js';
import type { StyledTextLine } from '../src/tui/widgets/welcome.js';
import {
  buildAssistantCellLines,
  buildExecCellLines,
  buildExecGroupLines,
  buildNoticeCellLines,
  buildPlanCellLines,
  buildUserCellLines,
  renderTranscript,
  transcriptHeight,
  TranscriptViewport,
} from '../src/tui/widgets/transcript.js';
import {
  clearComposer,
  composerHeight,
  composerCursorPosition,
  createComposerState,
  deleteComposerBackward,
  historyNext,
  historyPrevious,
  insertComposerNewline,
  insertComposerText,
  layoutComposer,
  queuePreviewHeight,
  renderComposer,
  renderQueuePreview,
} from '../src/tui/widgets/composer.js';
import {
  formatElapsed,
  formatTokenCount,
  renderStatusRow,
  statusLabel,
  statusRightLabel,
  usageLabel,
} from '../src/tui/widgets/status.js';
import { composeFrame, computeFrameLayout } from '../src/tui/app.js';

const SESSION = { sessionId: 'abcdefghijkl', cwd: '/tmp/work', model: 'test-model' };
const NO_MODS: KeyMods = { ctrl: false, alt: false, shift: false, meta: false };
const USAGE: TokenUsage = {
  inputTokens: 1200,
  outputTokens: 345,
  cacheReadTokens: 67,
  cacheCreationTokens: 0,
};

function makeApp(width = 80, height = 24, now: () => number = () => 1000): TuiApp {
  return new TuiApp({ session: SESSION, version: '0.1.0', width, height, now });
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
  return key(text === ' ' ? 'space' : text.toLowerCase(), /[A-Z]/u.test(text) ? { shift: true } : {}, text);
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

function styledText(line: StyledTextLine): string {
  return line.segments.map((segment) => segment.text).join('');
}

function styledTexts(lines: readonly StyledTextLine[]): string[] {
  return lines.map(styledText);
}

const userCell = (id: string, text: string): UserCell => ({ type: 'user', id, text });

describe('WelcomeCard', () => {
  it('draws a rounded card with title, version, model, directory and session', () => {
    const lines = welcomeCardLines(
      { version: '0.1.0', model: 'test-model', cwd: '/tmp/work', sessionId: 'sess-123' },
      80,
    );
    expect(lines).toHaveLength(7);
    expect(lines[0]).toMatch(/^╭─+╮$/u);
    expect(lines[6]).toMatch(/^╰─+╯$/u);
    expect(lines[1]).toContain('codingx (v0.1.0)');
    expect(lines[3]).toContain('model: test-model');
    expect(lines[4]).toContain('directory: /tmp/work');
    expect(lines[5]).toContain('session: sess-123');
    expect(lines.every((line) => displayWidth(line) <= 60)).toBe(true);
  });

  it('abbreviates the home directory with a tilde', () => {
    const lines = welcomeCardLines(
      { version: '0.1.0', model: 'test-model', cwd: '/Users/red/workspace/codingx-harness', home: '/Users/red' },
      80,
    );
    expect(lines[4]).toContain('directory: ~/workspace/codingx-harness');
    const exact = welcomeCardLines(
      { version: '0.1.0', model: 'm', cwd: '/Users/red', home: '/Users/red/' },
      80,
    );
    expect(exact[4]).toContain('directory: ~');
    const sibling = welcomeCardLines(
      { version: '0.1.0', model: 'm', cwd: '/Users/red2/work', home: '/Users/red' },
      80,
    );
    expect(sibling[4]).toContain('directory: /Users/red2/work');
  });

  it('shrinks with the viewport and degrades below four columns', () => {
    const narrow = welcomeCardLines({ version: '0.1.0', model: 'm', cwd: '/w' }, 40);
    expect(narrow.every((line) => displayWidth(line) <= 40)).toBe(true);
    expect(displayWidth(narrow[0] ?? '')).toBe(40);
    const tiny = welcomeCardLines({ version: '0.1.0', model: 'm', cwd: '/w' }, 3);
    expect(tiny).toHaveLength(1);
    expect(displayWidth(tiny[0] ?? '')).toBeLessThanOrEqual(3);
  });

  it('renders into a CellBuffer', () => {
    const buffer = new CellBuffer(50, 7);
    const rendered = renderWelcomeCard(rect(0, 0, 50, 7), buffer, {
      version: '0.1.0',
      model: 'model-x',
      cwd: '~/work',
      sessionId: 'sess-x',
    });
    expect(rendered).toBe(7);
    expect(rowText(buffer, 0)).toMatch(/^╭─+╮$/u);
    expect(rowText(buffer, 3)).toContain('model: model-x');
    expect(rowText(buffer, 4)).toContain('directory: ~/work');
    expect(rowText(buffer, 5)).toContain('session: sess-x');
  });
});

describe('transcript cells', () => {
  it('renders user and assistant gutters with continuations', () => {
    const user = styledTexts(buildUserCellLines(userCell('u1', 'hello\nworld'), 20));
    expect(user[0]).toMatch(/^› hello$/u);
    expect(user[1]).toMatch(/^  world$/u);

    const assistant: AssistantCell = { type: 'assistant', id: 'a1', text: 'answer' };
    expect(styledTexts(buildAssistantCellLines(assistant, 20))).toEqual(['• answer']);
  });

  it('renders exec output with │/└ gutters and an overflow marker', () => {
    const exec: ExecCell = {
      type: 'exec',
      id: 'e1',
      callId: 'c1',
      name: 'Shell',
      command: 'printf x',
      output: 'one\ntwo\nthree\nfour\nfive\nsix\nseven',
      isError: false,
      running: false,
    };
    const lines = styledTexts(buildExecCellLines(exec, 30));
    expect(lines[0]).toBe('• Ran printf x');
    expect(lines[1]).toBe('  │ one');
    expect(lines[3]).toBe('  │ three');
    expect(lines[4]).toBe('    … +4 lines (Ctrl+O)');
    expect(lines.join('\n')).not.toContain('six');

    const short = styledTexts(buildExecCellLines({ ...exec, output: 'only' }, 30));
    expect(short[1]).toBe('  └ only');
  });

  it('merges consecutive identical tool calls into one exec block', () => {
    const read = (id: string, callId: string, output: string, durationMs: number): ExecCell => ({
      type: 'exec',
      id,
      callId,
      name: 'Shell',
      command: 'Shell src/a.ts',
      output,
      isError: false,
      running: false,
      durationMs,
    });
    const lines = styledTexts(
      buildExecGroupLines([read('e1', 'c1', 'one\ntwo', 400), read('e2', 'c2', 'three\nfour', 600)], 60),
    );
    expect(lines[0]).toBe('• Ran Shell src/a.ts ×2 · 1s');
    expect(lines.slice(1)).toEqual(['  │ one', '  │ two', '  │ three', '    … +1 lines (Ctrl+O)']);

    const repeated = styledTexts(
      buildExecGroupLines([read('e1', 'c1', 'same', 10), read('e2', 'c2', 'same', 10)], 60),
    );
    expect(repeated[0]).toContain('×2');
    expect(repeated.slice(1)).toEqual(['  └ same']);
  });

  it('groups adjacent identical exec cells in the viewport', () => {
    const cells: TranscriptCell[] = [
      {
        type: 'exec',
        id: 'e1',
        callId: 'c1',
        name: 'Shell',
        command: 'Shell src/a.ts',
        output: 'one',
        isError: false,
        running: false,
      },
      {
        type: 'exec',
        id: 'e2',
        callId: 'c2',
        name: 'Shell',
        command: 'Shell src/a.ts',
        output: 'two',
        isError: false,
        running: false,
      },
      {
        type: 'exec',
        id: 'e3',
        callId: 'c3',
        name: 'Shell',
        command: 'npm test',
        output: 'ok',
        isError: false,
        running: false,
      },
    ];
    const buffer = new CellBuffer(80, 12);
    renderTranscript(rect(0, 0, 80, 12), buffer, { cells, welcome: null });
    const text = screenText(buffer);
    expect(text).toContain('• Ran Shell src/a.ts ×2');
    expect(text.match(/• Ran Shell src\/a\.ts/gu)).toHaveLength(1);
    expect(text).toContain('│ one');
    expect(text).toContain('└ two');
    expect(text).toContain('• Ran npm test');
    // Two blocks (3 + 2 rows) with one blank separator row, not one per call.
    expect(transcriptHeight({ cells, welcome: null }, 80)).toBe(6);
  });

  it('rebuilds a grouped block when an earlier call finishes late', () => {
    const make = (id: string, output: string, running: boolean): ExecCell => ({
      type: 'exec',
      id,
      callId: id,
      name: 'Shell',
      command: 'Shell src/a.ts',
      output,
      isError: false,
      running,
    });
    const first = make('e1', '', true);
    const second = make('e2', '', true);
    renderTranscript(rect(0, 0, 80, 8), new CellBuffer(80, 8), { cells: [first, second], welcome: null });

    const buffer = new CellBuffer(80, 8);
    renderTranscript(rect(0, 0, 80, 8), buffer, {
      cells: [{ ...first, output: 'late output', running: false, durationMs: 5 }, second],
      welcome: null,
    });
    expect(screenText(buffer)).toContain('│ late output');
  });

  it('groups different exploration tools but keeps writes and errors visible', () => {
    const make = (name: string, id: string, label: string): ExecCell => ({
      type: 'exec', id, callId: id, name, command: name, exploration: label,
      output: 'raw-result', isError: false, running: false,
    });
    const cells: TranscriptCell[] = [make('Grep', '1', 'Search pattern in src'),
      make('ReadFile', '2', 'Read src/a.ts'),
      { ...make('EditFile', '3', ''), command: 'EditFile src/a.ts' },
      { ...make('ListDir', '4', 'List missing'), isError: true, output: 'not found' }];
    const buffer = new CellBuffer(80, 20);
    renderTranscript(rect(0, 0, 80, 20), buffer, { cells });
    const text = screenText(buffer);
    expect(text.match(/• Explored/gu)).toHaveLength(2);
    expect(text).toContain('Search pattern in src');
    expect(text).toContain('Read src/a.ts');
    expect(text).toContain('Ran EditFile');
    expect(text).toContain('(failed)');
    expect(text).toContain('1 failed');
  });

  it('caps explored summaries and preserves all calls in details', () => {
    const cells: ExecCell[] = Array.from({ length: 7 }, (_, i) => ({
      type: 'exec', id: String(i), callId: String(i), name: 'ReadFile',
      command: 'ReadFile file' + i, output: 'content' + i, running: false, isError: i === 0,
    }));
    const collapsed = styledTexts(buildExecGroupLines(cells, 80));
    expect(collapsed).toHaveLength(5);
    expect(collapsed.join('\n')).toContain('4 more');
    expect(collapsed.join('\n')).toContain('1 failed');
    expect(collapsed.join('\n')).not.toContain('file0');
    const expanded = styledTexts(buildExecGroupLines(cells.map((cell) => ({ ...cell, expanded: true })), 80));
    expect(expanded.join('\n')).toContain('content0');
    expect(expanded.join('\n')).toContain('content6');
  });

  it('previews Shell stdout instead of metadata and caps wrapped screen rows', () => {
    const cell: ExecCell = { type: 'exec', id: 'e', callId: 'c', name: 'Shell', command: 'git log',
      output: 'exit_code: 0\n\nduration_ms: 51\n\ndescription: commits\n\nsandbox: seatbelt\n\nstdout:\n'
        + 'x'.repeat(150) + '\nsecond\n\nstderr:\n(empty)', running: false, isError: false };
    const collapsed = styledTexts(buildExecCellLines(cell, 30));
    expect(collapsed).toHaveLength(5);
    expect(collapsed.join('\n')).not.toContain('duration_ms');
    expect(collapsed[1]).toContain('xxx');
    expect(collapsed.at(-1)).toContain('Ctrl+O');
    expect(styledTexts(buildExecCellLines({ ...cell, expanded: true }, 80)).join('\n')).toContain('duration_ms: 51');
  });

  it('renders plan markers and notice levels', () => {
    const plan: PlanCell = {
      type: 'plan',
      id: 'p1',
      steps: [
        { step: 'done', status: 'completed' },
        { step: 'doing', status: 'in_progress' },
        { step: 'todo', status: 'pending' },
      ],
    };
    const planLines = styledTexts(buildPlanCellLines(plan, 40));
    expect(planLines[0]).toBe('• Updated Plan');
    expect(planLines[1]).toBe('  ✔ done');
    expect(planLines[2]).toBe('  ▶ doing');
    expect(planLines[3]).toBe('  □ todo');

    const error: NoticeCell = { type: 'notice', id: 'n1', level: 'error', text: 'broken' };
    expect(styledTexts(buildNoticeCellLines(error, 20))).toEqual(['✗ broken']);
  });

  it('keeps the welcome card above the history', () => {
    const buffer = new CellBuffer(80, 24);
    const stats = renderTranscript(rect(0, 0, 80, 24), buffer, {
      cells: [],
      active: null,
      welcome: { version: '0.1.0', model: 'test-model', cwd: '/tmp/work' },
    });
    expect(stats.rows).toBe(7);
    expect(rowText(buffer, 0)).toContain('╭');
    expect(screenText(buffer)).toContain('model: test-model');

    const withUser = new CellBuffer(80, 24);
    renderTranscript(rect(0, 0, 80, 24), withUser, {
      cells: [userCell('u1', 'hello')],
      active: null,
      welcome: { version: '0.1.0', model: 'test-model', cwd: '/tmp/work' },
    });
    expect(screenText(withUser)).toContain('model: test-model');
    expect(rowText(withUser, 0)).toContain('╭');
    expect(screenText(withUser)).toContain('› hello');
  });

  it('renders the active assistant tail after completed cells', () => {
    const buffer = new CellBuffer(60, 10);
    renderTranscript(rect(0, 0, 60, 10), buffer, {
      cells: [userCell('u1', 'hi')],
      active: { id: 'a1', turnId: 't1', text: 'streaming now' },
      welcome: null,
    });
    const text = screenText(buffer);
    expect(text).toContain('› hi');
    expect(text).toContain('• streaming now');
  });

  it('virtualizes a huge transcript', () => {
    const cells: TranscriptCell[] = Array.from({ length: 5000 }, (_, index) => userCell('u' + index, 'message ' + index));
    const viewport = new TranscriptViewport({ cells, welcome: null });
    const buffer = new CellBuffer(80, 24);
    const rows = viewport.render(rect(0, 0, 80, 24), buffer);
    const stats = viewport.lastStats;
    expect(rows).toBeLessThanOrEqual(24);
    expect(stats?.cellsVisited).toBeLessThan(50);
    expect(stats?.cellsRendered).toBeLessThan(50);
    expect(screenText(buffer)).toContain('message 4999');
    expect(transcriptHeight({ cells, welcome: null }, 80)).toBeGreaterThan(5000);
  });

  it('anchors at the bottom and scrolls up by rows', () => {
    const cells: TranscriptCell[] = Array.from({ length: 200 }, (_, index) => userCell('u' + index, 'message ' + index));
    const bottom = new CellBuffer(80, 24);
    renderTranscript(rect(0, 0, 80, 24), bottom, { cells, welcome: null, scrollOffset: 0 });
    expect(screenText(bottom)).toContain('message 199');

    const scrolled = new CellBuffer(80, 24);
    const stats = renderTranscript(rect(0, 0, 80, 24), scrolled, {
      cells,
      welcome: null,
      scrollOffset: 20,
    });
    expect(stats.scrollOffset).toBe(20);
    expect(screenText(scrolled)).not.toContain('message 199');
    expect(screenText(scrolled).trim().length).toBeGreaterThan(0);
  });

  it('clamps an overscrolled viewport to live output', () => {
    const cells: TranscriptCell[] = Array.from({ length: 20 }, (_, index) => userCell('u' + index, 'message ' + index));
    const buffer = new CellBuffer(80, 24);
    const stats = renderTranscript(rect(0, 0, 80, 24), buffer, {
      cells,
      welcome: null,
      scrollOffset: 100000,
    });
    expect(screenText(buffer)).toContain('message 19');
    expect(stats.rows).toBeGreaterThan(0);
  });

  it('never splits CJK or emoji graphemes while wrapping', () => {
    const text = '你好世界'.repeat(5) + '👩‍💻🚀';
    const lines = styledTexts(buildUserCellLines(userCell('u1', text), 12));
    expect(lines.every((line) => displayWidth(line) <= 12)).toBe(true);
    expect(lines.join('\n')).toContain('👩‍💻');
    expect(lines[0]).toMatch(/^› /u);
    expect(lines.join('\n')).toContain('你好世界');
  });
});

describe('Composer', () => {
  it('shows tool duration in exec cells without an assistant LLM footer', () => {
    const assistant = buildAssistantCellLines(
      { type: 'assistant', id: 'a1', text: 'answer', durationMs: 2_500 },
      40,
    );
    expect(styledTexts(assistant).join('\n')).not.toContain('llm');
    const exec = buildExecCellLines(
      {
        type: 'exec',
        id: 'e1',
        callId: 'c1',
        name: 'Shell',
        command: 'npm test',
        output: 'ok',
        isError: false,
        durationMs: 1_500,
        running: false,
      },
      60,
    );
    expect(styledTexts(exec)[0]).toContain('npm test');
    expect(styledTexts(exec)[0]).toContain('1s');
  });

  it('renders a prompt, placeholder and reverse-video cursor', () => {
    const buffer = new CellBuffer(60, 1);
    const rendered = renderComposer(rect(0, 0, 60, 1), buffer, createComposerState());
    expect(rendered).toBe(1);
    expect(rowText(buffer, 0)).toContain('› Ask codingx to do anything');
    const cursor = buffer.get(2, 0);
    expect(cursor?.attrs).toBe((cursor?.attrs ?? 0) | ATTR_REVERSE);
    expect((cursor?.attrs ?? 0) & ATTR_REVERSE).not.toBe(0);
  });

  it('renders typed text with the cursor after it', () => {
    const state = insertComposerText(createComposerState(), 'hello');
    const buffer = new CellBuffer(40, 1);
    renderComposer(rect(0, 0, 40, 1), buffer, state);
    expect(rowText(buffer, 0)).toBe('› hello');
    const cursor = buffer.get(2 + 5, 0);
    expect((cursor?.attrs ?? 0) & ATTR_REVERSE).not.toBe(0);
  });

  it('lays out multiple lines and tracks the cursor', () => {
    let state = insertComposerText(createComposerState(), 'one');
    state = insertComposerNewline(state);
    state = insertComposerText(state, 'two');
    const layout = layoutComposer(state, 40);
    expect(layout.rows).toHaveLength(2);
    expect(layout.cursorRow).toBe(1);
    expect(layout.cursorColumn).toBe(3);
    expect(composerHeight(state, 40)).toBe(4);

    const buffer = new CellBuffer(40, 4);
    renderComposer(rect(0, 0, 40, 4), buffer, state);
    expect(rowText(buffer, 0)).toBe('');
    expect(rowText(buffer, 1)).toBe('› one');
    expect(rowText(buffer, 2)).toBe('  two');
    expect(rowText(buffer, 3)).toBe('');
  });

  it('caps the composer at eight visible rows and keeps the cursor visible', () => {
    let state = createComposerState();
    for (let index = 0; index < 12; index++) {
      state = insertComposerText(state, 'line ' + index);
      if (index < 11) state = insertComposerNewline(state);
    }
    const layout = layoutComposer(state, 40);
    expect(layout.rows).toHaveLength(12);
    expect(layout.height).toBe(8);
    expect(layout.visibleRows).toHaveLength(6);
    expect(layout.cursorRow - layout.startRow).toBeGreaterThanOrEqual(0);
    expect(layout.cursorRow - layout.startRow).toBeLessThan(6);

    const buffer = new CellBuffer(40, 8);
    expect(renderComposer(rect(0, 0, 40, 8), buffer, state)).toBe(8);
    expect(rowText(buffer, 6)).toContain('line 11');
    expect(rowText(buffer, 0)).toBe('');
    expect(rowText(buffer, 7)).toBe('');
  });

  it('reports the hardware cursor at the padded text insertion point', () => {
    const empty = createComposerState();
    expect(composerCursorPosition(empty, { x: 5, y: 10, width: 40, height: 3 })).toEqual({ x: 7, y: 11 });

    let state = insertComposerText(createComposerState(), '你好');
    expect(composerCursorPosition(state, { x: 5, y: 10, width: 40, height: 3 })).toEqual({ x: 11, y: 11 });

    state = insertComposerNewline(insertComposerText(state, 'one'));
    state = insertComposerText(state, 'two');
    expect(composerCursorPosition(state, { x: 0, y: 0, width: 40, height: 4 })).toEqual({ x: 5, y: 2 });
  });

  it('measures CJK/emoji cursor columns by display width', () => {
    let state = insertComposerText(createComposerState(), '你好');
    expect(layoutComposer(state, 40).cursorColumn).toBe(4);
    state = insertComposerText(state, '👩‍💻');
    expect(layoutComposer(state, 40).cursorColumn).toBe(6);
    state = deleteComposerBackward(state);
    expect(state.text).toBe('你好');
  });

  it('browses history and clears while preserving it', () => {
    let state = createComposerState('', ['alpha', 'beta']);
    state = historyPrevious(state);
    expect(state.text).toBe('beta');
    state = historyPrevious(state);
    expect(state.text).toBe('alpha');
    state = historyNext(state);
    expect(state.text).toBe('beta');
    state = clearComposer(state);
    expect(state.text).toBe('');
    expect(state.history).toEqual(['alpha', 'beta']);
  });

  it('renders queued items above the composer', () => {
    expect(queuePreviewHeight([])).toBe(0);
    expect(queuePreviewHeight([{ id: 'q1', text: 'a' }, { id: 'q2', text: 'b' }])).toBe(2);
    expect(
      queuePreviewHeight(
        Array.from({ length: 5 }, (_, index) => ({ id: 'q' + index, text: 'task ' + index })),
      ),
    ).toBe(4);

    const buffer = new CellBuffer(60, 2);
    const rendered = renderQueuePreview(rect(0, 0, 60, 2), buffer, [
      { id: 'q1', text: 'queued one' },
      { id: 'q2', text: 'queued two' },
    ]);
    expect(rendered).toBe(2);
    expect(rowText(buffer, 0)).toContain('queued one');
    expect(rowText(buffer, 1)).toContain('queued two');
  });
});

describe('StatusRow', () => {
  it('formats elapsed time and token counts', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(12_345)).toBe('12s');
    expect(formatElapsed(65_000)).toBe('1m 05s');
    expect(formatElapsed(3_660_000)).toBe('1h 01m');
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1000)).toBe('1k');
    expect(formatTokenCount(1200)).toBe('1.2k');
    expect(formatTokenCount(1_500_000)).toBe('1.5m');
  });

  it('adapts working, ready, aborted and error labels to width', () => {
    const working = { state: 'working' as const, startedAt: 1000, elapsedMs: 0 };
    expect(statusLabel(working, 13_000, 80)).toContain('Working (12s');
    expect(statusLabel(working, 13_000, 80)).toContain('esc to interrupt');
    expect(statusLabel(working, 13_000, 40)).not.toContain('esc to interrupt');
    expect(statusLabel(working, 13_000, 30)).toBe('Working');
    expect(statusLabel({ state: 'idle', elapsedMs: 0 }, 0, 80)).toBe('• Ready');
    expect(statusLabel({ state: 'idle', elapsedMs: 0, outcome: 'aborted' }, 0, 80)).toBe('! Aborted');
    expect(
      statusLabel(
        { state: 'idle', elapsedMs: 0, outcome: 'error', error: { message: 'boom' } },
        0,
        80,
      ),
    ).toContain('Error: boom');
  });

  it('shows usage and context only at 60 columns or wider', () => {
    expect(usageLabel(USAGE)).toBe('in 1.2k · out 345 · cache 67');
    const wide = statusRightLabel(USAGE, 72, 80);
    expect(wide).toContain('in 1.2k');
    expect(wide).toContain('ctx 72% left');
    expect(statusRightLabel(USAGE, 72, 59)).toBeUndefined();
    expect(statusRightLabel({ ...USAGE, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, 72, 80)).toBe(
      'ctx 72% left',
    );
  });

  it('renders the working status and right-aligned usage', () => {
    const buffer = new CellBuffer(100, 1);
    const rendered = renderStatusRow(rect(0, 0, 100, 1), buffer, {
      status: { state: 'working', startedAt: 1000, elapsedMs: 0 },
      usage: USAGE,
      contextPercent: 72,
      now: 13_000,
    });
    expect(rendered).toBe(1);
    const row = rowText(buffer, 0);
    expect(row).toContain('Working (12s');
    expect(row).toContain('in 1.2k');
    expect(row).toContain('ctx 72% left');
    expect(displayWidth(row)).toBeLessThanOrEqual(100);
  });

});

describe('frame composition', () => {
  it('keeps the bottom pane fixed at 80x24 and 120x40', () => {
    const app = makeApp();
    const narrow = computeFrameLayout(app.state, 80, 24);
    expect(narrow.transcript).toEqual({ x: 0, y: 0, width: 80, height: 17 });
    expect(narrow.statusGapTop.y).toBe(17);
    expect(narrow.status.y).toBe(18);
    expect(narrow.statusGapBottom.y).toBe(19);
    expect(narrow.composer.y).toBe(20);
    expect(narrow.meta.y).toBe(23);

    const wide = computeFrameLayout(app.state, 120, 40);
    expect(wide.transcript.height).toBe(33);
    expect(wide.statusGapTop.y).toBe(33);
    expect(wide.status.y).toBe(34);
    expect(wide.statusGapBottom.y).toBe(35);
    expect(wide.composer.y).toBe(36);
    expect(wide.meta.y).toBe(39);
  });

  it('composes welcome, transcript, composer, status and meta', () => {
    const app = makeApp();
    const frame = app.renderFrame();
    expect(frame.width).toBe(80);
    expect(frame.height).toBe(24);
    expect(rowText(frame, 0)).toMatch(/^╭─+╮$/u);
    expect(screenText(frame)).toContain('model: test-model');
    expect(rowText(frame, 17)).toBe('');
    expect(rowText(frame, 18)).toContain('• Ready');
    expect(rowText(frame, 18)).toContain('ctx 0/1m');
    expect(rowText(frame, 19)).toBe('');
    expect(rowText(frame, 21)).toContain('› Ask codingx to do anything');
    expect(rowText(frame, 23)).toContain('test-model');
    expect(rowText(frame, 23)).toContain('New session');
  });

  it('collapses exploration and opens its original results with Ctrl+O', () => {
    const app = makeApp(100, 30);
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    for (const [id, offset, output] of [
      ['c1', 1, 'one'],
      ['c2', 20, 'two'],
    ] as const) {
      app.handleEvent({
        type: 'tool.started',
        turnId: 't1',
        call: { id, name: 'ReadFile', input: { path: 'src/a.ts', offset } },
      });
      app.handleEvent({
        type: 'tool.finished',
        turnId: 't1',
        callId: id,
        name: 'ReadFile',
        result: { content: output, isError: false },
        durationMs: 1,
      });
    }
    const text = screenText(app.renderFrame());
    expect(text.match(/• Explored/gu)).toHaveLength(1);
    expect(text).toContain('Read src/a.ts');
    expect(text).toContain('+ Show details (Ctrl+O)');
    expect(text).not.toContain('└ two');
    app.handleKey(key('o', { ctrl: true }));
    expect(app.mode).toBe('transcript');
    expect(screenText(app.renderFrame())).toContain('└ two');
    app.handleKey(key('escape'));
    expect(app.mode).toBe('main');
    expect(screenText(app.renderFrame())).not.toContain('└ two');
  });

  it('shows a completed conversation with exec and plan cells', () => {
    let clock = 1000;
    const app = makeApp(80, 24, () => clock);
    typeText(app, 'fix the bug');
    app.handleKey(key('enter'));
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    clock = 5000;
    app.handleEvent({ type: 'text.delta', turnId: 't1', text: 'looking at it' });
    app.handleEvent({
      type: 'tool.started',
      turnId: 't1',
      call: { id: 'c1', name: 'Shell', input: { command: 'npm test' } },
    });
    app.handleEvent({
      type: 'tool.finished',
      turnId: 't1',
      callId: 'c1',
      name: 'Shell',
      result: { content: '42 passed', isError: false },
      durationMs: 30,
    });
    app.handleEvent({
      type: 'plan.updated',
      turnId: 't1',
      steps: [{ step: 'verify', status: 'completed' }],
    });
    const text = screenText(app.renderFrame());
    expect(text).toContain('› fix the bug');
    expect(text).toContain('• looking at it');
    expect(text).toContain('• Ran npm test');
    expect(text).toContain('└ 42 passed');
    expect(text).toContain('✔ verify');
    expect(text).toContain('Working (4s');
  });

  it('composes at 120x40 with a bottom session meta row', () => {
    const app = new TuiApp({
      session: SESSION,
      version: '0.1.0',
      width: 120,
      height: 40,
      now: () => 1000,
      contextPercent: 72,
    });
    const frame = app.renderFrame();
    expect(rowText(frame, 0)).toMatch(/^╭─+╮$/u);
    expect(rowText(frame, 34)).toContain('• Ready');
    expect(rowText(frame, 34)).toContain('ctx 0/1m');
    expect(rowText(frame, 37)).toContain('› Ask codingx to do anything');
    expect(rowText(frame, 39)).toContain('test-model');
    expect(rowText(frame, 39)).toContain('New session');
    expect(rowText(frame, 34)).toContain('ctx 0/1m');
    expect(displayWidth(rowText(frame, 39))).toBeLessThanOrEqual(120);
  });

  it('folds the meta and welcome at narrow widths', () => {
    const sixty = composeFrame(makeApp(60, 24).state, { width: 60, height: 24, now: 1000 });
    expect(rowText(sixty, 23)).toContain('test-model');
    expect(rowText(sixty, 0)).toMatch(/^╭─+╮$/u);
    expect(displayWidth(rowText(sixty, 0))).toBeLessThanOrEqual(60);

    const forty = composeFrame(makeApp(40, 24).state, { width: 40, height: 24, now: 1000 });
    expect(rowText(forty, 23)).toContain('test-model');
    expect(rowText(forty, 18)).toContain('• Ready');
    expect(rowText(forty, 18)).toContain('ctx 0/1m');
    expect(screenText(forty)).not.toContain('? for shortcuts');

    const thirtyNine = composeFrame(makeApp(39, 24).state, { width: 39, height: 24, now: 1000 });
    expect(rowText(thirtyNine, 0)).toBe('');
    expect(rowText(thirtyNine, 19)).toContain('Ready');
    expect(rowText(thirtyNine, 19)).toContain('tok 0');
    expect(rowText(thirtyNine, 22)).toContain('› Ask codingx to do anything');
    expect(screenText(thirtyNine)).not.toContain('shortcuts');
  });

  it('keeps CJK and emoji graphemes intact in a narrow frame', () => {
    const app = makeApp(40, 24);
    typeText(app, '请修复这个 bug 👩‍💻🚀 你好世界');
    app.handleKey(key('enter'));
    const frame = app.renderFrame();
    for (let y = 0; y < frame.height; y++) {
      const row = rowText(frame, y);
      expect(displayWidth(row)).toBeLessThanOrEqual(40);
    }
    expect(screenText(frame)).toContain('👩‍💻');
    expect(screenText(frame)).toContain('你好世界');
    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        const cell = frame.get(x, y);
        if (cell !== undefined && cell.width === 2) {
          expect(frame.get(x + 1, y)?.width).toBe(0);
        }
      }
    }
  });

  it('shrinks the transcript area when queued items appear', () => {
    const app = makeApp();
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    typeText(app, 'queued work');
    app.handleKey(key('tab'));
    const layout = computeFrameLayout(app.state, 80, 24);
    expect(layout.transcript.height).toBe(16);
    expect(layout.status.y).toBe(17);
    expect(layout.queue.y).toBe(19);
    expect(layout.composer.y).toBe(20);
    expect(layout.meta.y).toBe(23);
    const frame = app.renderFrame();
    expect(rowText(frame, 19)).toContain('queued work');
  });
});