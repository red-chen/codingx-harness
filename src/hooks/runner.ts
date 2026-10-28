import { ConfigError } from '../util/errors.js';
import { runShellCommand } from '../exec/index.js';
import { truncateMiddle } from '../util/tokens.js';
import type {
  HookConfig,
  HookEvent,
  HookOutcome,
  HookPayloadContext,
  HookRunOptions,
  HookRunResult,
  HookStatus,
} from './types.js';
import { MAX_HOOK_OUTPUT_CHARS } from './types.js';

const BLOCKING_EVENTS = new Set<HookEvent>(['user_prompt_submit', 'pre_tool_use']);
const TOOL_EVENTS = new Set<HookEvent>(['pre_tool_use', 'post_tool_use']);

interface HookEntry {
  config: HookConfig;
  matcher?: RegExp;
}

function clipReason(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0
    ? fallback
    : truncateMiddle(trimmed, 4_000, '\n[... hook reason truncated ...]\n');
}

export interface HookRunnerOptions {
  cwd: string;
  /** Environment already filtered by buildChildEnv(). */
  env: Record<string, string>;
  maxOutputChars?: number;
}

/**
 * Executes user-configured Agent Harness lifecycle hooks sequentially.
 * Hook failures never throw into the turn; exit code 2 blocks only blocking
 * events (user_prompt_submit / pre_tool_use). Every hook appends a
 * hook.finished audit event to the rollout.
 */
export class HookRunner {
  private readonly entries: HookEntry[];
  private readonly cwd: string;
  private readonly env: Record<string, string>;
  private readonly maxOutputChars: number;

  constructor(hooks: readonly HookConfig[], options: HookRunnerOptions) {
    this.cwd = options.cwd;
    this.env = options.env;
    this.maxOutputChars = Math.min(options.maxOutputChars ?? MAX_HOOK_OUTPUT_CHARS, MAX_HOOK_OUTPUT_CHARS);
    this.entries = hooks.map((config) => {
      let matcher: RegExp | undefined;
      if (config.matcher !== undefined) {
        if (!TOOL_EVENTS.has(config.event)) {
          throw new ConfigError(
            'Hook matcher is only supported for pre_tool_use / post_tool_use (event "' +
              config.event +
              '").',
          );
        }
        try {
          matcher = new RegExp(config.matcher);
        } catch (error) {
          throw new ConfigError(
            'Invalid hook matcher "' + config.matcher + '": ' +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }
      return { config, ...(matcher === undefined ? {} : { matcher }) };
    });
  }

  has(event: HookEvent): boolean {
    return this.entries.some((entry) => entry.config.event === event);
  }

  async run(event: HookEvent, context: HookPayloadContext, options: HookRunOptions): Promise<HookRunResult> {
    const selected = this.entries.filter(
      (entry) =>
        entry.config.event === event &&
        (entry.matcher === undefined ||
          (context.toolName !== undefined && entry.matcher.test(context.toolName))),
    );
    if (selected.length === 0) {
      return { event, outcomes: [], blocked: false, context: '' };
    }

    const payload = JSON.stringify({
      hook_event_name: event,
      session_id: context.sessionId,
      cwd: context.cwd,
      timestamp: new Date().toISOString(),
      ...(context.turnId === undefined ? {} : { turn_id: context.turnId }),
      ...(context.callId === undefined ? {} : { call_id: context.callId }),
      ...(context.prompt === undefined ? {} : { prompt: context.prompt }),
      ...(context.toolName === undefined ? {} : { tool_name: context.toolName }),
      ...(context.toolInput === undefined ? {} : { tool_input: context.toolInput }),
      ...(context.toolResult === undefined ? {} : { tool_result: context.toolResult }),
      ...(context.stopStatus === undefined ? {} : { stop_status: context.stopStatus }),
    });

    const outcomes: HookOutcome[] = [];
    for (const entry of selected) {
      const startedAt = Date.now();
      const hookEnv: Record<string, string> = {
        ...this.env,
        CODINGX_HOOK: '1',
        CODINGX_HOOK_EVENT: event,
        CODINGX_SESSION_ID: context.sessionId,
        CODINGX_CWD: context.cwd,
        ...(context.turnId === undefined ? {} : { CODINGX_TURN_ID: context.turnId }),
        ...(context.toolName === undefined ? {} : { CODINGX_TOOL_NAME: context.toolName }),
      };

      let status: HookStatus;
      let exitCode: number | null = null;
      let stdout = '';
      let stderr = '';
      let reason: string | undefined;
      try {
        const result = await runShellCommand({
          command: entry.config.command,
          cwd: this.cwd,
          timeoutMs: entry.config.timeoutMs,
          env: hookEnv,
          maxOutputChars: this.maxOutputChars,
          stdin: payload,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        exitCode = result.exitCode;
        stdout = result.stdout;
        stderr = result.stderr;
        if (result.aborted) {
          status = 'aborted';
          reason = 'Hook aborted with the turn.';
        } else if (result.timedOut) {
          status = 'timeout';
          reason = 'Hook timed out after ' + entry.config.timeoutMs + 'ms.';
        } else if (result.exitCode === 2) {
          status = 'blocked';
          reason = clipReason(stdout || stderr, 'Blocked by hook.');
        } else if (result.exitCode !== 0) {
          status = 'failed';
          reason = clipReason(
            stderr || stdout,
            'Hook exited with code ' + (result.exitCode ?? 'none') + '.',
          );
        } else {
          status = 'ok';
        }
      } catch (error) {
        status = 'failed';
        reason = 'Hook failed to run: ' + (error instanceof Error ? error.message : String(error));
      }

      const durationMs = Date.now() - startedAt;
      const outcome: HookOutcome = {
        event,
        command: entry.config.command,
        ...(entry.config.matcher === undefined ? {} : { matcher: entry.config.matcher }),
        status,
        exitCode,
        durationMs,
        stdout: truncateMiddle(stdout, this.maxOutputChars, '\n[... hook stdout truncated ...]\n'),
        stderr: truncateMiddle(stderr, this.maxOutputChars, '\n[... hook stderr truncated ...]\n'),
        blocked: status === 'blocked',
        ...(reason === undefined ? {} : { reason }),
      };
      outcomes.push(outcome);

      try {
        await options.session.append({
          type: 'hook.finished',
          event,
          command: entry.config.command,
          ...(entry.config.matcher === undefined ? {} : { matcher: entry.config.matcher }),
          status,
          exitCode,
          durationMs,
          blocked: outcome.blocked,
          ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
          ...(options.callId === undefined ? {} : { callId: options.callId }),
          ...(context.toolName === undefined ? {} : { toolName: context.toolName }),
          ...(outcome.stdout.length === 0 ? {} : { stdout: outcome.stdout }),
          ...(outcome.stderr.length === 0 ? {} : { stderr: outcome.stderr }),
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        });
      } catch {
        // Audit best-effort: a closing session must not turn a hook into an exception.
      }
    }

    const blockingOutcomes = BLOCKING_EVENTS.has(event)
      ? outcomes.filter((outcome) => outcome.status === 'blocked')
      : [];
    const hookContext = outcomes
      .filter((outcome) => outcome.status === 'ok')
      .map((outcome) => outcome.stdout.trim())
      .filter((text) => text.length > 0)
      .join('\n\n');

    return {
      event,
      outcomes,
      blocked: blockingOutcomes.length > 0,
      ...(blockingOutcomes.length === 0
        ? {}
        : {
            reason: blockingOutcomes
              .map((outcome) => outcome.reason ?? 'Blocked by hook.')
              .join('\n'),
          }),
      context: hookContext,
    };
  }
}
