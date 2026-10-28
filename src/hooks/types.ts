import type { SessionHandle } from '../session/types.js';

/** Lifecycle events exposed to user-configured Agent Harness hooks. */
export type HookEvent =
  | 'session_start'
  | 'session_end'
  | 'user_prompt_submit'
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'stop';

export type HookStatus = 'ok' | 'blocked' | 'failed' | 'timeout' | 'aborted';

export interface HookConfig {
  event: HookEvent;
  command: string;
  /** Wall-clock limit for one hook process. */
  timeoutMs: number;
  /** Optional tool-name regular expression for pre/post tool hooks. */
  matcher?: string;
}

export interface HookPayloadContext {
  sessionId: string;
  cwd: string;
  turnId?: string;
  callId?: string;
  prompt?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: { content: string; isError: boolean };
  stopStatus?: 'done' | 'error' | 'aborted';
}

export interface HookOutcome {
  event: HookEvent;
  command: string;
  matcher?: string;
  status: HookStatus;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** True when the hook asked to block a blocking event (exit code 2). */
  blocked: boolean;
  reason?: string;
}

export interface HookRunResult {
  event: HookEvent;
  outcomes: HookOutcome[];
  /** True only for blocking events (user_prompt_submit / pre_tool_use). */
  blocked: boolean;
  reason?: string;
  /** Successful hook stdout, used by callers as optional context. */
  context: string;
}

export interface HookRunOptions {
  session: SessionHandle;
  turnId?: string;
  callId?: string;
  signal?: AbortSignal;
}

export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
export const MAX_HOOK_TIMEOUT_MS = 120_000;
export const MAX_HOOK_OUTPUT_CHARS = 8_000;
