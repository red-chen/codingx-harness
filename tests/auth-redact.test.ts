import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveApiKey } from '../src/util/auth.js';
import { redactDeep, redactString } from '../src/util/redact.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'codingx-auth-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeAuth(content: unknown, mode = 0o600): Promise<string> {
  const file = path.join(home, 'auth.json');
  await writeFile(file, JSON.stringify(content), 'utf8');
  await chmod(file, mode);
  return file;
}

describe('API key resolution', () => {
  const provider = { apiKeyEnv: 'API_KEY' };

  it('prefers the environment variable', async () => {
    await writeAuth({ providers: { primary: { apiKey: 'file-key' } } });
    const result = await resolveApiKey({
      providerId: 'primary',
      provider,
      codingxHome: home,
      env: { API_KEY: 'env-key' },
    });
    expect(result).toEqual({ apiKey: 'env-key', source: 'env' });
  });

  it('falls back to auth.json with provider or global keys', async () => {
    await writeAuth({ providers: { primary: { apiKey: 'file-key' } } });
    await expect(
      resolveApiKey({ providerId: 'primary', provider, codingxHome: home, env: {} }),
    ).resolves.toEqual({ apiKey: 'file-key', source: 'auth-file' });

    await writeAuth({ apiKey: 'global-key' });
    await expect(
      resolveApiKey({ providerId: 'other', provider, codingxHome: home, env: {} }),
    ).resolves.toEqual({ apiKey: 'global-key', source: 'auth-file' });
  });

  it('rejects missing keys with actionable guidance', async () => {
    await expect(
      resolveApiKey({ providerId: 'primary', provider, codingxHome: home, env: {} }),
    ).rejects.toThrow(/Set API_KEY or add .*auth\.json/);
  });

  it('rejects invalid auth JSON', async () => {
    const file = path.join(home, 'auth.json');
    await writeFile(file, '{not json', 'utf8');
    await chmod(file, 0o600);
    await expect(
      resolveApiKey({ providerId: 'primary', provider, codingxHome: home, env: {} }),
    ).rejects.toThrow(/Invalid JSON/);
  });

  it.skipIf(process.platform === 'win32')('rejects group/world-readable auth files', async () => {
    await writeAuth({ providers: { primary: { apiKey: 'file-key' } } }, 0o644);
    await expect(
      resolveApiKey({ providerId: 'primary', provider, codingxHome: home, env: {} }),
    ).rejects.toThrow(/chmod 600/);
  });
});

describe('secret redaction', () => {
  it('redacts common credential shapes but not ordinary text', () => {
    const cases: Array<[string, RegExp]> = [
      ['sk-ant-api03-' + 'a'.repeat(40), /\[REDACTED:anthropic-api-key\]/],
      ['sk-proj-' + 'A'.repeat(30), /\[REDACTED:openai-api-key\]/],
      ['ghp_' + 'a'.repeat(36), /\[REDACTED:github-token\]/],
      ['AKIA' + 'ABCDEFGHIJKLMNOP', /\[REDACTED:aws-access-key\]/],
      ['AIza' + 'a'.repeat(35), /\[REDACTED:google-api-key\]/],
      ['Bearer ' + 'a'.repeat(30), /Bearer \[REDACTED:bearer-token\]/],
      ['API_KEY=supersecretvalue123', /API_KEY=\[REDACTED:secret\]/],
      ['eyJ' + 'a'.repeat(20) + '.' + 'b'.repeat(20) + '.' + 'c'.repeat(20), /\[REDACTED:jwt\]/],
      [
        '-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----',
        /\[REDACTED:private-key\]/,
      ],
    ];
    for (const [text, marker] of cases) {
      const result = redactString(text);
      expect(result.redacted).toBe(true);
      expect(result.value).toMatch(marker);
      expect(result.value).not.toContain('supersecretvalue123');
    }

    const plain = redactString('pnpm test passed in 1.2s; see src/util/foo.ts');
    expect(plain).toEqual({ value: 'pnpm test passed in 1.2s; see src/util/foo.ts', redacted: false });
  });

  it('is idempotent for already redacted values', () => {
    const first = redactString('API_KEY=supersecretvalue123');
    expect(first.redacted).toBe(true);
    expect(redactString(first.value).redacted).toBe(false);
  });

  it('redacts nested event payloads without mutating the input', () => {
    const event = {
      type: 'tool.result',
      content: 'token=ghp_' + 'a'.repeat(36),
      nested: { keys: ['sk-ant-api03-' + 'a'.repeat(40), 42, true, null] },
    };
    const result = redactDeep(event);
    expect(result.redacted).toBe(true);
    expect(result.value.content).toMatch(/token=\[REDACTED:(github-token|secret)\]/);
    expect(result.value.nested.keys[0]).toBe('[REDACTED:anthropic-api-key]');
    expect(result.value.nested.keys[1]).toBe(42);
    expect(event.content).toContain('ghp_');
  });
});
