import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ReadFileTracker,
  ToolRegistry,
  createBuiltinTools,
  type ToolContext,
} from '../src/tools/index.js';
import { buildChildEnv } from '../src/exec/index.js';

let root: string;
let cwd: string;
let registry: ToolRegistry;
let ctx: ToolContext;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codingx-apply-patch-'));
  cwd = path.join(root, 'workspace');
  await mkdir(cwd, { recursive: true });
  registry = new ToolRegistry(createBuiltinTools());
  ctx = {
    cwd,
    signal: new AbortController().signal,
    readTracker: new ReadFileTracker(),
    maxOutputChars: 30_000,
    shell: {
      env: buildChildEnv(['PATH', 'HOME', 'LANG', 'TERM'], { ...process.env, HOME: cwd }),
      timeoutMs: 5_000,
    },
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(relative: string, content: string | Buffer): Promise<string> {
  const file = path.join(cwd, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

async function read(relative: string): Promise<void> {
  const result = await registry.execute('Read', { path: relative }, ctx);
  expect(result.isError).toBeUndefined();
}

async function readText(relative: string): Promise<string> {
  return readFile(path.join(cwd, relative), 'utf8');
}

function unified(lines: string[]): string {
  return lines.join('\n') + '\n';
}

describe('ApplyPatch', () => {
  it('modifies multiple files with multiple hunks and pure insertions', async () => {
    const original = [
      'const a = 1;',
      'const b = 2;',
      '',
      'export function sum() {',
      '  return a + b;',
      '}',
      '',
      'export const total = sum();',
      '',
    ].join('\n');
    await put('src/a.ts', original);
    await put('src/b.txt', 'alpha\nbeta\ngamma\n');
    if (process.platform !== 'win32') await chmod(path.join(cwd, 'src/a.ts'), 0o640);
    await read('src/a.ts');
    await read('src/b.txt');

    const patch = unified([
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      '-const a = 1;',
      '-const b = 2;',
      '+const a = 10;',
      '+const b = 20;',
      '+const c = 30;',
      '@@ -7,0 +9,2 @@',
      '+// added by patch',
      '+export const doubled = total * 2;',
      '--- a/src/b.txt',
      '+++ b/src/b.txt',
      '@@ -1,3 +1,4 @@',
      ' alpha',
      '-beta',
      '+beta changed',
      '+delta',
      ' gamma',
    ]);

    const result = await registry.execute('ApplyPatch', { patch }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.meta).toMatchObject({
      files: [
        { path: 'src/a.ts', created: false, additions: 5, deletions: 2 },
        { path: 'src/b.txt', created: false, additions: 2, deletions: 1 },
      ],
      filesChanged: 2,
    });
    expect(result.content).toContain('Applied patch to 2 files');
    expect(result.meta?.fileDiffs).toMatchObject([
      { path: 'src/a.ts', additions: 5, deletions: 2, truncated: false },
      { path: 'src/b.txt', additions: 2, deletions: 1, truncated: false },
    ]);
    expect(result.content).toContain('updated src/a.ts (+5/-2)');
    expect(result.content).toContain('updated src/b.txt (+2/-1)');

    expect(await readText('src/a.ts')).toBe(
      [
        'const a = 10;',
        'const b = 20;',
        'const c = 30;',
        '',
        'export function sum() {',
        '  return a + b;',
        '}',
        '',
        '// added by patch',
        'export const doubled = total * 2;',
        'export const total = sum();',
        '',
      ].join('\n'),
    );
    expect(await readText('src/b.txt')).toBe('alpha\nbeta changed\ndelta\ngamma\n');
    if (process.platform !== 'win32') {
      expect((await stat(path.join(cwd, 'src/a.ts'))).mode & 0o777).toBe(0o640);
    }
  });

  it('creates a new file from /dev/null, including parent directories', async () => {
    const patch = unified([
      'diff --git a/src/generated/new.ts b/src/generated/new.ts',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/src/generated/new.ts',
      '@@ -0,0 +1,3 @@',
      '+export const one = 1;',
      '+export const two = 2;',
      '+export const three = 3;',
    ]);

    const result = await registry.execute('ApplyPatch', { patch }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.meta).toMatchObject({
      files: [{ path: 'src/generated/new.ts', created: true, additions: 3, deletions: 0 }],
      filesChanged: 1,
    });
    expect(result.content).toContain('Applied patch to 1 file');
    expect(result.content).toContain('created src/generated/new.ts (+3/-0)');
    expect(await readText('src/generated/new.ts')).toBe(
      'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n',
    );
    expect(ctx.readTracker.hasRead(await realpath(path.join(cwd, 'src/generated/new.ts')))).toBe(true);

    const again = await registry.execute('ApplyPatch', { patch }, ctx);
    expect(again.isError).toBe(true);
    expect(again.content).toMatch(/already exists/);
  });

  it('refuses unread existing files and writes nothing', async () => {
    await put('a.txt', 'one\n');
    await put('b.txt', 'two\n');
    await read('a.txt');

    const patch = unified([
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-one',
      '+ONE',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1 +1 @@',
      '-two',
      '+TWO',
    ]);

    const result = await registry.execute('ApplyPatch', { patch }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/before it has been read/);
    expect(result.meta).toMatchObject({ path: 'b.txt', reason: 'read-before-write' });
    expect(await readText('a.txt')).toBe('one\n');
    expect(await readText('b.txt')).toBe('two\n');
  });

  it('rejects context mismatches without changing any file', async () => {
    await put('a.txt', 'alpha\n');
    await put('b.txt', 'beta\ngamma\n');
    await read('a.txt');
    await read('b.txt');

    const patch = unified([
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-alpha',
      '+ALPHA',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1,2 +1,2 @@',
      ' BETA',
      '-gamma',
      '+GAMMA',
    ]);

    const result = await registry.execute('ApplyPatch', { patch }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Context mismatch/);
    expect(await readText('a.txt')).toBe('alpha\n');
    expect(await readText('b.txt')).toBe('beta\ngamma\n');
  });

  it('rejects paths that escape the workspace without partial writes', async () => {
    await put('a.txt', 'safe\n');
    await read('a.txt');

    const patch = unified([
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-safe',
      '+SAFE',
      '--- /dev/null',
      '+++ b/../escaped.txt',
      '@@ -0,0 +1 @@',
      '+escaped',
    ]);

    const result = await registry.execute('ApplyPatch', { patch }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the workspace/);
    expect(await readText('a.txt')).toBe('safe\n');
    await expect(stat(path.join(root, 'escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    const quoted = await registry.execute(
      'ApplyPatch',
      {
        patch: unified([
          '--- "a/a.txt"',
          '+++ "b/a.txt"',
          '@@ -1 +1 @@',
          '-safe',
          '+SAFE',
        ]),
      },
      ctx,
    );
    expect(quoted.isError).toBe(true);
    expect(quoted.content).toMatch(/quoted/i);
    expect(await readText('a.txt')).toBe('safe\n');
  });

  it('allows paths outside the workspace when --yolo is enabled', async () => {
    const escaped = path.join(root, 'escaped.txt');
    const patch = unified([
      '--- /dev/null',
      '+++ b/../escaped.txt',
      '@@ -0,0 +1 @@',
      '+escaped',
    ]);

    const result = await registry.execute('ApplyPatch', { patch }, { ...ctx, yolo: true });
    expect(result.isError).toBeUndefined();
    expect(await readFile(escaped, 'utf8')).toBe('escaped\n');
  });

  it('rejects renames and no-newline markers, supports deletion', async () => {
    await put('old.txt', 'old\n');
    await read('old.txt');

    const rename = await registry.execute(
      'ApplyPatch',
      {
        patch: unified([
          '--- a/old.txt',
          '+++ b/renamed.txt',
          '@@ -1 +1 @@',
          '-old',
          '+new',
        ]),
      },
      ctx,
    );
    expect(rename.isError).toBe(true);
    expect(rename.content).toMatch(/rename/i);

    const deletion = await registry.execute(
      'ApplyPatch',
      {
        patch: unified([
          '--- a/old.txt',
          '+++ /dev/null',
          '@@ -1 +0,0 @@',
          '-old',
        ]),
      },
      ctx,
    );
    expect(deletion.isError).toBeUndefined();
    await expect(readText('old.txt')).rejects.toThrow();
    await put('old.txt', 'old\n');
    await read('old.txt');

    const noNewline = await registry.execute(
      'ApplyPatch',
      {
        patch: unified([
          '--- a/old.txt',
          '+++ b/old.txt',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '\\ No newline at end of file',
        ]),
      },
      ctx,
    );
    expect(noNewline.isError).toBe(true);
    expect(noNewline.content).toMatch(/No newline/);
    expect(await readText('old.txt')).toBe('old\n');
  });

  it('rejects malformed hunk counts and headers', async () => {
    await put('a.txt', 'a\n');
    await read('a.txt');

    const truncated = await registry.execute(
      'ApplyPatch',
      {
        patch: unified([
          '--- a/a.txt',
          '+++ b/a.txt',
          '@@ -1,2 +1,2 @@',
          ' a',
        ]),
      },
      ctx,
    );
    expect(truncated.isError).toBe(true);
    expect(truncated.content).toMatch(/declared counts|ends before/);

    const extra = await registry.execute(
      'ApplyPatch',
      {
        patch: unified([
          '--- a/a.txt',
          '+++ b/a.txt',
          '@@ -1 +1 @@',
          '-a',
          '+b',
          '+c',
        ]),
      },
      ctx,
    );
    expect(extra.isError).toBe(true);
    expect(extra.content).toMatch(/more body lines|declares/);

    const badHeader = await registry.execute(
      'ApplyPatch',
      {
        patch: unified([
          '--- a/a.txt',
          '+++ b/a.txt',
          '@@ -1, +1 @@',
          '-a',
          '+b',
        ]),
      },
      ctx,
    );
    expect(badHeader.isError).toBe(true);
    expect(badHeader.content).toMatch(/malformed hunk header/i);
    expect(await readText('a.txt')).toBe('a\n');
  });

  it('handles insertions at the start of a file and preserves a missing final newline', async () => {
    await put('insert.txt', 'a\nb\n');
    await put('no-final-newline.txt', 'first\nsecond');
    await read('insert.txt');
    await read('no-final-newline.txt');

    const patch = unified([
      '--- a/insert.txt',
      '+++ b/insert.txt',
      '@@ -1,0 +1 @@',
      '+start',
      '--- a/no-final-newline.txt',
      '+++ b/no-final-newline.txt',
      '@@ -1,2 +1,2 @@',
      ' first',
      '-second',
      '+SECOND',
    ]);

    const result = await registry.execute('ApplyPatch', { patch }, ctx);
    expect(result.isError).toBeUndefined();
    expect(await readText('insert.txt')).toBe('start\na\nb\n');
    expect(await readText('no-final-newline.txt')).toBe('first\nSECOND');
  });
});
