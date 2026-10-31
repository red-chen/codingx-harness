import type { AskAnswer } from '../../tools/types.js';

/**
 * Commands the TUI sends back to the core. The TUI never calls models, tools
 * or the session store directly; the CLI/core owns scheduling and execution.
 */
export type UiApprovalDecision =
  | { decision: 'allow'; scope: 'once' | 'session' | 'prefix' }
  | { decision: 'deny'; reason?: string };

export type UiCommand =
  | { type: 'files' }
  | { type: 'pick'; purpose: 'file' | 'session'; value: string; range?: string }
  | { type: 'submit'; text: string }
  | { type: 'interrupt' }
  | { type: 'answer'; answers: readonly AskAnswer[] }
  | { type: 'cancel-ask' }
  | { type: 'approval'; decision: UiApprovalDecision }
  | { type: 'resume'; sessionId: string }
  | { type: 'fork'; sessionId: string };
