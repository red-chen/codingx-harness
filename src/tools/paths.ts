import path from 'node:path';
import { stat } from 'node:fs/promises';
import { ToolError } from '../util/errors.js';
import { canonicalizePath, expandHome, isPathInside, isPathInsideReal } from '../util/paths.js';
import type { ToolContext } from './types.js';

export interface ResolvedWorkspacePath {
  /** Canonical workspace root (symlinks resolved). */
  root: string;
  absolute: string;
  relative: string;
  exists: boolean;
}

/**
 * Resolve a model-provided path inside the workspace. Symlinks are followed,
 * so a link pointing outside the workspace is rejected.
 */
export async function resolveWorkspacePath(
  ctx: ToolContext,
  input: string,
  options: { mustExist?: boolean } = {},
): Promise<ResolvedWorkspacePath> {
  if (input.length === 0) throw new ToolError('Path must not be empty.');
  if (input.includes('\0')) throw new ToolError('Path must not contain NUL bytes.');

  const root = await canonicalizePath(ctx.cwd);
  const absolute = path.resolve(ctx.cwd, expandHome(input));
  if (!(await isPathInsideReal(root, absolute))) {
    throw new ToolError('Path is outside the workspace: ' + input + '. M1 file tools are confined to ' + root + '.');
  }
  const canonical = await canonicalizePath(absolute);
  if (!isPathInside(root, canonical)) {
    throw new ToolError('Path resolves outside the workspace: ' + input + '.');
  }

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
    absolute: canonical,
    relative: path.relative(root, canonical) || '.',
    exists,
  };
}
