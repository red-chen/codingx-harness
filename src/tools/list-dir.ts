import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import ignore from 'ignore';
import { ToolError } from '../util/errors.js';
import { canonicalizePath } from '../util/paths.js';
import { resolveWorkspacePath } from './paths.js';
import type { ToolDef } from './types.js';

const MAX_ENTRIES = 500;

const DEFAULT_IGNORES = [
  '.git/',
  'node_modules/',
  'dist/',
  'build/',
  'coverage/',
  '.codingx/',
  '.DS_Store',
  '*.log',
];

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.7z',
  '.jar', '.class', '.so', '.dylib', '.dll', '.exe', '.bin', '.wasm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.flac',
  '.sqlite', '.db',
]);

const schema = z.object({
  path: z
    .string()
    .min(1)
    .default('.')
    .describe('Directory to list, relative to the workspace root or absolute inside an allowed root. Defaults to the root.'),
  depth: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .default(2)
    .describe('Maximum directory depth below path. 0 lists only direct children. Defaults to 2.'),
});

function isBinaryName(name: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export const listDirTool: ToolDef<typeof schema> = {
  name: 'ListDir',
  description:
    'List a directory tree inside the workspace or an --add-dir root. The root .gitignore and common build/dependency directories are respected, ' +
    'and binary files are hidden. depth 0 lists direct children; depth defaults to 2. Output is capped at 500 entries.',
  schema,
  parallelSafe: true,
  approval: 'none',
  async execute(input, ctx) {
    const requested = input.path ?? '.';
    const depth = input.depth ?? 2;
    const resolved = await resolveWorkspacePath(ctx, requested, { mustExist: true, access: 'read' });
    const info = await stat(resolved.absolute);
    if (!info.isDirectory()) throw new ToolError('Not a directory: ' + requested + '. Use ReadFile for files.');

    const root = resolved.root;
    let gitignore = '';
    try {
      gitignore = await readFile(path.join(root, '.gitignore'), 'utf8');
    } catch {
      // A missing .gitignore is fine.
    }
    const matcher = ignore().add(DEFAULT_IGNORES);
    if (gitignore.trim().length > 0) matcher.add(gitignore);

    const lines: string[] = [];
    let count = 0;
    let truncated = false;

    const walk = async (directory: string, level: number): Promise<void> => {
      if (truncated) return;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        throw new ToolError('Cannot list ' + directory + ': ' + (error instanceof Error ? error.message : String(error)), {
          cause: error,
        });
      }
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      for (const entry of entries) {
        if (truncated) return;
        const absolute = path.join(directory, entry.name);
        if (ctx.policy?.isPathDenied(await canonicalizePath(absolute)) === true) continue;
        const relativeToRoot = path.relative(root, absolute).split(path.sep).join('/');
        const ignoreKey = relativeToRoot + (entry.isDirectory() ? '/' : '');
        try {
          if (matcher.ignores(ignoreKey)) continue;
        } catch {
          continue;
        }
        if (entry.isFile() && isBinaryName(entry.name)) continue;
        if (count >= MAX_ENTRIES) {
          truncated = true;
          return;
        }
        const suffix = entry.isDirectory() ? '/' : entry.isSymbolicLink() ? '@' : '';
        lines.push('  '.repeat(level) + entry.name + suffix);
        count += 1;
        if (entry.isDirectory() && level < depth) await walk(absolute, level + 1);
      }
    };

    await walk(resolved.absolute, 0);
    const rel = resolved.relative;
    const body = lines.length === 0 ? '(empty directory)' : lines.join('\n');
    const footer = truncated ? '\n[truncated after ' + MAX_ENTRIES + ' entries]' : '';
    return {
      content: body + footer,
      meta: { path: rel, entries: count, depth, truncated },
    };
  },
};
