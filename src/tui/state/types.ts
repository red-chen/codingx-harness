import type { ReasoningEffort, TokenUsage } from '../../providers/types.js';
import type { PlanStep } from '../../tools/types.js';
import type { Color } from '../terminal/buffer.js';
import { ansiColor, color256, rgbColor } from '../terminal/buffer.js';

/**
 * Pure TUI state model shared by the app reducer and the widgets.
 *
 * Nothing in this module (or any of its consumers) touches process streams,
 * timers, the session store or the agent loop. The core drives the TUI through
 * UiEvent; the TUI answers with UiCommand.
 */

export type TuiMode = 'main' | 'transcript' | 'help' | 'ask' | 'approval';

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
  readonly exploration?: string;
  readonly expanded?: boolean;
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

/**
 * A user-typed '!command'. It is rendered like a user line plus its output,
 * never as a model tool call, and it keeps the complete bounded output.
 */
export interface LocalCommandCell {
  readonly type: 'local';
  readonly id: string;
  readonly command: string;
  readonly output: string;
  readonly isError: boolean;
  readonly durationMs?: number;
  /** True between local.command and local.result. */
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

export type TranscriptCell =
  | UserCell
  | AssistantCell
  | TurnSummaryCell
  | ExecCell
  | LocalCommandCell
  | PlanCell
  | NoticeCell;

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
  readonly search?: { readonly query: string; readonly index: number; readonly original: ComposerState };
}

/** Rows scrolled up from the live bottom. 0 keeps the viewport anchored. */
export interface TranscriptScrollState {
  readonly offset: number;
}

/** One selectable answer in the ask overlay. */
export interface TuiAskOption {
  readonly label: string;
  readonly description?: string;
}

export interface TuiAskQuestion {
  readonly id: string;
  readonly header?: string;
  readonly question: string;
  readonly options: readonly TuiAskOption[];
  readonly multiSelect: boolean;
}

/**
 * Modal ask state. One question is visible at a time; selections and custom
 * text are retained per question so going back does not lose answers.
 */
export interface TuiAskState {
  /** Execution state to restore when a local picker or tool question closes. */
  readonly resumeState?: Exclude<TuiStatusState, 'awaiting'>;
  readonly questions: readonly TuiAskQuestion[];
  readonly index: number;
  readonly selections: readonly (readonly string[])[];
  /** Highlighted row for the current question (options followed by "Other"). */
  readonly optionIndex: number;
  readonly custom: readonly string[];
  readonly editing: boolean;
  readonly cursor: number;
}

export interface TuiSessionState {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  /** Provider reasoning effort; absent means the provider default. */
  readonly reasoningEffort?: ReasoningEffort;
  /** User home directory used to abbreviate cwd with '~'. */
  readonly home?: string;
  /** Short derived title; defaults to the first user prompt. */
  readonly title?: string;
  /** Active permission profile; reported by /permissions, not shown in the meta row. */
  readonly permissionProfile?: string;
  /** Active approval policy; reported by /permissions, not shown in the meta row. */
  readonly approvalPolicy?: string;
}

export type TuiApprovalChoice = 'once' | 'session' | 'prefix' | 'deny' | 'deny-reason';

/** The subset of a policy action the approval panel needs for display. */
export interface TuiApprovalAction {
  readonly kind: string;
  readonly tool: string;
  readonly path?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly network?: boolean;
}

export interface TuiApprovalRequest {
  readonly requestId: string;
  readonly tool: string;
  readonly action: TuiApprovalAction;
  readonly reason?: string;
  readonly risk: 'low' | 'medium' | 'high';
  /** True when this action can be approved as a reusable exec prefix. */
  readonly allowPrefix: boolean;
}

/** Modal approval state. Choices are fixed by the app; model output cannot add or reorder them. */
export interface TuiApprovalState {
  readonly resumeState?: Exclude<TuiStatusState, 'awaiting'>;
  readonly details?: boolean;
  readonly detailsOffset?: number;
  readonly request: TuiApprovalRequest;
  readonly choiceIndex: number;
  readonly editingReason: boolean;
  readonly reason: string;
  readonly cursor: number;
}

export interface TuiAppState {
  readonly mode: TuiMode;
  readonly session: TuiSessionState;
  readonly version: string;
  readonly width: number;
  readonly height: number;
  /** Immutable scrollback. Append by replacing the array, never by mutating cells. */
  readonly transcript: readonly TranscriptCell[];
  /** Changes on /clear even when the session ID is retained. */
  readonly transcriptGeneration: number;
  readonly activeAssistant: ActiveAssistantCell | null;
  readonly plan: readonly PlanStep[];
  /** Present while the ask overlay is open (mode === 'ask'). */
  readonly ask?: TuiAskState;
  /** Present while the approval overlay is open (mode === 'approval'). */
  readonly approval?: TuiApprovalState;
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
/** Reduce HSL saturation by 10%, preserving hue and lightness. */
function softColor(r: number, g: number, b: number): Color {
  const lightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
  return rgbColor(
    Math.round(lightness + (r - lightness) * 0.9),
    Math.round(lightness + (g - lightness) * 0.9),
    Math.round(lightness + (b - lightness) * 0.9),
  );
}

/** Shared reference accents, with the same saturation adjustment everywhere. */
export const TRANSCRIPT_COLORS = Object.freeze({
  emphasis: softColor(239, 113, 154),
  code: softColor(139, 217, 137),
  bullet: softColor(126, 224, 210),
  command: softColor(97, 175, 239),
  success: softColor(82, 223, 145),
});

export const TUI_COLORS: TuiColors = Object.freeze({
  accent: TRANSCRIPT_COLORS.bullet,
  muted: ansiColor(8),
  success: TRANSCRIPT_COLORS.success,
  warning: softColor(229, 192, 123),
  error: softColor(224, 108, 117),
  userBg: color256(237),
  composerBg: color256(235),
  planBg: color256(234),
  diffAdd: TRANSCRIPT_COLORS.success,
  diffDel: softColor(224, 108, 117),
  border: ansiColor(8),
});
