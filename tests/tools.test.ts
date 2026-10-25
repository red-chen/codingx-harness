import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  ReadFileTracker,
  ToolRegistry,
  createBuiltinTools,
  type ToolContext,
  type ToolDef,
} from '../src/tools/index.js';
import { abortError } from '../src/util/errors.js';
import { buildChildEnv } from '../src/exec/index.js';

let root: string;
let cwd: string;
let registry: ToolRegistry;
let ctx: ToolContext;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codingx-tools-'));
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

describe('ToolRegistry', () => {
  it('keeps registration order and generates stable JSON schemas', () => {
    expect(registry.list().map((tool) => tool.name)).toEqual([
      'read_file',
      'list_dir',
      'glob',
      'grep',
      'write_file',
      'edit_file',
      'update_plan',
      'apply_patch',
      'shell',
    ]);
    const schemas = registry.toJsonSchemas();
    expect(schemas.map((schema) => schema.name)).toEqual([
      'read_file',
      'list_dir',
      'glob',
      'grep',
      'write_file',
      'edit_file',
      'update_plan',
      'apply_patch',
      'shell',
    ]);
    expect(schemas[0]?.inputSchema).toMatchObject({ type: 'object' });
    expect(JSON.stringify(schemas[0]?.inputSchema)).toContain('"path"');
  });

  it('rejects duplicate names', () => {
    const tool: ToolDef = {
      name: 'read_file',
      description: 'duplicate',
      schema: z.object({}),
      parallelSafe: true,
      approval: 'none',
      execute: async () => ({ content: 'x' }),
    };
    expect(() => registry.register(tool)).toThrow(/Duplicate tool name/);
  });

  it('returns is_error results for unknown tools and invalid input', async () => {
    const unknown = await registry.execute('nope', {}, ctx);
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toMatch(
      /Available tools: read_file, list_dir, glob, grep, write_file, edit_file, update_plan, apply_patch, shell/,
    );

    const invalid = await registry.execute('read_file', { path: 42 }, ctx);
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toMatch(/Invalid input for tool "read_file"/);
  });

  it('converts thrown tool errors into is_error results', async () => {
    const broken: ToolDef = {
      name: 'broken',
      description: 'always fails',
      schema: z.object({}),
      parallelSafe: false,
      approval: 'none',
      execute: async () => {
        throw new Error('kaboom');
      },
    };
    registry.register(broken);
    const result = await registry.execute('broken', {}, ctx);
    expect(result).toMatchObject({ isError: true, content: 'Tool "broken" failed: kaboom' });
  });

  it('propagates aborts instead of turning them into tool results', async () => {
    const aborting: ToolDef = {
      name: 'aborting',
      description: 'aborts',
      schema: z.object({}),
      parallelSafe: false,
      approval: 'none',
      execute: async () => {
        throw abortError();
      },
    };
    registry.register(aborting);
    await expect(registry.execute('aborting', {}, ctx)).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('caps tool output and marks metadata', async () => {
    const verbose: ToolDef = {
      name: 'verbose',
      description: 'large output',
      schema: z.object({}),
      parallelSafe: true,
      approval: 'none',
      execute: async () => ({ content: 'x'.repeat(500), meta: { ok: true } }),
    };
    registry.register(verbose);
    const result = await registry.execute('verbose', {}, { ...ctx, maxOutputChars: 100 });
    expect(result.content).toContain('tool output truncated');
    expect(result.content.length).toBe(100);
    expect(result.meta).toEqual({ ok: true, truncated: true });
  });
});

describe('read_file', () => {
  it('reads line-numbered windows and reports continuation', async () => {
    await put('src/util.ts', 'line1\nline2\nline3\nline4\nline5\n');
    const all = await registry.execute('read_file', { path: 'src/util.ts' }, ctx);
    expect(all.isError).toBeUndefined();
    expect(all.content).toBe('1\tline1\n2\tline2\n3\tline3\n4\tline4\n5\tline5');
    expect(all.meta).toMatchObject({ totalLines: 5, returnedLines: 5 });

    const window = await registry.execute('read_file', { path: 'src/util.ts', offset: 2, limit: 2 }, ctx);
    expect(window.content).toContain('2\tline2');
    expect(window.content).toContain('3\tline3');
    expect(window.content).toContain('[Showing lines 2-3 of 5. Use offset=4 to continue.]');
    expect(window.meta).toMatchObject({ hasMore: true });
  });

  it('marks files as read for read-before-write', async () => {
    await put('a.txt', 'hello');
    expect(ctx.readTracker.size).toBe(0);
    await registry.execute('read_file', { path: 'a.txt' }, ctx);
    expect(ctx.readTracker.size).toBe(1);
  });

  it('handles empty files, past-EOF offsets and missing files', async () => {
    await put('empty.txt', '');
    const empty = await registry.execute('read_file', { path: 'empty.txt' }, ctx);
    expect(empty.content).toMatch(/is empty/);
    expect(empty.meta).toMatchObject({ totalLines: 0 });

    await put('two.txt', 'a\nb');
    const past = await registry.execute('read_file', { path: 'two.txt', offset: 10 }, ctx);
    expect(past.content).toMatch(/offset 10 is past the end/);

    const missing = await registry.execute('read_file', { path: 'nope.txt' }, ctx);
    expect(missing.isError).toBe(true);
    expect(missing.content).toMatch(/not found/);
  });

  it('rejects directories, binary files, and paths escaping the workspace', async () => {
    await put('dir/file.txt', 'x');
    await put('image.bin', Buffer.from([0, 1, 2, 3]));
    await put('../outside.txt', 'secret');

    const directory = await registry.execute('read_file', { path: 'dir' }, ctx);
    expect(directory.isError).toBe(true);
    expect(directory.content).toMatch(/Not a regular file/);

    const binary = await registry.execute('read_file', { path: 'image.bin' }, ctx);
    expect(binary.isError).toBe(true);
    expect(binary.content).toMatch(/binary/);

    const outside = await registry.execute('read_file', { path: '../outside.txt' }, ctx);
    expect(outside.isError).toBe(true);
    expect(outside.content).toMatch(/outside the workspace/);
  });

  it('rejects symlinks that resolve outside the workspace', async () => {
    const outside = path.join(root, 'secret.txt');
    await writeFile(outside, 'secret');
    await symlink(outside, path.join(cwd, 'link.txt'));
    const result = await registry.execute('read_file', { path: 'link.txt' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the workspace/);
  });
});

describe('list_dir', () => {
  beforeEach(async () => {
    await put('README.md', 'readme');
    await put('src/main.ts', 'main');
    await put('src/nested/deep.ts', 'deep');
    await put('ignored.txt', 'ignored');
    await put('build/out.js', 'built');
    await put('node_modules/pkg/index.js', 'dep');
    await put('image.png', 'not really a png');
    await put('temp.tmp', 'temp');
    await put('.gitignore', 'ignored.txt\nbuild/\n*.tmp\n');
  });

  it('renders a depth-limited tree and honors ignore rules', async () => {
    const result = await registry.execute('list_dir', { path: '.', depth: 2 }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('README.md');
    expect(result.content).toContain('src/');
    expect(result.content).toContain('  main.ts');
    expect(result.content).toContain('  nested/');
    expect(result.content).toContain('    deep.ts');
    expect(result.content).not.toContain('ignored.txt');
    expect(result.content).not.toContain('build/');
    expect(result.content).not.toContain('node_modules');
    expect(result.content).not.toContain('image.png');
    expect(result.content).not.toContain('temp.tmp');
    expect(result.meta).toMatchObject({ depth: 2, truncated: false });
  });

  it('supports depth 0 and subdirectories', async () => {
    const shallow = await registry.execute('list_dir', { path: '.', depth: 0 }, ctx);
    expect(shallow.content).toContain('src/');
    expect(shallow.content).not.toContain('main.ts');

    const sub = await registry.execute('list_dir', { path: 'src', depth: 1 }, ctx);
    expect(sub.content).toContain('main.ts');
    expect(sub.content).toContain('nested/');
    expect(sub.content).toContain('  deep.ts');
  });

  it('rejects files and paths outside the workspace', async () => {
    const file = await registry.execute('list_dir', { path: 'README.md' }, ctx);
    expect(file.isError).toBe(true);
    expect(file.content).toMatch(/Not a directory/);

    await mkdir(path.join(root, 'outside'));
    const outside = await registry.execute('list_dir', { path: '../outside' }, ctx);
    expect(outside.isError).toBe(true);
    expect(outside.content).toMatch(/outside the workspace/);
  });

  it('caps listings at 500 entries', async () => {
    await mkdir(path.join(cwd, 'many'));
    await Promise.all(
      Array.from({ length: 505 }, (_, index) => writeFile(path.join(cwd, 'many', 'f' + index + '.txt'), 'x')),
    );
    const result = await registry.execute('list_dir', { path: 'many', depth: 0 }, ctx);
    expect(result.meta).toMatchObject({ entries: 500, truncated: true });
    expect(result.content).toContain('[truncated after 500 entries]');
  });
});

describe('edit_file', () => {
  it('requires a prior read, then replaces a unique string', async () => {
    await put('src/util.ts', 'const foo = 1;\nexport { foo };\n');
    const denied = await registry.execute(
      'edit_file',
      { path: 'src/util.ts', old_string: 'foo', new_string: 'bar' },
      ctx,
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toMatch(/before it has been read/);

    await registry.execute('read_file', { path: 'src/util.ts' }, ctx);
    const edited = await registry.execute(
      'edit_file',
      { path: 'src/util.ts', old_string: 'const foo', new_string: 'const bar' },
      ctx,
    );
    expect(edited.isError).toBeUndefined();
    expect(edited.content).toMatch(/replaced 1 occurrence/);
    expect(await (await import('node:fs/promises')).readFile(path.join(cwd, 'src/util.ts'), 'utf8')).toBe(
      'const bar = 1;\nexport { foo };\n',
    );
  });

  it('rejects missing and ambiguous matches, with an opt-in replace_all', async () => {
    await put('multi.txt', 'foo foo foo');
    await registry.execute('read_file', { path: 'multi.txt' }, ctx);

    const missing = await registry.execute(
      'edit_file',
      { path: 'multi.txt', old_string: 'nope', new_string: 'x' },
      ctx,
    );
    expect(missing.isError).toBe(true);
    expect(missing.content).toMatch(/was not found/);

    const ambiguous = await registry.execute(
      'edit_file',
      { path: 'multi.txt', old_string: 'foo', new_string: 'bar' },
      ctx,
    );
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content).toMatch(/appears 3 times/);

    const all = await registry.execute(
      'edit_file',
      { path: 'multi.txt', old_string: 'foo', new_string: 'bar', replace_all: true },
      ctx,
    );
    expect(all.content).toMatch(/replaced 3 occurrence/);
    expect(await (await import('node:fs/promises')).readFile(path.join(cwd, 'multi.txt'), 'utf8')).toBe('bar bar bar');
  });

  it('returns a no-op for identical strings and refuses outside paths', async () => {
    await put('same.txt', 'abc');
    await registry.execute('read_file', { path: 'same.txt' }, ctx);
    const noop = await registry.execute(
      'edit_file',
      { path: 'same.txt', old_string: 'abc', new_string: 'abc' },
      ctx,
    );
    expect(noop.content).toMatch(/No changes/);

    await put('../outside.txt', 'abc');
    const outside = await registry.execute(
      'edit_file',
      { path: '../outside.txt', old_string: 'abc', new_string: 'def' },
      ctx,
    );
    expect(outside.isError).toBe(true);
    expect(outside.content).toMatch(/outside the workspace/);
  });
});

describe('shell', () => {
  it('runs commands in the workspace and reports structured output', async () => {
    const result = await registry.execute(
      'shell',
      { command: 'echo hello', description: 'say hello' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('exit_code: 0');
    expect(result.content).toContain('hello');
    expect(result.meta).toMatchObject({
      exitCode: 0,
      timedOut: false,
      description: 'say hello',
      cwd: '.',
    });
  });

  it('honors cwd and reports non-zero exits as errors', async () => {
    await put('sub/marker.txt', 'marker');
    const result = await registry.execute(
      'shell',
      { command: 'cat marker.txt && exit 3', cwd: 'sub' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('marker');
    expect(result.content).toContain('exit_code: 3');
    expect(result.meta).toMatchObject({ exitCode: 3, cwd: 'sub' });
  });

  it('times out and marks the result as an error', async () => {
    const result = await registry.execute('shell', { command: 'sleep 5', timeout_ms: 200 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.meta).toMatchObject({ timedOut: true });
    expect(result.content).toMatch(/timed out after 200ms/);
  });

  it('rejects cwd outside the workspace', async () => {
    await mkdir(path.join(root, 'outside'));
    const result = await registry.execute('shell', { command: 'pwd', cwd: '../outside' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the workspace/);
  });

  it('propagates aborts as turn aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      registry.execute('shell', { command: 'echo hi' }, { ...ctx, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('caps oversized shell output', async () => {
    const result = await registry.execute(
      'shell',
      { command: 'yes a | head -c 2000' },
      { ...ctx, maxOutputChars: 300 },
    );
    expect(result.content).toContain('tool output truncated');
    expect(result.content.length).toBe(300);
    expect(result.meta).toMatchObject({ truncated: true });
  });
});
