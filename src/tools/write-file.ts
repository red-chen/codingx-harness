import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { ToolError } from '../util/errors.js';
import { isPathInside, isPathInsideReal } from '../util/paths.js';
import { resolveWorkspacePath } from './paths.js';
import type { ToolDef } from './types.js';
import { createFileDiff } from './file-diff.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const schema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Path of the file to create or overwrite, relative to the workspace root (or absolute inside an allowed root). Parent directories are created.'),
  content: z.string().describe('Complete UTF-8 content for the file. This replaces any existing content.'),
});

async function readLstat(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ToolError(
      'Cannot access ' + target + ': ' + (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
}

export const writeFileTool: ToolDef<typeof schema> = {
  name: 'Write',
  description:
    'Create or completely overwrite a UTF-8 text file inside the workspace or an --add-dir root. Parent directories are created automatically. ' +
    'Overwriting an existing file requires that file to have been read with Read in this session first; otherwise the write is refused. ' +
    'Directories, binary/non-UTF-8 files and files larger than 10 MiB are rejected. ' +
    'Use Write for new files or full rewrites, and Edit for targeted replacements in an existing file. ' +
    'If an existing file only needs a few changes, use Edit instead: a full overwrite destroys content you have not seen.',
  schema,
  parallelSafe: false,
  approval: 'on-write',
  async execute(input, ctx) {
    const resolved = await resolveWorkspacePath(ctx, input.path, { access: 'write' });
    const relative = resolved.relative;
    const existing = await readLstat(resolved.absolute);
    let before = '';

    if (existing) {
      if (existing.isSymbolicLink()) {
        // resolveWorkspacePath follows valid links; a remaining link here is dangling.
        throw new ToolError(
          'Refusing to write through a symbolic link that does not resolve inside the workspace: ' + input.path + '.',
        );
      }
      if (!existing.isFile()) {
        throw new ToolError('Cannot overwrite ' + relative + ': it is not a regular file (directories are rejected).');
      }
      if (existing.size > MAX_FILE_BYTES) {
        throw new ToolError(
          'File is too large to overwrite (' + Math.ceil(existing.size / 1024 / 1024) + ' MiB); the limit is 10 MiB.',
        );
      }

      const buffer = await readFile(resolved.absolute);
      if (buffer.includes(0)) {
        throw new ToolError('File appears to be binary and cannot be overwritten: ' + relative + '.');
      }
      try {
        before = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        throw new ToolError('File is not valid UTF-8 and cannot be overwritten: ' + relative + '.');
      }

      if (!ctx.readTracker.hasRead(resolved.absolute)) {
        return {
          content:
            'Refusing to overwrite ' + relative + ' before it has been read. Call Read on this file first, then retry Write.',
          isError: true,
          meta: { path: relative, reason: 'read-before-write' },
        };
      }
    } else {
      const parent = path.dirname(resolved.absolute);
      if (!isPathInside(resolved.root, parent)) {
        throw new ToolError('Path is outside the workspace: ' + input.path + '.');
      }
      try {
        await mkdir(parent, { recursive: true });
      } catch (error) {
        throw new ToolError(
          'Cannot create parent directory for ' + relative + ': ' + (error instanceof Error ? error.message : String(error)),
          { cause: error },
        );
      }
      if (!(await isPathInsideReal(resolved.root, parent))) {
        throw new ToolError('Parent directory resolves outside the workspace: ' + input.path + '.');
      }
      // Guard against a symlink that appeared after the initial containment check.
      const parentInfo = await stat(parent);
      if (!parentInfo.isDirectory()) {
        throw new ToolError('Parent path is not a directory: ' + path.dirname(input.path) + '.');
      }
    }

    await writeFile(resolved.absolute, input.content, 'utf8');
    ctx.readTracker.markRead(resolved.absolute);

    const bytes = Buffer.byteLength(input.content, 'utf8');
    const created = existing === undefined;
    return {
      content: (created ? 'Created ' : 'Overwrote ') + relative + ' (' + bytes + ' bytes).',
      meta: { path: relative, created, bytes, fileDiffs: [createFileDiff(relative, before, input.content)] },
    };
  },
};
