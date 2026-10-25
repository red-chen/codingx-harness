import { readFile, stat, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { ToolError } from '../util/errors.js';
import { resolveWorkspacePath } from './paths.js';
import type { ToolDef } from './types.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const schema = z.object({
  path: z.string().min(1).describe('Path to an existing file inside the workspace or an --add-dir root.'),
  old_string: z.string().min(1).describe('Exact text to replace. It must match exactly once unless replace_all is true.'),
  new_string: z.string().describe('Replacement text. May be empty to delete the matched text.'),
  replace_all: z.boolean().optional().default(false).describe('Replace every occurrence instead of requiring a unique match.'),
});

export const editFileTool: ToolDef<typeof schema> = {
  name: 'EditFile',
  description:
    'Replace an exact string in an existing UTF-8 file. By default old_string must appear exactly once; ' +
    'otherwise use replace_all. The file must have been read with ReadFile in this session first. ' +
    'Include enough surrounding context in old_string to make it unique. Use this for targeted edits; ' +
    'do not rewrite unrelated content.',
  schema,
  parallelSafe: false,
  approval: 'on-write',
  async execute(input, ctx) {
    const resolved = await resolveWorkspacePath(ctx, input.path, { mustExist: true, access: 'write' });
    const rel = resolved.relative;

    if (!ctx.readTracker.hasRead(resolved.absolute)) {
      return {
        content:
          'Refusing to edit ' + rel + ' before it has been read. Call ReadFile on this file first, then retry the edit.',
        isError: true,
        meta: { path: rel, reason: 'read-before-write' },
      };
    }

    const info = await stat(resolved.absolute);
    if (!info.isFile()) throw new ToolError('Not a regular file: ' + input.path + '.');
    if (info.size > MAX_FILE_BYTES) {
      throw new ToolError('File is too large to edit (' + Math.ceil(info.size / 1024 / 1024) + ' MiB).');
    }

    const buffer = await readFile(resolved.absolute);
    if (buffer.subarray(0, 8192).includes(0)) throw new ToolError('File appears to be binary: ' + input.path + '.');
    const text = buffer.toString('utf8');

    let occurrences = 0;
    let cursor = 0;
    for (;;) {
      const index = text.indexOf(input.old_string, cursor);
      if (index < 0) break;
      occurrences += 1;
      cursor = index + input.old_string.length;
    }

    if (occurrences === 0) {
      return {
        content: 'old_string was not found in ' + rel + '. Read the file again and copy the exact text, including whitespace.',
        isError: true,
        meta: { path: rel, occurrences: 0 },
      };
    }
    if (occurrences > 1 && !input.replace_all) {
      return {
        content:
          'old_string appears ' + occurrences + ' times in ' + rel + '. Add more surrounding context to make it unique, ' +
          'or pass replace_all=true if every occurrence should change.',
        isError: true,
        meta: { path: rel, occurrences },
      };
    }
    if (input.old_string === input.new_string) {
      return {
        content: 'No changes: old_string and new_string are identical in ' + rel + '.',
        meta: { path: rel, replacements: 0 },
      };
    }

    const next = text.split(input.old_string).join(input.new_string);
    await writeFile(resolved.absolute, next, 'utf8');
    ctx.readTracker.markRead(resolved.absolute);

    const replacements = input.replace_all ? occurrences : 1;
    return {
      content: 'Edited ' + rel + ': replaced ' + replacements + ' occurrence(s).',
      meta: {
        path: rel,
        replacements,
        bytesBefore: buffer.byteLength,
        bytesAfter: Buffer.byteLength(next, 'utf8'),
      },
    };
  },
};
