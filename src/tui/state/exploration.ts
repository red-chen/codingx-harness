/** Presentation-only summaries; never use these labels for permission decisions. */
export function explorationLabel(name: string, input: unknown): string | undefined {
  const value = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  const path = typeof value.path === 'string' ? value.path : '.';
  if (name === 'Read' || name === 'ReadFile') return 'Read ' + path;
  if (name === 'ListDir') return 'List ' + path;
  if (name === 'Grep' || name === 'Glob') {
    return 'Search ' + (typeof value.pattern === 'string' ? value.pattern : '') + ' in ' + path;
  }
  return undefined;
}

export function isExploration(name: string): boolean {
  return ['Read', 'ReadFile', 'ListDir', 'Grep', 'Glob'].includes(name);
}
