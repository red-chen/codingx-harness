import { describe, expect, it } from 'vitest';
import { copyTextToClipboard } from '../src/util/clipboard.js';

describe('clipboard', () => {
  it('writes OSC52 even when no native clipboard is available', async () => {
    const writes: string[] = [];
    const method = await copyTextToClipboard('hello', {
      write: (chunk) => writes.push(chunk),
      runNative: async () => false,
    });
    expect(method).toBe('OSC52');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^\x1b\]52;c;/);
    const encoded = writes[0]!.slice('\x1b]52;c;'.length, -1);
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('hello');
  });

  it('uses a native clipboard command when available', async () => {
    const writes: string[] = [];
    const calls: string[] = [];
    const method = await copyTextToClipboard('text', {
      write: (chunk) => writes.push(chunk),
      runNative: async (command) => {
        calls.push(command);
        return true;
      },
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(method.startsWith('OSC52 + ')).toBe(true);
  });
});
