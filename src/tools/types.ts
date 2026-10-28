import type { z } from 'zod';
import type { ApprovalHandler, PolicyRuntime } from '../policy/types.js';
import type { SandboxBackend } from '../sandbox/types.js';
import type { ReadFileTracker } from './read-tracker.js';

export interface ShellToolContext {
  /** Environment already filtered by buildChildEnv(). */
  env: Record<string, string>;
  /** Default command timeout in milliseconds. */
  timeoutMs: number;
}

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

/** Session-scoped plan state exposed to the UpdatePlan tool and the UI. */
export interface PlanController {
  update(steps: PlanStep[]): void;
  current(): readonly PlanStep[];
}

export interface AskOption {
  readonly label: string;
  readonly description?: string;
}

/** One model-authored question. multiSelect mirrors the tool's multi_select. */
export interface AskQuestion {
  readonly id: string;
  readonly header?: string;
  readonly question: string;
  readonly options?: readonly AskOption[];
  readonly multiSelect: boolean;
}

export interface AskAnswer {
  readonly id: string;
  readonly selected: readonly string[];
  readonly custom?: string;
}

/**
 * UI-provided answer callback. Resolves null when the user dismisses the
 * question without answering; rejects only when the turn is aborted.
 */
export type AskHandler = (
  questions: readonly AskQuestion[],
  signal?: AbortSignal,
) => Promise<readonly AskAnswer[] | null>;

/** The subset of a loaded skill the Skill tool needs. */
export interface SkillToolEntry {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly filePath: string;
  readonly directory: string;
}

export interface SkillToolContext {
  get(name: string): SkillToolEntry | undefined;
  list(): readonly SkillToolEntry[];
}

export interface ToolContext {
  /** Primary workspace root; relative file paths resolve against this directory. */
  cwd: string;
  /** Extra writable roots from --add-dir (canonical absolute paths). */
  additionalDirs?: readonly string[];
  /** True when --yolo disabled every workspace path check. */
  yolo?: boolean;
  /** Permission policy for this invocation; absent in direct tool unit tests. */
  policy?: PolicyRuntime;
  /** OS sandbox backend; absent in direct tool unit tests and full-access runs. */
  sandbox?: SandboxBackend;
  /** Present only when the caller can collect approval decisions (S2 TUI). */
  approve?: ApprovalHandler;
  signal: AbortSignal;
  readTracker: ReadFileTracker;
  maxOutputChars: number;
  shell: ShellToolContext;
  /** Present when the agent loop provides session plan state. */
  plan?: PlanController;
  /** Present only when the UI can collect answers during a turn. */
  ask?: AskHandler;
  /** Present when skills were loaded for this session. */
  skills?: SkillToolContext;
}

export type ToolApproval = 'none' | 'on-write' | 'always';

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Structured metadata for UI/audit; not sent back to the model. */
  meta?: Record<string, unknown>;
}

export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Model-visible name; PascalCase (for example ReadFile). */
  name: string;
  description: string;
  schema: S;
  /** Read-only tools may run concurrently with other read-only tools. */
  parallelSafe: boolean;
  approval: ToolApproval;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}
