import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ReadFileTracker,
  ToolRegistry,
  createBuiltinTools,
  type ToolContext,
} from '../src/tools/index.js';
import { grepBuiltin } from '../src/tools/grep.js';
import { buildChildEnv } from '../src/exec/index.js';

let root: string;
let cwd: string;
let registry: ToolRegistry;
let ctx: ToolContext;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codingx-m2-tools-'));
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

async function setMtime(relative: string, iso: string): Promise<void> {
  const date = new Date(iso);
  await utimes(path.join(cwd, relative), date, date);
}

describe('Glob', () => {
  it('lists files newest-first relative to the workspace', async () => {
    await put('old.txt', 'old');
    await put('nested/mid.txt', 'mid');
    await put('new.txt', 'new');
    await setMtime('old.txt', '2024-01-01T00:00:00Z');
    await setMtime('nested/mid.txt', '2024-01-02T00:00:00Z');
    await setMtime('new.txt', '2024-01-03T00:00:00Z');

    const result = await registry.execute('Glob', { pattern: '**/*.txt' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('new.txt\nnested/mid.txt\nold.txt');
    expect(result.meta).toEqual({ pattern: '**/*.txt', path: '.', count: 3, truncated: false });
  });

  it('breaks modification-time ties by path ascending', async () => {
    await put('b.txt', 'b');
    await put('a.txt', 'a');
    const fixed = new Date('2024-05-01T00:00:00Z');
    await utimes(path.join(cwd, 'b.txt'), fixed, fixed);
    await utimes(path.join(cwd, 'a.txt'), fixed, fixed);

    const result = await registry.execute('Glob', { pattern: '*.txt' }, ctx);
    expect(result.content).toBe('a.txt\nb.txt');
  });

  it('ignores VCS/dependency/build directories and root .gitignore entries', async () => {
    await put('src/keep.ts', 'x');
    await put('.env', 'dotfile');
    await put('ignored.ts', 'ignored');
    await put('.gitignore', 'ignored.ts\n');
    for (const directory of ['.git', 'node_modules', 'dist', 'build', 'coverage']) {
      await put(directory + '/skip.ts', 'skip');
    }

    const result = await registry.execute('Glob', { pattern: '**/*' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('src/keep.ts');
    expect(result.content).toContain('.env');
    expect(result.content).toContain('.gitignore');
    expect(result.content).not.toContain('skip.ts');
    expect(result.content).not.toContain('ignored.ts');
  });

  it('caps results at 500 and reports truncation', async () => {
    await mkdir(path.join(cwd, 'many'));
    await Promise.all(
      Array.from({ length: 505 }, (_, index) => writeFile(path.join(cwd, 'many', 'f' + index + '.txt'), 'x')),
    );

    const result = await registry.execute('Glob', { pattern: 'many/*.txt' }, ctx);
    const lines = result.content.split('\n');
    expect(lines).toHaveLength(501);
    expect(lines[500]).toContain('[truncated');
    expect(result.meta).toMatchObject({ count: 500, truncated: true });
  });

  it('reports empty results and rejects invalid or escaping requests', async () => {
    const empty = await registry.execute('Glob', { pattern: '*.nope' }, ctx);
    expect(empty.isError).toBeUndefined();
    expect(empty.content).toMatch(/No files matched/);
    expect(empty.meta).toMatchObject({ count: 0, truncated: false });

    await put('file.txt', 'x');
    const notDirectory = await registry.execute('Glob', { pattern: '*', path: 'file.txt' }, ctx);
    expect(notDirectory.isError).toBe(true);
    expect(notDirectory.content).toMatch(/Not a directory/);

    const nul = await registry.execute('Glob', { pattern: 'a\0b' }, ctx);
    expect(nul.isError).toBe(true);
    expect(nul.content).toMatch(/NUL/);

    const outside = await registry.execute('Glob', { pattern: '*', path: '..' }, ctx);
    expect(outside.isError).toBe(true);
    expect(outside.content).toMatch(/outside the workspace/);
  });

  it('does not follow symlinks out of the workspace', async () => {
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(outside, path.join(cwd, 'escape'), 'dir');

    const result = await registry.execute('Glob', { pattern: '**/*.txt' }, ctx);
    expect(result.content).not.toContain('secret');
  });
});

describe('Grep', () => {
  beforeEach(async () => {
    await put('src/a.ts', 'const needle = 1;\nconst other = 2;\n// needle again\n');
    await put('src/b.js', 'needle();\n');
    await put('docs/readme.md', 'nothing here\n');
  });

  it('finds content and reports file:line matches', async () => {
    const result = await registry.execute('Grep', { pattern: 'needle', path: '.' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('src/a.ts:1:const needle = 1;');
    expect(result.content).toContain('src/a.ts:3:// needle again');
    expect(result.content).toContain('src/b.js:1:needle();');
    expect(result.meta).toMatchObject({ pattern: 'needle', path: '.', matches: 3, truncated: false });
    expect(String(result.meta?.engine)).toMatch(/^(rg|builtin)$/);
  });

  it('honors the glob file filter', async () => {
    const result = await registry.execute('Grep', { pattern: 'needle', path: '.', glob: '*.ts' }, ctx);
    expect(result.content).toContain('src/a.ts');
    expect(result.content).not.toContain('src/b.js');
    expect(result.meta).toMatchObject({ matches: 2 });
  });

  it('includes surrounding lines when context is set', async () => {
    const result = await registry.execute('Grep', { pattern: 'needle', path: 'src/a.ts', context: 1 }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('const other = 2;');
    expect(result.content).toMatch(/src\/a\.ts[-:]\d+[-:]/);
    expect(result.meta).toMatchObject({ matches: 2 });
  });

  it('reports no matches without marking the result as an error', async () => {
    const result = await registry.execute('Grep', { pattern: 'definitely-not-present-xyz' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/No matches/);
    expect(result.meta).toMatchObject({ matches: 0, truncated: false });
  });

  it('reports invalid regular expressions as errors', async () => {
    const result = await registry.execute('Grep', { pattern: '[', path: '.' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/regex|regular expression/i);
  });

  it('rejects paths outside the workspace and missing paths', async () => {
    await mkdir(path.join(root, 'outside'));
    const outside = await registry.execute('Grep', { pattern: 'x', path: '../outside' }, ctx);
    expect(outside.isError).toBe(true);
    expect(outside.content).toMatch(/outside the workspace/);

    const missing = await registry.execute('Grep', { pattern: 'x', path: 'nope' }, ctx);
    expect(missing.isError).toBe(true);
    expect(missing.content).toMatch(/not found/);
  });
});

describe('grep builtin fallback', () => {
  it('respects .gitignore, skips binary files and returns file:line output', async () => {
    const canonicalCwd = await realpath(cwd);
    await put('src/hit.ts', 'before\nneedle here\nafter\n');
    await put('ignored.txt', 'needle ignored\n');
    await put('node_modules/pkg/index.js', 'needle dependency\n');
    await put('image.png', Buffer.from([0, 1, 2, 3]));
    await put('.gitignore', 'ignored.txt\n');

    const result = await grepBuiltin({
      workspaceRoot: canonicalCwd,
      target: canonicalCwd,
      pattern: 'needle',
      displayRoot: canonicalCwd,
    });
    expect(result.matches).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.literal).toBe(false);
    expect(result.lines).toEqual(['src/hit.ts:2:needle here']);
  });

  it('falls back to literal matching for invalid regular expressions', async () => {
    const canonicalCwd = await realpath(cwd);
    await put('literal.txt', 'array[0] = 1;\n');

    const result = await grepBuiltin({
      workspaceRoot: canonicalCwd,
      target: canonicalCwd,
      pattern: '[',
      displayRoot: canonicalCwd,
    });
    expect(result.literal).toBe(true);
    expect(result.lines).toEqual(['literal.txt:1:array[0] = 1;']);
  });

  it('truncates after the match cap', async () => {
    const canonicalCwd = await realpath(cwd);
    await put('many.txt', Array.from({ length: 101 }, (_, index) => 'needle ' + index).join('\n'));

    const result = await grepBuiltin({
      workspaceRoot: canonicalCwd,
      target: canonicalCwd,
      pattern: 'needle',
      displayRoot: canonicalCwd,
      maxMatches: 100,
    });
    expect(result.matches).toBe(100);
    expect(result.truncated).toBe(true);
  });
});

describe('grep ripgrep preference', () => {
  it('uses rg when available and falls back when it exits 127', async () => {
    await put('real.txt', 'needle real\n');
    const binDir = path.join(root, 'bin');
    await mkdir(binDir, { recursive: true });
    const rgPath = path.join(binDir, 'rg');
    await writeFile(
      rgPath,
      '#!/bin/sh\nprintf "real.txt:1:needle from rg\n"\nexit 0\n',
      'utf8',
    );
    await chmod(rgPath, 0o755);
    const env = { ...ctx.shell.env, PATH: binDir + path.delimiter + (ctx.shell.env.PATH ?? '') };

    const withRg = await registry.execute('Grep', { pattern: 'needle' }, { ...ctx, shell: { ...ctx.shell, env } });
    expect(withRg.isError).toBeUndefined();
    expect(withRg.meta).toMatchObject({ engine: 'rg', matches: 1, truncated: false });
    expect(withRg.content).toContain('real.txt:1:needle from rg');

    await writeFile(rgPath, '#!/bin/sh\nexit 127\n', 'utf8');
    await chmod(rgPath, 0o755);
    const fallback = await registry.execute('Grep', { pattern: 'needle' }, { ...ctx, shell: { ...ctx.shell, env } });
    expect(fallback.isError).toBeUndefined();
    expect(fallback.meta).toMatchObject({ engine: 'builtin', matches: 1 });
    expect(fallback.content).toContain('real.txt:1:needle real');
  });
});

describe('Write', () => {
  it('creates a file, creates parent directories, reports bytes and marks it read', async () => {
    const result = await registry.execute('Write', { path: 'src/deep/new.txt', content: 'hello\n' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('Created src/deep/new.txt (6 bytes).');
    expect(result.meta).toMatchObject({ path: 'src/deep/new.txt', created: true, bytes: 6 });
    expect(result.meta?.fileDiffs).toMatchObject([{
      path: 'src/deep/new.txt', additions: 1, deletions: 0,
      lines: [{ kind: 'add', line: 1, text: 'hello' }],
    }]);
    expect(await readFile(path.join(cwd, 'src/deep/new.txt'), 'utf8')).toBe('hello\n');
    expect(ctx.readTracker.hasRead(await realpath(path.join(cwd, 'src/deep/new.txt')))).toBe(true);
  });

  it('refuses to overwrite a file that has not been read', async () => {
    const file = await put('existing.txt', 'original');
    const result = await registry.execute('Write', { path: 'existing.txt', content: 'changed' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/before it has been read/);
    expect(result.meta).toMatchObject({ reason: 'read-before-write' });
    expect(await readFile(file, 'utf8')).toBe('original');
  });

  it('overwrites after Read and preserves the existing mode', async () => {
    const file = await put('mode.txt', 'old');
    await chmod(file, 0o640);
    await registry.execute('Read', { path: 'mode.txt' }, ctx);

    const result = await registry.execute('Write', { path: 'mode.txt', content: 'new content' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('Overwrote mode.txt (11 bytes).');
    expect(result.meta).toMatchObject({ path: 'mode.txt', created: false, bytes: 11 });
    expect(result.meta?.fileDiffs).toMatchObject([{
      additions: 1, deletions: 1,
      lines: [{ kind: 'remove', text: 'old' }, { kind: 'add', text: 'new content' }],
    }]);
    expect(await readFile(file, 'utf8')).toBe('new content');
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o640);
    }
  });

  it('rejects directories, binary/non-UTF-8 files and paths outside the workspace', async () => {
    await mkdir(path.join(cwd, 'dir'));
    const directory = await registry.execute('Write', { path: 'dir', content: 'x' }, ctx);
    expect(directory.isError).toBe(true);
    expect(directory.content).toMatch(/not a regular file/);

    const binaryFile = await put('binary.dat', Buffer.from([0x66, 0x00, 0x80]));
    ctx.readTracker.markRead(await realpath(binaryFile));
    const binary = await registry.execute('Write', { path: 'binary.dat', content: 'x' }, ctx);
    expect(binary.isError).toBe(true);
    expect(binary.content).toMatch(/binary/);

    const invalidFile = await put('invalid.txt', Buffer.from([0x66, 0x6f, 0x80]));
    ctx.readTracker.markRead(await realpath(invalidFile));
    const invalid = await registry.execute('Write', { path: 'invalid.txt', content: 'x' }, ctx);
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toMatch(/UTF-8/);

    const outside = await registry.execute('Write', { path: '../outside.txt', content: 'x' }, ctx);
    expect(outside.isError).toBe(true);
    expect(outside.content).toMatch(/outside the workspace/);
  });

  it('refuses to write through a dangling symlink', async () => {
    const target = path.join(root, 'missing-outside.txt');
    await symlink(target, path.join(cwd, 'dangling.txt'));
    const result = await registry.execute('Write', { path: 'dangling.txt', content: 'x' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/symbolic link/);
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
