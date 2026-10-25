import { generateTurnId } from '../util/ids.js';
import {
  abortError,
  ConfigError,
  describeError,
  isAbortError,
  ProviderError,
  StepLimitError,
} from '../util/errors.js';
import type { Message, ModelClient, ReasoningEffort, StopReason, TokenUsage, ToolCall, ToolSchema } from '../providers/types.js';
import { assistantMessage, toolResultsMessage } from '../providers/types.js';
import { estimateToolsTokens } from '../providers/tokens.js';
import { estimateTokens } from '../util/tokens.js';
import type { ApprovalHandler, PolicyRuntime } from '../policy/types.js';
import type { RouterSelection } from '../routing/router.js';
import type { ToolRegistry } from '../tools/registry.js';
import { ReadFileTracker } from '../tools/read-tracker.js';
import type {
  AskHandler,
  PlanController,
  PlanStep,
  ShellToolContext,
  SkillToolContext,
  ToolContext,
} from '../tools/types.js';
import type { SessionHandle } from '../session/types.js';
import { buildModelRequest, mergeConsecutiveUserMessages } from './context.js';
import { compactMessages, type CompressionOptions, type CompressionResult } from './compression.js';
import { summarizeDroppedMessages } from './summarize.js';
import type { TurnErrorInfo, UiEvent } from './events.js';
import { TurnState } from './turn.js';

export interface AgentModelClient extends ModelClient {
  readonly selection?: RouterSelection;
  /** Optional live model switch; ProviderRouter implements this. */
  setModel?(model: string): void;
}

export type AgentCompressionOptions = Omit<CompressionOptions, 'contextWindow'> & {
  /** max_tokens for the level-3 summary request; defaults to 1200. */
  summaryMaxTokens?: number;
  /** Disable model-generated summaries (useful for deterministic tests). Defaults to true. */
  summaryEnabled?: boolean;
};

export interface AgentLoopOptions {
  session: SessionHandle;
  router: AgentModelClient;
  tools: ToolRegistry;
  systemPrompt: string;
  model: string;
  maxSteps: number;
  maxOutputTokens: number;
  temperature?: number;
  /** Provider reasoning level; absent uses the provider default. */
  reasoningEffort?: ReasoningEffort;
  sessionId: string;
  cwd: string;
  maxOutputChars: number;
  shell: ShellToolContext;
  readTracker?: ReadFileTracker;
  /** Extra writable roots from --add-dir, in addition to cwd. */
  additionalDirs?: readonly string[];
  /** True when --yolo disabled every workspace path check. */
  yolo?: boolean;
  /** Permission policy for this invocation. */
  policy?: PolicyRuntime;
  /** Approval callback; absent when the UI cannot ask (exec/CI). */
  approve?: ApprovalHandler;
  /** UI callback for AskUserQuestion; absent in non-interactive runs. */
  ask?: AskHandler;
  /** Skills loaded for this session; absent when none are configured. */
  skills?: SkillToolContext;
  /** Replayed history for --resume / --fork. */
  initialMessages?: readonly Message[];
  /** Plan restored from a resumed rollout. */
  initialPlan?: readonly PlanStep[];
  /** Model context window used for compression; defaults to 200000. */
  contextWindow?: number;
  /** Overrides for deterministic compression thresholds and level-3 summary. */
  compression?: AgentCompressionOptions;
  emit?: (event: UiEvent) => void;
}

export interface RunTurnOptions {
  signal?: AbortSignal;
}

export interface TurnResult {
  turnId: string;
  status: 'done' | 'aborted' | 'error';
  usage: TokenUsage;
  steps: number;
  durationMs: number;
  error?: TurnErrorInfo;
}

/**
 * Runs turns against a provider, executing tools serially and writing the
 * rollout through the session handle. Current build has no approval/sandbox;
 * context compaction supports levels 1-2 (truncate/drop).
 */
export class AgentLoop {
  private readonly options: AgentLoopOptions;
  private readonly messages: Message[];
  private readonly toolSchemas: ToolSchema[];
  readonly readTracker: ReadFileTracker;
  private toolContextBase: Omit<ToolContext, 'signal' | 'plan'>;
  private planSteps: PlanStep[];
  private readonly contextWindow: number;
  private readonly compression: AgentCompressionOptions;
  private readonly summaryMaxTokens: number;
  private readonly summaryEnabled: boolean;
  private requestOverheadTokens: number;

