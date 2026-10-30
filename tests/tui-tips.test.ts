import { describe, expect, it } from 'vitest';
import { TuiApp } from '../src/tui/index.js';
import { tipsPreview } from '../src/tui/widgets/tips.js';

function makeApp(tip?: string) {
  return new TuiApp({ tip, session: { sessionId: 's', cwd: '/work', model: 'm' },
    version: 'test', width: 40, height: 12 });
}
function press(app: TuiApp, code: string) {
  return app.handleKey({ type: 'key', code, mods: { ctrl: false, alt: false, shift: false, meta: false } });
}
function screen(app: TuiApp) {
  const frame = app.renderFrame();
  return Array.from({ length: frame.height }, (_, y) => Array.from({ length: frame.width }, (_, x) =>
    frame.get(x, y)?.symbol ?? '').join('')).join('\n');
}

describe('tip picker', () => {
  it.each([false, true])('Tab fills the full current tip without submitting or queueing (working=%s)', (working) => {
    const tip = '深度 Review 当前真实场景。'.repeat(12);
    const app = makeApp(tip);
    if (working) app.handleEvent({ type: 'turn.started', turnId: 't' });
    const status = app.status;
    expect(press(app, 'tab')).toBeUndefined();
    expect(app.composer.text).toBe(tip);
    expect(app.composer.cursor).toBe(tip.length);
    expect(app.composer.history).toEqual([]);
    expect(app.transcript).toEqual([]);
    expect(app.queue).toEqual([]);
    expect(app.status).toEqual(status);
  });

  it('preserves completion and draft queueing with a current tip', () => {
    const app = makeApp('Tip');
    const type = (text: string) => app.handleKey({ type: 'key', code: 'paste', text,
      mods: { ctrl: false, alt: false, shift: false, meta: false } });
    type('/ti');
    press(app, 'tab');
    expect(app.composer.text).toBe('/tips ');
    app.clearComposer();
    type('My draft');
    press(app, 'tab');
    expect(app.composer.text).toBe('My draft');
    expect(app.queue).toEqual([]);
    app.handleEvent({ type: 'turn.started', turnId: 't' });
    press(app, 'tab');
    expect(app.composer.text).toBe('');
    expect(app.queue).toMatchObject([{ text: 'My draft' }]);
  });

  it('leaves input empty without a tip or with Shift+Tab', () => {
    const app = makeApp();
    press(app, 'tab');
    expect(app.composer.text).toBe('');
    const withTip = makeApp('Tip');
    withTip.handleKey({ type: 'key', code: 'tab', mods: { ctrl: false, alt: false, shift: true, meta: false } });
    expect(withTip.composer.text).toBe('');
  });

  it('fills the full tip as an editable draft and submits only on a subsequent Enter', () => {
    const app = makeApp();
    app.submitText('Previous prompt');
    const history = [...app.composer.history];
    const transcript = [...app.transcript];
    const tip = '深度 Review 当前修改，关注功能正确性和性能。'.repeat(10);
    app.openTips([tip]);
    expect(press(app, 'enter')).toBeUndefined();
    expect(app.mode).toBe('main');
    expect(app.composer.text).toBe(tip);
    expect(app.composer.cursor).toBe(tip.length);
    expect(app.composer.history).toEqual(history);
    expect(app.transcript).toEqual(transcript);
    app.handleKey({ type: 'key', code: 'paste', text: '仅限当前场景。',
      mods: { ctrl: false, alt: false, shift: false, meta: false } });
    expect(press(app, 'enter')).toEqual({ type: 'submit', text: tip + '仅限当前场景。' });
  });

  it('pages through full long text, clamps after resize and navigates a long list', () => {
    const app = makeApp();
    const items = Array.from({ length: 20 }, (_, i) => 'Tip ' + i);
    items[19] = '真实场景 Review 功能、性能和回归。'.repeat(40) + '结束标记';
    app.openTips(items);
    press(app, 'end');
    expect(screen(app)).toContain('20/20');
    expect(screen(app)).toContain('20.');
    const first = tipsPreview(app.state.tips!, 40, 12);
    expect(first.maxOffset).toBeGreaterThan(0);
    for (let i = 0; i < 100; i++) press(app, 'pagedown');
    expect(app.state.tips?.offset).toBe(first.maxOffset);
    expect(screen(app)).toContain('结束标记');
    app.setSize(100, 40);
    expect(screen(app)).toContain('结束标记');
    press(app, 'pageup');
    expect(app.state.tips?.offset).toBe(0);
    press(app, 'down');
    expect(app.state.tips?.index).toBe(0);
    press(app, 'up');
    expect(app.state.tips?.index).toBe(19);
    press(app, 'home');
    press(app, 'enter');
    expect(app.state.tip).toBe('Tip 0');
    expect(app.state.mode).toBe('main');
  });

  it('preserves the draft and current tip on cancel and renders tiny terminals', () => {
    const app = makeApp('Original');
    app.handleKey({ type: 'key', code: 'paste', text: 'draft', mods: { ctrl: false, alt: false, shift: false, meta: false } });
    app.openTips(['New']);
    for (const [width, height] of [[1, 1], [8, 6], [20, 8]]) {
      app.setSize(width!, height!);
      expect(() => app.renderFrame()).not.toThrow();
    }
    press(app, 'escape');
    expect(app.state.tip).toBe('Original');
    expect(app.composer.text).toBe('draft');
    expect(app.transcript).toEqual([]);
  });

  it('handles empty lists and allows explicit selection with automatic display off', () => {
    const app = makeApp();
    app.openTips([' ', '\u001b[31m']);
    expect(app.mode).toBe('main');
    expect(app.transcript.at(-1)).toMatchObject({ type: 'notice', text: expect.stringContaining('No tips configured') });
    app.openTips(['Available']);
    press(app, 'enter');
    expect(app.state.tip).toBe('Available');
  });

  it('does not replace tool questions, and preserves working status', () => {
    const app = makeApp();
    app.handleEvent({ type: 'turn.started', turnId: 't' });
    app.openTips(['Available']);
    expect(app.status.state).toBe('working');
    app.showQuestion([{ id: 'q', question: 'Continue?', multiSelect: false }]);
    app.openTips(['Other']);
    expect(app.mode).toBe('ask');
    expect(app.state.ask?.questions[0]?.id).toBe('q');
    app.clearAsk();
    expect(app.status.state).toBe('working');
  });
});
