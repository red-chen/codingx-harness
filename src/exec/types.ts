import type { ExecutionSandbox } from '../sandbox/diagnostics.js';

export interface ExecInvocation {
  file: string;
  args: string[];
}

export interface ExecRequest {
  command: string;
  /** Optional fully resolved argv (for example a sandbox wrapper). */
  invocation?: ExecInvocation;
  /** Optional stdin payload, written before the child is awaited. */
  stdin?: string;
  cwd: string;
  /** Wall-clock limit in milliseconds. */
  timeoutMs: number;
  /** Fully resolved environment, normally from buildChildEnv(). */
  env: Record<string, string>;
  /** Per-stream capture limit before head/tail truncation. */
  maxOutputChars: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutChars: number;
  stderrChars: number;
}

export type ProcessState = 'starting' | 'running' | 'stopping' | 'exited' | 'failed';
export type ProcessStopReason = 'requested' | 'session_closed' | 'session_cleared' | 'aborted';

/** Serializable state only: never includes environment or ChildProcess handles. */
export interface ManagedProcess {
  processId: string;
  command: string;
  cwd: string;
  state: ProcessState;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stopReason?: ProcessStopReason;
  error?: string;
  /** Launch-time sandbox; later profile switches cannot change a running process. */
  sandbox?: ExecutionSandbox;
}

export interface ProcessStartRequest {
  command: string;
  cwd: string;
  invocation?: ExecInvocation;
  /** Environment already filtered by buildChildEnv. */
  env: Record<string, string>;
  /** Only controls startup; detached once start returns successfully. */
  signal?: AbortSignal;
  sandbox?: ExecutionSandbox;
}

export interface ProcessOutput {
  process: ManagedProcess;
  /** Combined stdout/stderr in arrival order. */
  output: string;
  /** Absolute UTF-16 character offset for the next read. */
  nextCursor: number;
  truncated: boolean;
}

export interface ProcessManagerOptions {
  maxProcesses?: number;
  maxRecords?: number;
  maxOutputChars?: number;
  killGraceMs?: number;
  onState?: (process: ManagedProcess) => Promise<void>;
}
