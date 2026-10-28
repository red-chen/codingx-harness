import { describe, expect, it } from 'vitest';
import type { SessionHandle } from '../src/session/index.js';
import type { TerminalIO } from '../src/tui/terminal/session.js';
import { TuiApp } from '../src/tui/state/app.js';
import type { TuiPermissionController, TuiSession } from '../src/cli/tui-session.js';
import { TuiSession as TuiSessionClass } from '../src/cli/tui-session.js';

class FakeSession {
  readonly id = 'session-1';
  readonly filePath = '/tmp/session-1.jsonl';
  readonly meta = { id: this.id, cwd: '/tmp/work', model: 'm', createdAt: '', cliVersion: '' };
  readonly writable = true;
  readonly events: Array<Record<string, unknown> & { type: string }> = [];
  async append(input: { type: string } | Array<{ type: string }>): Promise<never[]> {
    const list = Array.isArray(input) ? input : [input];
    for (const event of list) this.events.push({ ...event, seq: this.events.length + 1, ts: '', eventId: String(this.events.length + 1) });
    return [];
  }
  async replay(): Promise<never[]> { return []; }
  async end(): Promise<never> { return {} as never; }
  async close(): Promise<void> {}
  async clear(): Promise<void> { this.events.length = 0; }
}

function makeController(permissions?: TuiPermissionController): {
  app: TuiApp;
  controller: TuiSession;
  session: FakeSession;
} {
  const app = new TuiApp({
    session: {
      sessionId: 'session-1',
      cwd: '/tmp/work',
      model: 'test-model',
      permissionProfile: ':workspace',
      approvalPolicy: 'on-request',
    },
    version: '0.1.0',
    width: 90,
    height: 28,
    now: () => 1000,
  });
  const session = new FakeSession();
  const io: TerminalIO = { write: () => undefined, isTTY: false, columns: 90, rows: 28 };
  const controller = new TuiSessionClass({
    app,
    io,
    session: session as unknown as SessionHandle,
    runTurn: async () => ({
      turnId: 't1',
      status: 'done',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      steps: 0,
      durationMs: 0,
    }),
    ...(permissions === undefined ? {} : { permissions }),
  });
  return { app, controller, session };
}

function shellRequest(command = 'git push origin main') {
  return {
    tool: 'Shell',
    action: { kind: 'exec' as const, tool: 'Shell', command, cwd: '/tmp/work' },
    risk: 'high' as const,
    turnId: 't1',
    callId: 'call-1',
  };
}

function notices(app: TuiApp): string[] {
  return app.transcript
    .filter((cell) => cell.type === 'notice')
    .map((cell) => (cell.type === 'notice' ? cell.text : ''));
}

describe('TuiSession approval and grants', () => {
  it('shows the panel, records audit events, and grants the session scope', async () => {
    const { app, controller, session } = makeController();
    const pending = controller.approve(shellRequest());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app.mode).toBe('approval');
    expect(session.events.map((event) => event.type)).toContain('approval.requested');

    controller.handleCommand({ type: 'approval', decision: { decision: 'allow', scope: 'session' } });
    await expect(pending).resolves.toEqual({ decision: 'allow', scope: 'session' });
    expect(app.mode).toBe('main');
    expect(session.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['approval.requested', 'approval.decided', 'permission.granted']),
    );
    expect(session.events.find((event) => event.type === 'permission.granted')).toMatchObject({
      scope: 'session',
      requestId: expect.any(String),
    });

    const again = await controller.approve(shellRequest());
    expect(again).toEqual({ decision: 'allow', scope: 'once' });
    expect(app.mode).toBe('main');
  });

  it('records a deny reason and does not grant', async () => {
    const { app, controller, session } = makeController();
    const pending = controller.approve(shellRequest('npm publish'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.handleCommand({
      type: 'approval',
      decision: { decision: 'deny', reason: 'not this time' },
    });
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'not this time' });
    const decided = session.events.find((event) => event.type === 'approval.decided');
    expect(decided).toMatchObject({ decision: 'deny', reason: 'not this time', decidedBy: 'user' });
    expect(session.events.some((event) => event.type === 'permission.granted')).toBe(false);
    expect(app.mode).toBe('main');
  });

  it('grants a command prefix and applies it to longer commands', async () => {
    const { controller, session } = makeController();
    const pending = controller.approve(shellRequest('git push'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.handleCommand({ type: 'approval', decision: { decision: 'allow', scope: 'prefix' } });
    await expected(pending);

    const longer = await controller.approve(shellRequest('git push --force origin main'));
    expect(longer).toEqual({ decision: 'allow', scope: 'once' });
    expect(session.events.filter((event) => event.type === 'permission.granted')).toHaveLength(1);
  });

  it('rejects a pending approval when the turn is aborted', async () => {
    const { app, controller, session } = makeController();
    const abort = new AbortController();
    const pending = controller.approve(shellRequest('curl https://example.com'), abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    abort.abort();
    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(app.mode).toBe('main');
    expect(session.events.find((event) => event.type === 'approval.decided')).toMatchObject({
      decision: 'deny',
      reason: 'aborted',
    });
  });

  it('does not keep a session grant after switching to a tighter profile', async () => {
    let profile = ':workspace';
    const permissions: TuiPermissionController = {
      list: () => [':read-only', ':workspace'],
      current: () => ({ profile, approvalPolicy: 'on-request' }),
      set: async (name) => {
        profile = name;
      },
    };
    const { app, controller } = makeController(permissions);
    const first = controller.approve(shellRequest());
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.handleCommand({ type: 'approval', decision: { decision: 'allow', scope: 'session' } });
    await expect(first).resolves.toEqual({ decision: 'allow', scope: 'session' });

    controller.handleLocalCommand('/permissions :read-only');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = controller.approve(shellRequest());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app.mode).toBe('approval');
    controller.handleCommand({ type: 'approval', decision: { decision: 'deny' } });
    await expect(second).resolves.toEqual({ decision: 'deny' });
  });

  it('lists and switches permission profiles through /permissions', async () => {
    const calls: string[] = [];
    const permissions: TuiPermissionController = {
      list: () => [':read-only', ':workspace'],
      current: () => ({ profile: calls.at(-1) ?? ':workspace', approvalPolicy: 'on-request' }),
      set: async (name) => {
        calls.push(name);
      },
    };
    const { app, controller } = makeController(permissions);
    controller.handleLocalCommand('/permissions');
    expect(app.mode).toBe('ask');
    controller.handleCommand({ type: 'cancel-ask' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
    controller.handleLocalCommand('/permissions');
    controller.handleCommand({ type: 'answer', answers: [{ id: 'permission-profile', selected: [':read-only'] }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([':read-only']);
    expect(app.state.session.permissionProfile).toBe(':read-only');
    expect(notices(app).at(-1)).toContain('Permission profile updated: :read-only');
  });
});

async function expected(promise: Promise<unknown>): Promise<void> {
  await expect(promise).resolves.toBeDefined();
}
