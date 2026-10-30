import { describe, expect, it } from 'vitest';
import { TuiApp } from '../src/tui/state/app.js';
import type { KeyEvent, KeyMods } from '../src/tui/terminal/input.js';
import type { CellBuffer } from '../src/tui/terminal/buffer.js';
import { approvalPanelHeight, buildApprovalPanel } from '../src/tui/widgets/approval.js';
import { statusLabel } from '../src/tui/widgets/status.js';
import type { TuiApprovalRequest } from '../src/tui/state/types.js';

const SESSION = { sessionId: 'abcdefghijkl', cwd: '/tmp/work', model: 'test-model' };
const NO_MODS: KeyMods = { ctrl: false, alt: false, shift: false, meta: false };

function makeApp(width = 90, height = 28): TuiApp {
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
  return key(text === ' ' ? 'space' : text.toLowerCase(), /[A-Z]/u.test(text) ? { shift: true } : {}, text);
}

function screenText(buffer: CellBuffer): string {
  const rows: string[] = [];
  for (let y = 0; y < buffer.height; y++) {
    let text = '';
    for (let x = 0; x < buffer.width; x++) {
      const cell = buffer.get(x, y);
      if (cell !== undefined && cell.width !== 0) text += cell.symbol;
    }
    rows.push(text.replace(/ +$/u, ''));
  }
  return rows.join('\n');
}

function shellRequest(overrides: Partial<TuiApprovalRequest> = {}): TuiApprovalRequest {
  return {
    requestId: 'req-1',
    tool: 'Shell',
    action: { kind: 'exec', tool: 'Shell', command: 'git push origin main', cwd: '/tmp/work' },
    reason: 'The user asked to publish the branch.',
    risk: 'high',
    allowPrefix: true,
    ...overrides,
  };
}

function shown(request = shellRequest()): TuiApp {
  const app = makeApp();
  app.handleEvent({ type: 'turn.started', turnId: 't1' });
  app.showApproval(request);
  return app;
}

describe('TuiApp approval overlay', () => {
  it('returns an idle approval to idle without inventing an active turn', () => {
    const app = makeApp();
    app.showApproval(shellRequest());
    app.handleKey(key('enter'));
    app.clearApproval();
    expect(app.status.state).toBe('idle');
  });

  it('shows full command details without allowing Enter to approve', () => {
    const app = shown(shellRequest({ action: { kind: 'exec', tool: 'Shell',
      command: 'echo ' + 'long-command '.repeat(300) + 'COMMAND_END', cwd: '/tmp/work' } }));
    app.handleKey(printable('v'));
    expect(screenText(app.frame())).toContain('Approval details');
    expect(app.handleKey(key('enter'))).toBeUndefined();
    expect(app.state.approval).toBeDefined();
    for (let i = 0; i < 10; i++) app.handleKey(key('pagedown'));
    expect(screenText(app.frame())).toContain('COMMAND_END');
    app.handleKey(key('escape'));
    expect(app.state.approval?.details).toBe(false);
    expect(app.handleKey(key('enter'))).toEqual({ type: 'approval', decision: { decision: 'allow', scope: 'once' } });
  });

  it('opens an awaiting modal and renders the normalized action and fixed options', () => {
    const app = shown();
    expect(app.mode).toBe('approval');
    expect(app.status).toMatchObject({ state: 'awaiting', turnId: 't1' });
    const screen = screenText(app.frame());
    expect(screen).toContain('Approval required');
    expect(screen).toContain('git push origin main');
    expect(screen).toContain('› 1. Allow once');
    expect(screen).toContain('2. Allow for this session');
    expect(screen).not.toContain('(•)');
    expect(screen).not.toContain('( )');
    expect(screen).toContain('Allow for this session');
    expect(screen).toContain('Allow this command prefix');
    expect(screen).toContain('Deny with reason');
    expect(screen).toContain('risk high');
  });

  it('returns allow-once and restores the working status', () => {
    const app = shown();
    const command = app.handleKey(key('enter'));
    expect(command).toEqual({ type: 'approval', decision: { decision: 'allow', scope: 'once' } });
    expect(app.mode).toBe('main');
    expect(app.state.approval).toBeUndefined();
    expect(app.status.state).toBe('working');
  });

  it('supports session and prefix scopes through the arrow keys', () => {
    const session = shown();
    session.handleKey(key('down'));
    expect(session.handleKey(key('enter'))).toEqual({
      type: 'approval',
      decision: { decision: 'allow', scope: 'session' },
    });

    const prefix = shown();
    prefix.handleKey(key('down'));
    prefix.handleKey(key('down'));
    expect(prefix.handleKey(key('enter'))).toEqual({
      type: 'approval',
      decision: { decision: 'allow', scope: 'prefix' },
    });
  });

  it('captures a deny reason with free text', () => {
    const app = shown();
    for (let i = 0; i < 4; i += 1) app.handleKey(key('down'));
    expect(app.handleKey(key('enter'))).toBeUndefined();
    expect(app.state.approval?.editingReason).toBe(true);
    for (const char of 'not now') app.handleKey(printable(char));
    expect(app.handleKey(key('enter'))).toEqual({
      type: 'approval',
      decision: { decision: 'deny', reason: 'not now' },
    });
    expect(app.mode).toBe('main');
  });

  it('denies on Escape and interrupts on Ctrl+C', () => {
    const denied = shown();
    expect(denied.handleKey(key('escape'))).toEqual({
      type: 'approval',
      decision: { decision: 'deny', reason: 'approval cancelled' },
    });

    const interrupted = shown();
    expect(interrupted.handleKey(key('c', { ctrl: true }))).toEqual({ type: 'interrupt' });
  });

  it('hides the prefix option for file actions and renders long commands', () => {
    const request = shellRequest({
      requestId: 'req-file',
      tool: 'Write',
      action: { kind: 'file.write', tool: 'Write', path: '/tmp/work/out.txt' },
      allowPrefix: false,
      reason: undefined,
    });
    const app = shown({ ...request, action: { ...request.action, command: undefined } });
    const screen = screenText(app.frame());
    expect(screen).toContain('path: /tmp/work/out.txt');
    expect(screen).not.toContain('command prefix');
    expect(approvalPanelHeight(app.state.approval as never, 90)).toBeGreaterThan(4);
    expect(buildApprovalPanel(app.state.approval as never, 90).lines.map((line) => line.text).join('\n')).toContain(
      'Allow once',
    );
  });

  it('labels the status row as awaiting approval', () => {
    expect(statusLabel({ state: 'awaiting', elapsedMs: 1_000, startedAt: 0 }, 1_000, 80, 'approval')).toBe(
      '! Awaiting approval (1s)',
    );
  });
});
