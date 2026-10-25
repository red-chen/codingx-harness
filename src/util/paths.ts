import path from 'node:path';
import os from 'node:os';
import { realpath } from 'node:fs/promises';

export function expandHome(input: string, home = os.homedir()): string {
  if (input === '~') return home;
  if (input.startsWith('~/') || input.startsWith('~' + path.sep)) {
    return path.join(home, input.slice(2));
  }
  return input;
}

export function resolveUserPath(input: string, cwd = process.cwd()): string {
  return path.resolve(cwd, expandHome(input));
}

/** True when candidate is root itself or lives below it (no prefix tricks). */
export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

/**
 * Resolve symlinks for an existing path. For a not-yet-created target, resolve
 * the nearest existing parent and append the remaining segments.
 */
export async function canonicalizePath(target: string): Promise<string> {
  const absolute = path.resolve(target);
  try {
    return await realpath(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    const canonicalParent = await canonicalizePath(parent);
    return path.join(canonicalParent, path.basename(absolute));
  }
}

export async function isPathInsideReal(root: string, candidate: string): Promise<boolean> {
  const [realRoot, realCandidate] = await Promise.all([canonicalizePath(root), canonicalizePath(candidate)]);
  return isPathInside(realRoot, realCandidate);
}
