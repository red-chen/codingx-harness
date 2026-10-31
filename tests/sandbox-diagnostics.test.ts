import { describe, expect, it } from 'vitest';
import { sandboxFailure } from '../src/sandbox/diagnostics.js';

describe('sandbox failure diagnostics', () => {
  it('identifies Python bind/listen EPERM and recommends per-execution approval', () => {
    const diagnostic = sandboxFailure('socketserver.py in server_bind\nsocket.bind()\nPermissionError: [Errno 1] Operation not permitted', true, { kind: 'seatbelt', network: 'none' });
    expect(diagnostic).toMatchObject({ denied: true, networkDenied: true });
    expect(diagnostic.hint).toContain('network: "local"');
    expect(diagnostic.hint).toContain('LAN');
  });

  it('does not classify port conflicts, successful commands or unsandboxed errors as sandbox denials', () => {
    expect(sandboxFailure('listen EADDRINUSE', true, { kind: 'seatbelt', network: 'none' }).denied).toBe(false);
    expect(sandboxFailure('listen EPERM', false, { kind: 'seatbelt', network: 'none' }).denied).toBe(false);
    expect(sandboxFailure('listen EPERM', true).denied).toBe(false);
    expect(sandboxFailure('/home/.profile: Operation not permitted', true, { kind: 'seatbelt', network: 'none' }).networkDenied).toBe(false);
  });
});
