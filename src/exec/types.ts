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
