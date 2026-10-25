import path from 'node:path';
import { stat } from 'node:fs/promises';
import { ToolError } from '../util/errors.js';
import { canonicalizePath, expandHome, isPathInside } from '../util/paths.js';
import type { ToolContext } from './types.js';

export interface ResolvedWorkspacePath {
  /** Canonical allowed root that contains the resolved path (symlinks resolved). */
  root: string;
  /** Canonical primary workspace root (`ctx.cwd`). */
  workspaceRoot: string;
  absolute: string;
  /**
   * Path relative to the primary workspace root. This keeps every path returned
   * to the model usable as a tool input, including files under --add-dir roots.
   * On Windows a different drive yields an absolute path.
   */
  relative: string;
  exists: boolean;
}

/** Canonical primary workspace plus every --add-dir root, without duplicates. */
async function allowedRoots(ctx: ToolContext): Promise<{ workspaceRoot: string; roots: string[] }> {
  const workspaceRoot = await canonicalizePath(ctx.cwd);
  const roots = [workspaceRoot];
  for (const directory of ctx.additionalDirs ?? []) {
    const root = await canonicalizePath(directory);
    if (!roots.includes(root)) roots.push(root);
  }
  return { workspaceRoot, roots };
}

function outsideWorkspace(input: string, roots: readonly string[]): ToolError {
  const scope =
    roots.length === 1
      ? 'File tools are confined to ' + roots[0] + '.'
      : 'Allowed workspace roots: ' + roots.join(', ') + '.';
  return new ToolError('Path is outside the workspace: ' + input + '. ' + scope);
}

/**
 * Resolve a model-provided path inside the primary workspace or one of the
 * --add-dir roots. Symlinks are followed, so a link pointing outside every
 * allowed root is rejected.
 */
export async function resolveWorkspacePath(
  ctx: ToolContext,
  input: string,
  options: { mustExist?: boolean } = {},
): Promise<ResolvedWorkspacePath> {
  if (input.length === 0) throw new ToolError('Path must not be empty.');
  if (input.includes('\0')) throw new ToolError('Path must not contain NUL bytes.');

  const { workspaceRoot, roots } = await allowedRoots(ctx);
  const absolute = path.resolve(ctx.cwd, expandHome(input));
  const canonical = await canonicalizePath(absolute);
  const root = roots.find((candidate) => isPathInside(candidate, canonical));
  if (root === undefined) throw outsideWorkspace(input, roots);

  let exists = false;
  try {
    await stat(canonical);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ToolError('Cannot access ' + input + ': ' + (error instanceof Error ? error.message : String(error)), {
        cause: error,
      });
    }
  }
  if (options.mustExist && !exists) throw new ToolError('File or directory not found: ' + input + '.');

  return {
    root,
    workspaceRoot,
    absolute: canonical,
    relative: path.relative(workspaceRoot, canonical) || '.',
    exists,
  };
}
