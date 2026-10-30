import { describe, expect, it, vi } from 'vitest';
import { isProcessCommand, runProcessCommand, type ProcessCommandManager } from '../src/cli/process-command.js';
import type { ManagedProcess } from '../src/exec/types.js';

function entry(id: string): ManagedProcess {
  return { processId: id, command: 'python3 -m http.server 8000', cwd: '/work',
    state: 'running', pid: 123, startedAt: '', exitCode: null, signal: null };
}
function manager(entries = [entry('abc-123')]): ProcessCommandManager {
  return {
    list: () => entries,
    flush: async () => {},
    read: vi.fn(async (id, cursor = 0, maxChars = 8000) => ({
      process: entries.find((item) => item.processId === id)!,
      output: 'x'.repeat(10_000).slice(cursor, cursor + maxChars),
      nextCursor: Math.min(10_000, cursor + maxChars), truncated: false,
    })),
    stop: vi.fn(async (id) => ({ ...entries.find((item) => item.processId === id)!, state: 'exited' as const, stopReason: 'requested' as const })),
  };
}

describe('/process command', () => {
  it('lists status and usage, including the empty session case', async () => {
    const result = await runProcessCommand('/process', manager());
    expect(result.isError).toBe(false);
    expect(result.content).toContain('abc-123  running  pid=123');
    expect(result.content).toContain('python3 -m http.server');
    expect(result.content).toContain('/process logs');
    expect((await runProcessCommand('/process list', manager([]))).content).toContain('No managed processes');
  });

  it('shows the latest log page and supports explicit incremental cursors', async () => {
    const pm = manager();
    const tail = await runProcessCommand('/process logs abc', pm);
    expect(tail.content).toContain('[older output omitted]');
    expect(tail.content).toContain('Next: /process logs abc-123 10000');
    expect(tail.content).toContain('x'.repeat(8000));
    expect(tail.content).not.toContain('x'.repeat(8001));
    const page = await runProcessCommand('/process read abc 10', pm);
    expect(page.content).toContain('Next: /process logs abc-123 8010');
    expect(pm.read).toHaveBeenLastCalledWith('abc-123', 10, 8000);
  });

  it('stops only an unambiguous session handle, with no PID fallback', async () => {
    const pm = manager([entry('abc-123'), entry('abc-456')]);
    expect((await runProcessCommand('/process stop abc', pm)).content).toContain('Ambiguous');
    expect((await runProcessCommand('/process stop 123', pm)).isError).toBe(true);
    expect(pm.stop).not.toHaveBeenCalled();
    expect((await runProcessCommand('/process stop abc-1', pm)).content).toContain('exited requested');
    expect(pm.stop).toHaveBeenCalledWith('abc-123');
  });

  it('rejects extra arguments and invalid cursors without operating on processes', async () => {
    const pm = manager();
    for (const text of ['/process start anything', '/process list extra', '/process stop abc extra', '/process logs abc -1', '/process logs abc 1.5', '/process logs abc 1 extra']) {
      expect((await runProcessCommand(text, pm)).isError).toBe(true);
    }
    expect(pm.stop).not.toHaveBeenCalled();
    expect(pm.read).not.toHaveBeenCalled();
    expect(isProcessCommand('/processes')).toBe(false);
    expect(isProcessCommand('/process\tlist')).toBe(true);
  });

  it('strips terminal control sequences and redacts secrets from displayed logs', async () => {
    const pm = manager();
    pm.read = async () => ({ process: entry('abc-123'), output: '\x1b[2JAPI_KEY=verysecretvalue\x07', nextCursor: 32, truncated: false });
    const result = await runProcessCommand('/process logs abc', pm);
    expect(result.content).toContain('[REDACTED:secret]');
    expect(result.content).not.toContain('verysecretvalue');
    expect(result.content).not.toContain('\x1b');
    expect(result.content).not.toContain('\x07');
    expect(result.content).toContain('32');
  });
});
