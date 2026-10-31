import path from 'node:path';
import { stat } from 'node:fs/promises';
import { ToolError } from '../util/errors.js';
import { canonicalizePath, expandHome, isPathInside } from '../util/paths.js';
import type { ToolContext } from './types.js';

export interface ResolvedWorkspacePath {
  /**
   * Canonical root used by callers for ignore rules and containment checks.
   * Normally the allowed root that contains the path; with --yolo and a path
   * outside every root, the path itself (directory) or its parent (file).
   */
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

/** Canonical workspace/add-dir roots plus policy roots for this access mode. */
async function allowedRoots(
  ctx: ToolContext,
  access: 'read' | 'write',
): Promise<{ workspaceRoot: string; roots: string[] }> {
  const workspaceRoot = await canonicalizePath(ctx.cwd);
  const roots = [workspaceRoot];
  for (const directory of ctx.additionalDirs ?? []) {
    const root = await canonicalizePath(directory);
    if (!roots.includes(root)) roots.push(root);
  }
  for (const root of ctx.policy?.rootsFor(access) ?? []) {
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
 * allowed root is rejected. With ctx.yolo the containment check is skipped;
 * the returned root is then the path's own directory (or the path itself when
 * it is a directory) so callers keep working.
 */
export async function resolveWorkspacePath(
  ctx: ToolContext,
  input: string,
  options: { mustExist?: boolean; access?: 'read' | 'write' } = {},
): Promise<ResolvedWorkspacePath> {
  if (input.length === 0) throw new ToolError('Path must not be empty.');
  if (input.includes('\0')) throw new ToolError('Path must not contain NUL bytes.');

  const access = options.access ?? 'read';
  const { workspaceRoot, roots } = await allowedRoots(ctx, access);
  const absolute = path.resolve(ctx.cwd, expandHome(input));
  if (access === 'write') ctx.readTracker.assertUnchanged(absolute);
  const canonical = await canonicalizePath(absolute);
  if (access === 'write') ctx.readTracker.assertUnchanged(canonical);

  if (ctx.policy?.isPathDenied(canonical) === true) {
    throw new ToolError('Path is denied by the permission profile: ' + input + '.');
  }

  const yolo = ctx.yolo === true || ctx.policy?.yolo === true;
  const matchedRoot = roots.find((candidate) => isPathInside(candidate, canonical));
  if (matchedRoot === undefined && !yolo) throw outsideWorkspace(input, roots);

  let exists = false;
  let isDirectory = false;
  try {
    const info = await stat(canonical);
    exists = true;
    isDirectory = info.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ToolError('Cannot access ' + input + ': ' + (error instanceof Error ? error.message : String(error)), {
        cause: error,
      });
    }
  }
  if (options.mustExist && !exists) throw new ToolError('File or directory not found: ' + input + '.');

  return {
    root: matchedRoot ?? (isDirectory ? canonical : path.dirname(canonical)),
    workspaceRoot,
    absolute: canonical,
    relative: path.relative(workspaceRoot, canonical) || '.',
    exists,
  };
}
