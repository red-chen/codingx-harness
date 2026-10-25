import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import ignore from 'ignore';
import { z } from 'zod';
import { ToolError } from '../util/errors.js';
import { canonicalizePath, isPathInside } from '../util/paths.js';
import { resolveWorkspacePath } from './paths.js';
import type { ToolDef } from './types.js';

const MAX_ENTRIES = 500;
const IGNORE_PATTERNS = ['.git/**', 'node_modules/**', 'dist/**', 'build/**', 'coverage/**'];

const schema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe(
      'Glob pattern matched against file names and paths, for example "**/*.ts" or "src/**/*.test.ts". ' +
        'This searches file names only, never file contents.',
    ),
  path: z
    .string()
    .min(1)
    .optional()
    .default('.')
    .describe('Directory to search, relative to the workspace root (or absolute inside an allowed root). Defaults to the workspace root.'),
});

type IgnoreMatcher = ReturnType<typeof ignore>;

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Root .gitignore semantics, matching ListDir; missing files are fine. */
async function loadGitignore(root: string): Promise<IgnoreMatcher | undefined> {
  try {
    const text = await readFile(path.join(root, '.gitignore'), 'utf8');
    if (text.trim().length === 0) return undefined;
    return ignore().add(text);
  } catch {
    return undefined;
  }
}

export const globTool: ToolDef<typeof schema> = {
  name: 'Glob',
  description:
    'Find files by file-name/path pattern inside the workspace or an --add-dir root, for example "**/*.ts" or "src/**/test-*.js". ' +
    'Use this to discover file names and locations; use Grep instead to search file contents. ' +
    'Results are one workspace-relative path per line, sorted by modification time (newest first) with path as the tie-breaker. ' +
    'The root .gitignore and .git/node_modules/dist/build/coverage directories are ignored. ' +
    'Results are capped at 500 files with an explicit truncation footer; narrow the pattern or path when truncated.',
  schema,
  parallelSafe: true,
  approval: 'none',
  async execute(input, ctx) {
    if (input.pattern.includes('\0')) throw new ToolError('Glob pattern must not contain NUL bytes.');

    const requested = input.path ?? '.';
    const resolved = await resolveWorkspacePath(ctx, requested, { mustExist: true });
    const info = await stat(resolved.absolute);
    if (!info.isDirectory()) {
      throw new ToolError('Not a directory: ' + requested + '. Glob only searches directories; use ReadFile for a file.');
    }

    const entries = await fg(input.pattern, {
      cwd: resolved.absolute,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
      stats: true,
      ignore: IGNORE_PATTERNS,
    });

    const gitignore = await loadGitignore(resolved.root);
    const candidates: { path: string; mtimeMs: number }[] = [];

    for (const entry of entries) {
      const absolute = path.resolve(resolved.absolute, entry.path);
      // Symlink safety: only report files whose real path stays in the workspace
      // (and inside the directory that was searched).
      const canonical = await canonicalizePath(absolute);
      if (!isPathInside(resolved.root, canonical)) continue;
      if (!isPathInside(resolved.absolute, canonical)) continue;

      if (gitignore) {
        const relativeToRoot = path.relative(resolved.root, canonical).split(path.sep).join('/');
        try {
          if (gitignore.ignores(relativeToRoot)) continue;
        } catch {
          continue;
        }
      }

      let mtimeMs = entry.stats?.mtimeMs;
      if (mtimeMs === undefined) {
        try {
          mtimeMs = (await stat(canonical)).mtimeMs;
        } catch {
          continue;
        }
      }
      candidates.push({
        // Reported paths stay relative to the primary workspace so the model
        // can pass them straight back into ReadFile/EditFile.
        path: path.relative(resolved.workspaceRoot, canonical).split(path.sep).join('/'),
        mtimeMs,
      });
    }

    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || comparePaths(left.path, right.path));

    const truncated = candidates.length > MAX_ENTRIES;
    const shown = candidates.slice(0, MAX_ENTRIES);
    const meta = { pattern: input.pattern, path: resolved.relative, count: shown.length, truncated };

    if (shown.length === 0) {
      const where = resolved.relative === '.' ? 'the workspace root' : resolved.relative;
      return {
        content:
          'No files matched "' + input.pattern + '" in ' + where + '. ' +
          'Glob matches file names only (use Grep for file contents). ' +
          'The root .gitignore and .git/node_modules/dist/build/coverage are excluded.',
        meta,
      };
    }

    const footer = truncated
      ? '\n[truncated: showing the newest ' + MAX_ENTRIES + ' of ' + candidates.length +
        ' matching files; narrow the pattern or path to see the rest]'
      : '';
    return {
      content: shown.map((candidate) => candidate.path).join('\n') + footer,
      meta,
    };
  },
};
