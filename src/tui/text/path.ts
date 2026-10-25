/** Abbreviate a path under the user's home directory with a leading tilde. */
export function tildifyPath(cwd: string, home?: string): string {
  const clean = cwd.replace(/\s+/gu, ' ').trim();
  if (!home) return clean;
  const normalizedHome = home.replace(/[\\/]+$/u, '');
  if (normalizedHome.length === 0) return clean;
  if (clean === normalizedHome || clean === normalizedHome + '/') return '~';
  if (clean.startsWith(normalizedHome + '/')) return '~' + clean.slice(normalizedHome.length);
  return clean;
}
