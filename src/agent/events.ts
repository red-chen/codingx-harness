import type { TokenUsage, ToolCall } from '../providers/types.js';
import type { HookEvent, HookStatus } from '../hooks/types.js';
import type { PlanStep, ToolResult } from '../tools/types.js';

export type TurnFinishedStatus = 'done' | 'aborted' | 'error';

export interface TurnErrorInfo {
  code: string;
  message: string;
  category?: string;
}

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  model: string;
}

/**
 * Events from the agent core to the UI. UI commands travel the other way
 * (see tui.md); the M1 plain renderer consumes this union.
 */
export type UiEvent =
  | { type: 'attachments.prepared'; items: Array<{ name: string; bytes: number; kind: 'file' | 'image' }> }
  | { type: 'usage.recorded'; record: import('../providers/usage.js').RequestUsage }
  | { type: 'session.info'; session: SessionInfo }
  | { type: 'turn.started'; turnId: string }
  | { type: 'text.delta'; turnId: string; text: string }
  | { type: 'tool.started'; turnId: string; call: ToolCall }
  | { type: 'tool.finished'; turnId: string; callId: string; name: string; result: ToolResult; durationMs: number }
  | { type: 'llm.finished'; turnId: string; durationMs: number }
  | {
      type: 'hook.finished';
      event: HookEvent;
      status: HookStatus;
      command: string;
      durationMs: number;
      turnId?: string;
      callId?: string;
      message?: string;
    }
  | { type: 'plan.updated'; turnId: string; steps: PlanStep[] }
  | { type: 'usage.updated'; turnId: string; usage: TokenUsage }
  | { type: 'context.updated'; turnId: string; usedTokens: number; windowTokens: number; steps: number }
  | {
      type: 'turn.finished';
      turnId: string;
      status: TurnFinishedStatus;
      usage: TokenUsage;
      durationMs: number;
      error?: TurnErrorInfo;
    };
