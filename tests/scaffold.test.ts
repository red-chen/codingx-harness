import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/main.js';

describe('scaffold', () => {
  it('exposes a semver version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
