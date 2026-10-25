import type { AskAnswer } from '../../tools/types.js';

/**
 * Commands the TUI sends back to the core. The TUI never calls models, tools
 * or the session store directly; the CLI/core owns scheduling and execution.
 *
 * approval/resume/fork are contract types for the overlays landing in the next
 * wave; nothing in this assembly emits them yet.
 */
export type UiApprovalDecision = 'allow' | 'allow-session' | 'deny';

export type UiCommand =
  | { type: 'submit'; text: string }
  | { type: 'interrupt' }
  | { type: 'answer'; answers: readonly AskAnswer[] }
  | { type: 'cancel-ask' }
  | { type: 'approval'; decision: UiApprovalDecision; reason?: string }
  | { type: 'resume'; sessionId: string }
  | { type: 'fork'; sessionId: string };
