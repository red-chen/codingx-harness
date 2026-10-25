import { describe, expect, it } from 'vitest';
import { TuiApp, TuiRuntime, type Disposer, type SessionSignal, type TerminalIO } from '../src/tui/index.js';

class FakeIO implements TerminalIO {
  columns = 120;
  rows = 40;
  isTTY = true;
  readonly writes: string[] = [];
  write(text: string): void {
    this.writes.push(text);
  }
  setRawMode(): void {}
  onResize(): Disposer {
    return () => undefined;
  }
  onData(): Disposer {
    return () => undefined;
  }
  onSignal(_signal: SessionSignal): Disposer {
    return () => undefined;
  }
}

function makeApp(): TuiApp {
  return new TuiApp({
    session: { sessionId: 'perf', cwd: '/work', model: 'perf-model' },
    version: '0.1.0',
    width: 120,
    height: 40,
  });
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
}

function keyEvent(text: string) {
  return {
    type: 'key' as const,
    code: text,
    text,
    mods: { ctrl: false, alt: false, shift: false, meta: false },
  };
}

describe('TUI performance budget', () => {
  it('keeps first frame, steady frames and keystrokes within budget', () => {
    const firstStart = performance.now();
    const app = makeApp();
    for (let index = 0; index < 1000; index++) {
      app.addNotice('history line ' + index + ' 宽字符 🚀');
    }
    app.handleEvent({ type: 'turn.started', turnId: 't1' });
    app.handleEvent({ type: 'text.delta', turnId: 't1', text: 'streaming answer' });
    const io = new FakeIO();
    const runtime = new TuiRuntime({ app, io, colorMode: 'none' });
    expect(runtime.start()).toBe(true);
    const firstFrameMs = performance.now() - firstStart;
    expect(firstFrameMs).toBeLessThan(150);

    const frames: number[] = [];
    for (let index = 0; index < 30; index++) {
      app.handleEvent({ type: 'text.delta', turnId: 't1', text: String(index) });
      const started = performance.now();
      runtime.render(true);
      frames.push(performance.now() - started);
    }
    expect(percentile(frames, 0.95)).toBeLessThan(33);

    const keys: number[] = [];
    for (let index = 0; index < 200; index++) {
      const started = performance.now();
      runtime.handleInput(keyEvent('x'));
      keys.push(performance.now() - started);
    }
    expect(percentile(keys, 0.95)).toBeLessThan(50);
    runtime.stop();
  });
});
