import type { HookRunResult } from './types.js';

export { HookRunner } from './runner.js';
export type { HookRunnerOptions } from './runner.js';
export type * from './types.js';

/** Human-readable warnings for non-ok hook outcomes (session-level hooks). */
export function hookWarnings(result: HookRunResult | undefined): string[] {
  if (result === undefined) return [];
  return result.outcomes
    .filter((outcome) => outcome.status !== 'ok')
    .map(
      (outcome) =>
        'hook ' + outcome.event + ' ' + outcome.status +
        (outcome.reason === undefined ? '' : ': ' + outcome.reason),
    );
}
