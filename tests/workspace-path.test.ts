import { describe, expect, it } from 'vitest';
import { workspaceKey } from '../src/util/workspace.js';

describe('readable cwd names', () => {
  it('replaces slashes with hyphens and preserves project-name hyphens', async () => {
    expect(await workspaceKey('/Users/example/workspace/codingx-harness')).toBe('-Users-example-workspace-codingx-harness');
    expect(await workspaceKey('/')).toBe('-');
  });

  it('keeps long Unicode paths within the filename byte limit', async () => {
    const key = await workspaceKey('/' + '项目/'.repeat(100));
    expect(Buffer.byteLength(key)).toBeLessThanOrEqual(220);
    expect(key).not.toContain('\uFFFD');
  });
});
