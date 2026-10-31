import type { RequestUsage } from '../providers/usage.js';
import type { TokenUsage } from '../providers/types.js';

export interface StatusBarSegment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface StatusBarInput {
  version: 1;
  sessionId: string;
  generation: number;
  cwd: string;
  width: number;
  current: { provider: string; model: string; origin?: string; reasoningEffort?: string };
  status: { state: string; elapsedMs: number; turnNumber: number; step: number };
  context: { usedTokens: number; windowTokens: number };
  totalUsage: TokenUsage;
  usageRecords: readonly RequestUsage[];
  /** Older rollouts can have aggregate usage with no per-request attribution. */
  usageIncomplete: boolean;
}

export interface StatusBarView { version: 1; segments: StatusBarSegment[] }

export interface TurnSummaryInput {
  version: 1;
  sessionId: string;
  generation: number;
  cwd: string;
  turn: {
    id: string;
    outcome: 'done' | 'aborted' | 'error';
    completedAt: number;
    durationMs: number;
    usage: TokenUsage;
  };
  usageRecords: readonly RequestUsage[];
  usageIncomplete: boolean;
}

export interface TurnSummaryView extends StatusBarView {
  details?: { segments: StatusBarSegment[] }[];
}

export interface PluginExecution {
  type: 'command'; command: string; args: string[];
}

export interface PluginManifest {
  manifest_version: 1;
  id: string;
  name: string;
  version: string;
  capabilities: {
    status_bar: {
      protocol: 'codingx.status-bar/v1';
      mode: 'decorate';
      placement: { after: 'total_tokens' };
      execution: PluginExecution;
    };
    turn_summary?: {
      protocol: 'codingx.turn-summary/v1';
      mode: 'decorate';
      placement: { after: 'output_rate' };
      execution: PluginExecution;
    };
  };
}
