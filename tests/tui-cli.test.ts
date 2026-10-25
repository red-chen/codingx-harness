import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { runCli } from '../src/cli/index.js';
import type { TextSink } from '../src/ui/plain.js';

class MemorySink implements TextSink {
  value = '';
  write(text: string): boolean {
    this.value += text;
    return true;
  }
}

const env = {
  CODINGX_HOME: '/tmp/codingx-no-such-home',
  PATH: process.env.PATH ?? '',
};

describe('TUI CLI selection', () => {
  it('refuses --tui on a non-TTY instead of corrupting piped output', async () => {
    const stdout = new MemorySink();
    const stderr = new MemorySink();
    const stdin = new PassThrough();
    const code = await runCli(['--tui'], { stdin, stdout, stderr, env });
    expect(code).not.toBe(0);
    expect(stderr.value).toMatch(/requires a TTY/);
    expect(stdout.value).toBe('');
  });

  it('refuses --json with a forced TUI', async () => {
    const stdout = new MemorySink();
    const stderr = new MemorySink();
    const stdin = new PassThrough();
    const code = await runCli(['--json', '--tui'], { stdin, stdout, stderr, env });
    expect(code).not.toBe(0);
    expect(stderr.value).toMatch(/--json cannot be combined/);
    expect(stdout.value).toBe('');
  });

  it('advertises --tui in help', async () => {
    const stdout = new MemorySink();
    const stderr = new MemorySink();
    expect(await runCli(['--help'], { stdout, stderr, env })).toBe(0);
    expect(stdout.value).toContain('--tui');
    expect(stdout.value).toContain('--plain');
  });
});
