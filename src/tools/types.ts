import type { z } from 'zod';
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

/** Session-scoped plan state exposed to the update_plan tool and the UI. */
export interface PlanController {
  update(steps: PlanStep[]): void;
  current(): readonly PlanStep[];
}

export interface ToolContext {
  /** Workspace root; file paths are confined to this directory in M1. */
  cwd: string;
  signal: AbortSignal;
  readTracker: ReadFileTracker;
  maxOutputChars: number;
  shell: ShellToolContext;
  /** Present when the agent loop provides session plan state. */
  plan?: PlanController;
}

export type ToolApproval = 'none' | 'on-write' | 'always';

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Structured metadata for UI/audit; not sent back to the model. */
  meta?: Record<string, unknown>;
}

export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Model-visible name; snake_case. */
  name: string;
  description: string;
  schema: S;
  /** Read-only tools may run concurrently with other read-only tools. */
  parallelSafe: boolean;
  approval: ToolApproval;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}