import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { ToolError } from '../util/errors.js';
import { resolveWorkspacePath } from './paths.js';
import type { ToolDef } from './types.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const schema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Path to the file, relative to the workspace root (or absolute inside an allowed root).'),
  offset: z.number().int().min(1).optional().default(1).describe('1-based first line to return. Defaults to 1.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .optional()
    .default(2000)
    .describe('Maximum number of lines to return. Defaults to 2000.'),
});

export const readFileTool: ToolDef<typeof schema> = {
  name: 'ReadFile',
  description:
    'Read a UTF-8 text file inside the workspace or an --add-dir root by line, with line numbers. ' +
    'Use offset and limit to page through large files. The response states the total line count and whether more lines remain. ' +
    'You must call ReadFile on a file before editing it with EditFile. ' +
    'Binary files are rejected; use Grep for content search and ListDir for directories. ' +
    'Prefer ReadFile over Shell commands such as cat, head or sed; if the file is large, read only the range you need.',
  schema,
  parallelSafe: true,
  approval: 'none',
  async execute(input, ctx) {
    const resolved = await resolveWorkspacePath(ctx, input.path, { mustExist: true, access: 'read' });
    const info = await stat(resolved.absolute);
    if (!info.isFile()) throw new ToolError('Not a regular file: ' + input.path + '. Use ListDir for directories.');
    if (info.size > MAX_FILE_BYTES) {
      throw new ToolError(
        'File is too large to read (' + Math.ceil(info.size / 1024 / 1024) + ' MiB); the limit is 10 MiB.',
      );
    }

    const buffer = await readFile(resolved.absolute);
    if (buffer.subarray(0, 8192).includes(0)) {
      throw new ToolError('File appears to be binary: ' + input.path + '.');
    }
    const text = buffer.toString('utf8');
    const offset = input.offset ?? 1;
    const limit = input.limit ?? 2000;
    const rel = resolved.relative;

    let lines: string[];
    if (text.length === 0) {
      lines = [];
    } else {
      lines = text.split('\n');
      if (text.endsWith('\n')) lines.pop();
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? '';
        if (line.endsWith('\r')) lines[index] = line.slice(0, -1);
      }
    }

    ctx.readTracker.markRead(resolved.absolute);

    if (lines.length === 0) {
      return {
        content: 'File ' + rel + ' is empty (0 lines).',
        meta: { path: rel, totalLines: 0, offset, returnedLines: 0 },
      };
    }

    if (offset > lines.length) {
      return {
        content:
          'File ' + rel + ' has ' + lines.length + ' line(s); offset ' + offset + ' is past the end of the file.',
        meta: { path: rel, totalLines: lines.length, offset, returnedLines: 0 },
      };
    }

    const start = offset - 1;
    const end = Math.min(start + limit, lines.length);
    const width = String(end).length;
    const body = lines
      .slice(start, end)
      .map((line, index) => String(start + index + 1).padStart(width, ' ') + '\t' + line)
      .join('\n');

    const more = end < lines.length ? '\n\n[Showing lines ' + (start + 1) + '-' + end + ' of ' + lines.length +
      '. Use offset=' + (end + 1) + ' to continue.]' : '';
    return {
      content: body + more,
      meta: {
        path: rel,
        totalLines: lines.length,
        offset,
        returnedLines: end - start,
        hasMore: end < lines.length,
      },
    };
  },
};
