import { describe, expect, it } from 'vitest';
import {
  formatSessionTimestamp,
  generateSessionId,
  generateTurnId,
  isValidSessionId,
  resolveSessionId,
  sessionFileName,
} from '../src/util/ids.js';
import { estimateTokens, truncateMiddle } from '../src/util/tokens.js';
import { isPathInside } from '../src/util/paths.js';

describe('ids', () => {
  it('generates UUID session ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = generateSessionId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(isValidSessionId(id)).toBe(true);
      ids.add(id);
    }
    expect(ids.size).toBe(200);
    expect(isValidSessionId('abcdefghijkl')).toBe(true);
    expect(isValidSessionId('not-a-session-id')).toBe(false);
  });

  it('formats filesystem-safe timestamps and file names', () => {
    const date = new Date('2026-10-24T15:20:01.123Z');
    expect(formatSessionTimestamp(date)).toBe('2026-10-24T15-20-01');
    expect(sessionFileName('550e8400-e29b-41d4-a716-446655440000', date)).toBe(
      '2026-10-24T15-20-01_550e8400-e29b-41d4-a716-446655440000.jsonl',
    );
  });

  it('resolves unique prefixes and rejects ambiguous ones', () => {
    expect(resolveSessionId('abc', ['abcdefghijkl', 'zzzzzzzzzzzz'])).toBe('abcdefghijkl');
    expect(resolveSessionId('550e', ['550e8400-e29b-41d4-a716-446655440000'])).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
    expect(() => resolveSessionId('a', ['abcdefghijkl', 'a12345678901'])).toThrow(/ambiguous/);
    expect(() => resolveSessionId('qqq', ['abcdefghijkl'])).toThrow(/No session/);
  });

  it('generates turn ids with a stable prefix', () => {
    expect(generateTurnId()).toMatch(/^turn_[0-9a-f]{16}$/);
  });
});

describe('tokens', () => {
  it('estimates ASCII and wide characters differently', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('你好')).toBe(2);
    expect(estimateTokens('🚀')).toBe(1);
  });

  it('truncates oversized text in the middle with an explicit marker', () => {
    const text = 'HEAD' + 'x'.repeat(100) + 'TAIL';
    const result = truncateMiddle(text, 30, '...');
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result.startsWith('HEAD')).toBe(true);
    expect(result.endsWith('TAIL')).toBe(true);
    expect(result).toContain('...');
  });

  it('leaves short text unchanged and respects tiny limits', () => {
    expect(truncateMiddle('short', 20)).toBe('short');
    expect(truncateMiddle('abcdef', 3, '...')).toBe('abc');
  });
});

describe('paths', () => {
  it('detects containment without prefix tricks', () => {
    expect(isPathInside('/repo', '/repo')).toBe(true);
    expect(isPathInside('/repo', '/repo/src/a.ts')).toBe(true);
    expect(isPathInside('/repo', '/repo-other/a.ts')).toBe(false);
    expect(isPathInside('/repo', '/repo/../outside')).toBe(false);
    expect(isPathInside('/repo', '/etc/passwd')).toBe(false);
  });
});