  constructor(options: AgentLoopOptions) {
    if (options.maxSteps < 1) throw new Error('maxSteps must be at least 1.');
    this.options = options;
    this.readTracker = options.readTracker ?? new ReadFileTracker();
    this.messages = options.initialMessages ? [...options.initialMessages] : [];
    this.planSteps = options.initialPlan ? options.initialPlan.map((step) => ({ ...step })) : [];
    this.toolSchemas = options.tools.toJsonSchemas();
    this.contextWindow = options.contextWindow ?? 1_000_000;
    this.compression = options.compression ?? {};
    this.summaryMaxTokens = this.compression.summaryMaxTokens ?? 1_200;
    this.summaryEnabled = this.compression.summaryEnabled ?? true;
    this.requestOverheadTokens =
      estimateTokens(options.systemPrompt) + estimateToolsTokens(this.toolSchemas) + options.maxOutputTokens;
    this.toolContextBase = {
      cwd: options.cwd,
      readTracker: this.readTracker,
      maxOutputChars: options.maxOutputChars,
      shell: options.shell,
      ...(options.additionalDirs === undefined || options.additionalDirs.length === 0
        ? {}
        : { additionalDirs: options.additionalDirs }),
      ...(options.yolo === true ? { yolo: true } : {}),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.approve === undefined ? {} : { approve: options.approve }),
      ...(options.ask === undefined ? {} : { ask: options.ask }),
      ...(options.skills === undefined ? {} : { skills: options.skills }),
    };
  }

  get history(): readonly Message[] {
    return this.messages;
  }

  get plan(): readonly PlanStep[] {
    return this.planSteps;
  }

  /** Drop the in-memory conversation, plan and read-before-write state after a rollout clear. */
  clearHistory(): void {
    this.messages.length = 0;
    this.planSteps = [];
    this.readTracker.clear();
  }

  get model(): string {
    return this.options.model;
  }

  get reasoningEffort(): ReasoningEffort | undefined {
    return this.options.reasoningEffort;
  }

  /** Switch the model for subsequent requests; the router updates in tandem. */
  setModel(model: string): void {
    const next = model.trim();
    if (next.length === 0) throw new ConfigError('Model must not be empty.');
    this.options.router.setModel?.(next);
    this.options.model = next;
  }

  /** Change reasoning effort; undefined restores the provider default. */
  setReasoningEffort(effort: ReasoningEffort | undefined): void {
    this.options.reasoningEffort = effort;
  }

  /** Swap the active permission runtime after a /permissions change. */
  setPolicy(policy: PolicyRuntime): void {
    this.options.policy = policy;
    this.toolContextBase = { ...this.toolContextBase, policy };
  }

  /** Replace the system prompt after permission metadata changes. */
  setSystemPrompt(systemPrompt: string): void {
    this.options.systemPrompt = systemPrompt;
    this.requestOverheadTokens =
      estimateTokens(systemPrompt) + estimateToolsTokens(this.toolSchemas) + this.options.maxOutputTokens;
  }

  async runTurn(input: string, runOptions: RunTurnOptions = {}): Promise<TurnResult> {
    const signal = runOptions.signal;
    const turnId = generateTurnId();
    const state = new TurnState(turnId);
    const historyStart = this.messages.length;
    const planController: PlanController = {
      update: (steps) => {
        this.planSteps = steps.map((step) => ({ ...step }));
        this.emit({ type: 'plan.updated', turnId, steps: this.planSteps });
      },
      current: () => this.planSteps,
    };
    const toolContext: ToolContext = {
      ...this.toolContextBase,
      signal: signal ?? new AbortController().signal,
      plan: planController,
    };

    try {
      await this.options.session.append({ type: 'turn.start', turnId });
      await this.options.session.append({ type: 'user.message', text: input });
      this.messages.push({ role: 'user', content: [{ type: 'text', text: input }] });

      const selection = this.options.router.selection;
      if (selection) {
        await this.options.session.append({
          type: 'provider.selected',
          turnId,
          route: selection.routeName,
          provider: selection.providerId,
          model: selection.model,
          strategy: selection.strategy,
          affinity: selection.affinity,
        });
      }
      this.emit({ type: 'turn.started', turnId });

      if (signal?.aborted) throw abortError();

      let summaryAttempted = false;
      let turnSummary: string | undefined;
      let summaryError: string | undefined;

      for (let step = 1; step <= this.options.maxSteps; step += 1) {
        if (signal?.aborted) throw abortError();
        state.incrementStep();
        state.transition('streaming');
        await this.options.session.append({ type: 'turn.status', turnId, status: 'streaming' });

        const compaction = this.compactForRequest();
        this.emit({
          type: 'context.updated',
          turnId,
          usedTokens: Math.min(
            this.contextWindow,
            compaction.estimatedTokensAfter + this.requestOverheadTokens,
          ),
          windowTokens: this.contextWindow,
          steps: state.steps,
        });
        if (this.summaryEnabled && !summaryAttempted && compaction.dropped.length > 0) {
          summaryAttempted = true;
          const outcome = await summarizeDroppedMessages({
            router: this.options.router,
            messages: compaction.dropped,
            model: this.options.model,
            sessionId: this.options.sessionId,
            maxOutputTokens: this.summaryMaxTokens,
            ...(signal ? { signal } : {}),
          });
          state.addUsage(outcome.usage);
          if (outcome.summary) turnSummary = outcome.summary;
          if (outcome.error) summaryError = outcome.error.message;
        }

        if (compaction.applied.length > 0) {
          await this.options.session.append({
            type: 'context.compacted',
            turnId,
            levels: compaction.applied,
            droppedMessages: compaction.droppedMessages,
            truncatedToolResults: compaction.truncatedToolResults,
            estimatedTokensBefore: compaction.estimatedTokensBefore,
            estimatedTokensAfter: compaction.estimatedTokensAfter,
            ...(turnSummary ? { summary: turnSummary } : {}),
            ...(summaryError ? { summaryError } : {}),
          });
        }

        const requestSystem = turnSummary
          ? this.options.systemPrompt +
            '\n\n# Compacted context (summary of earlier conversation)\n' +
            turnSummary
          : this.options.systemPrompt;

        const request = buildModelRequest({
          model: this.options.model,
          system: requestSystem,
          messages: compaction.messages,
          tools: this.toolSchemas,
          maxOutputTokens: this.options.maxOutputTokens,
          ...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }),
          ...(this.options.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: this.options.reasoningEffort }),
          sessionId: this.options.sessionId,
        });

        let text = '';
        const calls: ToolCall[] = [];
        let stopReason: StopReason = 'end_turn';
        const llmStartedAt = Date.now();
        for await (const event of this.options.router.stream(request, signal)) {
          if (signal?.aborted) throw abortError();
          switch (event.type) {
            case 'text.delta':
              text += event.text;
              this.emit({ type: 'text.delta', turnId, text: event.text });
              break;
            case 'tool.call':
              calls.push({ id: event.id, name: event.name, input: event.input });
              break;
            case 'usage':
              state.addUsage(event);
              break;
            case 'stop':
              stopReason = event.reason;
              break;
          }
        }

        this.emit({ type: 'llm.finished', turnId, durationMs: Math.max(0, Date.now() - llmStartedAt) });

        if (stopReason === 'max_tokens') {
          throw new ProviderError(
            'Model output hit max_tokens before finishing. Increase model.max_output_tokens or shorten the request.',
            { category: 'context_overflow', retryable: false },
          );
        }
        if (stopReason === 'refusal') {
          throw new ProviderError('The model refused to continue this request.', {
            category: 'content_policy',
            retryable: false,
          });
        }
        if (text.length === 0 && calls.length === 0) {
          throw new ProviderError('The model returned an empty response.', {
            category: 'protocol',
            retryable: false,
          });
        }

        await this.options.session.append({
          type: 'assistant.message',
          turnId,
          text,
          calls,
          stopReason,
        });

        if (calls.length === 0) {
          this.messages.push({ role: 'assistant', content: [{ type: 'text', text }] });
          return await this.finishDone(state, turnId);
        }

        this.messages.push(assistantMessage(text, calls));
        state.transition('executing');
        await this.options.session.append({ type: 'turn.status', turnId, status: 'executing' });

        const results: Array<{ id: string; content: string; isError?: boolean }> = [];
        for (const call of calls) {
          if (signal?.aborted) throw abortError();
          this.emit({ type: 'tool.started', turnId, call });
          await this.options.session.append({
            type: 'tool.call',
            turnId,
            callId: call.id,
            name: call.name,
            input: call.input,
          });

          const startedAt = Date.now();
          const approve = this.options.approve;
          const callContext: ToolContext =
            approve === undefined
              ? toolContext
              : {
                  ...toolContext,
                  approve: async (request, approvalSignal) => {
                    await this.options.session.append({
                      type: 'turn.status',
                      turnId,
                      status: 'awaiting_approval',
                    });
                    try {
                      return await approve(
                        { ...request, turnId, callId: call.id },
                        approvalSignal ?? signal,
                      );
                    } finally {
                      await this.options.session.append({
                        type: 'turn.status',
                        turnId,
                        status: 'executing',
                      });
                    }
                  },
                };
          const result = await this.options.tools.execute(call.name, call.input, callContext);
          const durationMs = Date.now() - startedAt;

          await this.options.session.append({
            type: 'tool.result',
            turnId,
            callId: call.id,
            name: call.name,
            content: result.content,
            isError: result.isError ?? false,
            ...(result.meta ? { meta: result.meta } : {}),
            durationMs,
          });
          const policy = result.meta?.policy;
          if (typeof policy === 'object' && policy !== null && !Array.isArray(policy)) {
            await this.options.session.append({
              type: 'permission.decision',
              turnId,
              callId: call.id,
              name: call.name,
              ...(policy as Record<string, unknown>),
            });
          }
          this.emit({
            type: 'tool.finished',
            turnId,
            callId: call.id,
            name: call.name,
            result,
            durationMs,
          });
          if (call.name === 'UpdatePlan' && !result.isError && Array.isArray(result.meta?.plan)) {
            await this.options.session.append({
              type: 'plan.updated',
              turnId,
              steps: result.meta.plan,
            });
          }
          results.push({ id: call.id, content: result.content, isError: result.isError });
        }
        this.messages.push(toolResultsMessage(results));

        if (step >= this.options.maxSteps) throw new StepLimitError(this.options.maxSteps);
        state.transition('assembling');
      }
      throw new StepLimitError(this.options.maxSteps);
    } catch (error) {
      this.messages.length = historyStart;
      const aborted = signal?.aborted === true || isAbortError(error);
      const durationMs = state.durationMs;
      const usage = state.usage;
      const steps = state.steps;

      if (aborted) {
        if (!state.isTerminal) state.transition('aborted');
        const message = error instanceof Error ? error.message : 'Turn aborted';
        await this.options.session.append({
          type: 'turn.aborted',
          turnId,
          reason: message,
          usage,
          steps,
          durationMs,
        });
        this.emit({ type: 'usage.updated', turnId, usage });
        this.emit({ type: 'turn.finished', turnId, status: 'aborted', usage, durationMs });
        return { turnId, status: 'aborted', usage, steps, durationMs };
      }

      const summary = describeError(error);
      const errorInfo: TurnErrorInfo = {
        code: summary.code,
        message: summary.message,
        ...(summary.category ? { category: summary.category } : {}),
      };
      if (!state.isTerminal) state.transition('error');
      await this.options.session.append({
        type: 'turn.end',
        turnId,
        status: 'error',
        usage,
        steps,
        durationMs,
        error: errorInfo,
      });
      this.emit({ type: 'usage.updated', turnId, usage });
      this.emit({ type: 'turn.finished', turnId, status: 'error', usage, durationMs, error: errorInfo });
      return { turnId, status: 'error', usage, steps, durationMs, error: errorInfo };
    }
  }

  private compactForRequest(): CompressionResult {
    const normalized = mergeConsecutiveUserMessages(this.messages);
    const available = Math.max(1_000, this.contextWindow - this.requestOverheadTokens);
    const {
      summaryMaxTokens: _summaryMaxTokens,
      summaryEnabled: _summaryEnabled,
      ...compressionOptions
    } = this.compression;
    return compactMessages(normalized, { ...compressionOptions, contextWindow: available });
  }

  private async finishDone(state: TurnState, turnId: string): Promise<TurnResult> {
    const durationMs = state.durationMs;
    await this.options.session.append({
      type: 'turn.end',
      turnId,
      status: 'done',
      usage: state.usage,
      steps: state.steps,
      durationMs,
    });
    state.transition('done');
    this.emit({ type: 'usage.updated', turnId, usage: state.usage });
    this.emit({ type: 'turn.finished', turnId, status: 'done', usage: state.usage, durationMs });
    return { turnId, status: 'done', usage: state.usage, steps: state.steps, durationMs };
  }

  private emit(event: UiEvent): void {
    try {
      this.options.emit?.(event);
    } catch {
      // A UI renderer bug must not fail the turn.
    }
  }
}
