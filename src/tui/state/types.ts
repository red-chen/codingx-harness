import type { TokenUsage } from '../../providers/types.js';
import type { PlanStep } from '../../tools/types.js';
import type { Color } from '../terminal/buffer.js';
import { ansiColor, color256 } from '../terminal/buffer.js';

/**
 * Pure TUI state model shared by the app reducer and the widgets.
 *
 * Nothing in this module (or any of its consumers) touches process streams,
 * timers, the session store or the agent loop. The core drives the TUI through
 * UiEvent; the TUI answers with UiCommand.
 */

export type TuiMode = 'main' | 'transcript' | 'help';

export type TuiStatusState = 'idle' | 'working' | 'awaiting';
export type TuiTurnOutcome = 'done' | 'error' | 'aborted';

export interface TuiErrorInfo {
  readonly code?: string;
  readonly message: string;
}

export interface TuiStatus {
  readonly state: TuiStatusState;
  readonly turnId?: string;
  /** Clock value captured when the turn started (injected now()). */
  readonly startedAt?: number;
  /** Last authoritative duration, supplied by turn.finished. */
  readonly elapsedMs: number;
  readonly outcome?: TuiTurnOutcome;
  readonly error?: TuiErrorInfo;
}

/** One completed unit in the scrollback. Completed cells are never mutated. */
export interface UserCell {
  readonly type: 'user';
  readonly id: string;
  readonly text: string;
}

export interface AssistantCell {
  readonly type: 'assistant';
  readonly id: string;
  readonly turnId?: string;
  readonly text: string;
  readonly durationMs?: number;
}

export interface ExecCell {
  readonly type: 'exec';
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  /** Human label after 'Ran ' (the shell command when the tool carries one). */
  readonly command: string;
  readonly output: string;
  readonly isError: boolean;
  readonly durationMs?: number;
  /** True between tool.started and tool.finished. */
  readonly running: boolean;
}

export interface TurnSummaryCell {
  readonly type: 'turn';
  readonly id: string;
  readonly outcome: TuiTurnOutcome;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly llmDurationMs: number;
  readonly toolDurationMs: number;
  readonly usage: TokenUsage;
}

export interface PlanCell {
  readonly type: 'plan';
  readonly id: string;
  readonly steps: readonly PlanStep[];
}

export type NoticeLevel = 'info' | 'warning' | 'error';

export interface NoticeCell {
  readonly type: 'notice';
  readonly id: string;
  readonly level: NoticeLevel;
  readonly text: string;
}

export type TranscriptCell = UserCell | AssistantCell | TurnSummaryCell | ExecCell | PlanCell | NoticeCell;

/** The mutable tail while a turn streams. Never stored in transcript until done. */
export interface ActiveAssistantCell {
  readonly id: string;
  readonly turnId: string;
  readonly text: string;
  readonly durationMs?: number;
}

export interface QueueItem {
  readonly id: string;
  readonly text: string;
  /** True when the user cell was already appended before queueing (Enter while busy). */
  readonly submitted?: boolean;
}

/**
 * Composer editing state. cursor is a UTF-16 index but is always moved on
 * grapheme boundaries by the editing helpers in widgets/composer.ts.
 */
export interface ComposerState {
  readonly text: string;
  readonly cursor: number;
  readonly history: readonly string[];
  /** -1 means "editing the draft", otherwise an index into history. */
  readonly historyIndex: number;
  readonly draft: string;
}

/** Rows scrolled up from the live bottom. 0 keeps the viewport anchored. */
export interface TranscriptScrollState {
  readonly offset: number;
}

export interface TuiSessionState {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  /** User home directory used to abbreviate cwd with '~'. */
  readonly home?: string;
  /** Short derived title; defaults to the first user prompt. */
  readonly title?: string;
}

export interface TuiAppState {
  readonly mode: TuiMode;
  readonly session: TuiSessionState;
  readonly version: string;
  readonly width: number;
  readonly height: number;
  /** Immutable scrollback. Append by replacing the array, never by mutating cells. */
  readonly transcript: readonly TranscriptCell[];
  readonly activeAssistant: ActiveAssistantCell | null;
  readonly plan: readonly PlanStep[];
  readonly status: TuiStatus;
  readonly usage: TokenUsage;
  readonly queue: readonly QueueItem[];
  readonly composer: ComposerState;
  readonly scroll: TranscriptScrollState;
  readonly slashIndex: number;
  readonly slashDismissed: boolean;
  /** Number of turns started in this session (includes the current turn). */
  readonly turnNumber: number;
  /** Model/tool steps executed in the current or most recent turn. */
  readonly currentTurnSteps: number;
  /** Cumulative token usage across all turns in this session. */
  readonly totalUsage: TokenUsage;
  readonly turnLlmDurationMs: number;
  readonly turnToolDurationMs: number;
  /** Context tokens used in the most recent request. */
  readonly contextUsedTokens: number;
  /** Context window in tokens; defaults to 1M in the TUI. */
  readonly contextWindowTokens: number;
  /** Legacy percentage input; status prefers the token pair. */
  readonly contextPercent?: number;
}

export interface TuiColors {
  readonly accent: Color;
  readonly muted: Color;
  readonly success: Color;
  readonly warning: Color;
  readonly error: Color;
  readonly userBg: Color;
  readonly composerBg: Color;
  readonly planBg: Color;
  readonly diffAdd: Color;
  readonly diffDel: Color;
  readonly border: Color;
}

/**
 * Semantic palette layered on the kernel Color constructors. The terminal
 * renderer owns capability downgrade and NO_COLOR, so widgets only ever refer
 * to these names.
 */
export const TUI_COLORS: TuiColors = Object.freeze({
  accent: ansiColor(6),
  muted: ansiColor(8),
  success: ansiColor(2),
  warning: ansiColor(3),
  error: ansiColor(1),
  userBg: color256(237),
  composerBg: color256(235),
  planBg: color256(234),
  diffAdd: ansiColor(2),
  diffDel: ansiColor(1),
  border: ansiColor(8),
});