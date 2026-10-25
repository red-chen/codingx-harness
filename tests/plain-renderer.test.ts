import { describe, expect, it } from 'vitest';
import { PlainRenderer, type TextSink } from '../src/ui/plain.js';
import type { UiEvent } from '../src/agent/events.js';

class MemorySink implements TextSink {
  value = '';
  write(text: string): boolean {
    this.value += text;
    return true;
  }
}

const usage = { inputTokens: 10, outputTokens: 3, cacheReadTokens: 5, cacheCreationTokens: 0 };

describe('PlainRenderer', () => {
  it('streams text to stdout and progress to stderr', () => {
    const stdout = new MemorySink();
    const stderr = new MemorySink();
    const renderer = new PlainRenderer({ stdout, stderr, showBanner: true, version: '0.1.0' });

    renderer.render({
      type: 'session.info',
      session: { sessionId: 's1', cwd: '/work/repo', model: 'model-a' },
    });
    renderer.render({ type: 'turn.started', turnId: 't1' });
    renderer.render({ type: 'text.delta', turnId: 't1', text: 'Hello' });
    renderer.render({
      type: 'tool.started',
      turnId: 't1',
      call: { id: 'c1', name: 'Shell', input: { command: 'echo hi' } },
    });
    renderer.render({
      type: 'tool.finished',
      turnId: 't1',
      callId: 'c1',
      name: 'Shell',
      result: { content: 'exit_code: 0\n\nstdout:\nhi' },
      durationMs: 12,
    });
    renderer.render({ type: 'usage.updated', turnId: 't1', usage });
    renderer.render({ type: 'turn.finished', turnId: 't1', status: 'done', usage, durationMs: 20 });

    expect(stdout.value).toBe(
      'codingx 0.1.0\nmodel: model-a\ndirectory: /work/repo\n\nHello\n',
    );
    expect(stderr.value).toContain('• Shell: echo hi\n');
    expect(stderr.value).toContain('  └ exit_code: 0');
    expect(stderr.value).toContain('[tokens: in 10, out 3, cache read 5]');
    expect(stderr.value).not.toContain('Hello');
  });

  it('shows file paths for file-tool calls and handles errors', () => {
    const stdout = new MemorySink();
    const stderr = new MemorySink();
    const renderer = new PlainRenderer({ stdout, stderr });
    renderer.render({
      type: 'tool.started',
      turnId: 't1',
      call: { id: 'c1', name: 'ReadFile', input: { path: 'src/a.ts' } },
    });
    renderer.render({ type: 'turn.started', turnId: 't1' });
    renderer.render({
      type: 'turn.finished',
      turnId: 't1',
      status: 'error',
      usage,
      durationMs: 9,
      error: { code: 'PROVIDER_ERROR', message: 'upstream failed' },
    });
    expect(stderr.value).toContain('• ReadFile: src/a.ts');
    expect(stderr.value).toContain('[error] PROVIDER_ERROR: upstream failed');
    expect(stdout.value).toBe('');
  });

it('renders plan updates to stderr', () => {
    const stdout = new MemorySink();
    const stderr = new MemorySink();
    const renderer = new PlainRenderer({ stdout, stderr });
    renderer.render({ type: 'turn.started', turnId: 't1' });
    renderer.render({
      type: 'plan.updated',
      turnId: 't1',
      steps: [
        { step: 'inspect', status: 'completed' },
        { step: 'edit', status: 'in_progress' },
        { step: 'test', status: 'pending' },
      ],
    });
    expect(stderr.value).toContain('• Updated Plan');
    expect(stderr.value).toContain('✔ inspect');
    expect(stderr.value).toContain('▶ edit');
    expect(stderr.value).toContain('□ test');
    expect(stdout.value).toBe('');
  });

  it('reports aborted turns', () => {
    const stdout = new MemorySink();
    const stderr = new MemorySink();
    const renderer = new PlainRenderer({ stdout, stderr });
    renderer.render({ type: 'turn.started', turnId: 't1' });
    renderer.render({ type: 'text.delta', turnId: 't1', text: 'partial' });
    renderer.render({ type: 'turn.finished', turnId: 't1', status: 'aborted', usage, durationMs: 3 });
    expect(stdout.value).toBe('partial\n');
    expect(stderr.value).toContain('[aborted]');
  });

  it('emits JSON Lines only when json mode is enabled', () => {
    const stdout = new MemorySink();
    const stderr = new MemorySink();
    const renderer = new PlainRenderer({ stdout, stderr, json: true });
    const events: UiEvent[] = [
      { type: 'session.info', session: { sessionId: 's1', cwd: '/work', model: 'm' } },
      { type: 'turn.started', turnId: 't1' },
      { type: 'text.delta', turnId: 't1', text: 'hello' },
      { type: 'turn.finished', turnId: 't1', status: 'done', usage, durationMs: 1 },
    ];
    for (const event of events) renderer.render(event);

    const lines = stdout.value.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toEqual(['session.info', 'turn.started', 'text.delta', 'turn.finished']);
    expect(lines[2]).toMatchObject({ type: 'text.delta', text: 'hello' });
    expect(stderr.value).toBe('');
  });
});