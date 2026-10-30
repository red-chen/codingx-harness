import { createHash } from 'node:crypto';
import { ProcessManager } from '../exec/process-manager.js';
import { generateTurnId } from '../util/ids.js';
import {
  abortError,
  CodingxError,
  ConfigError,
  describeError,
  isAbortError,
  ProviderError,
  StepLimitError,
} from '../util/errors.js';
import type { Message, ModelClient, ReasoningEffort, StopReason, TokenUsage, ToolCall, ToolSchema } from '../providers/types.js';
import { assistantMessage, DEFAULT_CONTEXT_WINDOW, toolResultsMessage } from '../providers/types.js';
import { estimateMessagesTokens, estimateToolsTokens } from '../providers/tokens.js';
import { estimateTokens, truncateMiddle } from '../util/tokens.js';
import type { ApprovalHandler, PolicyRuntime } from '../policy/types.js';
import type { RouterSelection } from '../routing/router.js';
import type { SandboxBackend } from '../sandbox/types.js';
import type { HookRunner } from '../hooks/index.js';
import type { HookEvent, HookPayloadContext, HookRunOptions, HookRunResult } from '../hooks/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { ReadFileTracker } from '../tools/read-tracker.js';
import type {
  AskHandler,
  PlanController,
  PlanStep,
  ShellToolContext,
  SkillToolContext,
  ToolContext,
  ToolResult,
} from '../tools/types.js';
import type { SessionHandle } from '../session/types.js';
import { buildModelRequest, mergeConsecutiveUserMessages } from './context.js';
import { compactMessages, type CompressionOptions, type CompressionResult } from './compression.js';
import { serializeMessagesForSummary, summarizeDroppedMessages } from './summarize.js';
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
  /** OS sandbox backend for Shell commands; absent in unit tests and full access. */
  sandbox?: SandboxBackend;
  /** User-configured Agent Harness lifecycle hooks. */
  hooks?: HookRunner;
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

const MAX_COMPACTION_SUMMARY_CHARS = 24_000;
const MAX_RAW_FRESH_DROP_TOKENS = 500;
const RAW_FRESH_DROP_CHARS = 2_000;

function messageFingerprint(message: Message): string {
  return createHash('sha256').update(JSON.stringify(message)).digest('hex');
}

export interface RunTurnOptions {
  signal?: AbortSignal;
  /** Atomically take all queued user messages at a model-step boundary. */
  takeQueuedPrompts?: () => readonly string[];
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
 * rollout through the session handle. Tool calls pass through the permission
 * policy (and, for Shell, the OS sandbox) before execution.
 */
export class AgentLoop {
  readonly processes: ProcessManager;
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
  /** Summaries of messages already dropped from requests, newest appended. */
  private compactionSummary: string | undefined;
  private readonly summarizedHashes = new Set<string>();
  private readonly summaryFailedHashes = new Set<string>();

  constructor(options: AgentLoopOptions) {
    if (options.maxSteps < 1) throw new Error('maxSteps must be at least 1.');
    this.options = options;
    this.processes = new ProcessManager({
      onState: async (process) => { await options.session.append({ type: 'process.state', process }); },
    });
    this.readTracker = options.readTracker ?? new ReadFileTracker();
    this.messages = options.initialMessages ? [...options.initialMessages] : [];
    this.planSteps = options.initialPlan ? options.initialPlan.map((step) => ({ ...step })) : [];
    this.toolSchemas = options.tools.toJsonSchemas();
    this.contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
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
      processes: this.processes,
      ...(options.additionalDirs === undefined || options.additionalDirs.length === 0
        ? {}
        : { additionalDirs: options.additionalDirs }),
      ...(options.yolo === true ? { yolo: true } : {}),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
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
    this.compactionSummary = undefined;
    this.summarizedHashes.clear();
    this.summaryFailedHashes.clear();
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

  /** Replace the explicitly selected provider between turns. */
  setRouter(router: AgentModelClient, model: string): void {
    this.options.router = router;
    this.options.model = model;
  }

  /** Swap the active permission runtime after a /permissions change. */
  setPolicy(policy: PolicyRuntime): void {
    this.options.policy = policy;
    this.toolContextBase = { ...this.toolContextBase, policy, yolo: policy.yolo };
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

    const appendPrompt = async (input: string, merge = false): Promise<void> => {
      const promptHooks = await this.runHooks(
        'user_prompt_submit',
        { sessionId: this.options.sessionId, cwd: this.options.cwd, prompt: input },
        { turnId, ...(signal === undefined ? {} : { signal }) },
      );
      await this.options.session.append({ type: 'user.message', text: input });
      if (promptHooks?.blocked === true) {
        throw new CodingxError(
          'HOOK_BLOCKED',
          promptHooks.reason ?? 'The user_prompt_submit hook blocked this prompt.',
        );
      }
      const promptContext = promptHooks?.context.trim() ?? '';
      const modelInput =
        promptContext.length === 0
          ? input
          : input + '\n\n[Hook context: user_prompt_submit]\n' + promptContext;
      const last = this.messages.at(-1);
      if (merge && last?.role === 'user') last.content.push({ type: 'text', text: modelInput });
      else this.messages.push({ role: 'user', content: [{ type: 'text', text: modelInput }] });
    };
    const consumeQueuedPrompts = async (): Promise<boolean> => {
      const prompts = runOptions.takeQueuedPrompts?.() ?? [];
      for (const prompt of prompts) await appendPrompt(prompt, true);
      return prompts.length > 0;
    };

    try {
      await this.options.session.append({ type: 'turn.start', turnId });
      await appendPrompt(input);

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

      this.summaryFailedHashes.clear();

      for (let step = 1; step <= this.options.maxSteps; step += 1) {
        if (signal?.aborted) throw abortError();
        await consumeQueuedPrompts();
        state.incrementStep();
        state.transition('streaming');
        await this.options.session.append({ type: 'turn.status', turnId, status: 'streaming' });

        let text = '';
        let calls: ToolCall[] = [];
        let stopReason: StopReason = 'end_turn';
        let forcedCompaction = false;
        let overflowRecoveryAttempted = false;

        for (;;) {
          const compaction = this.compactForRequest(forcedCompaction);
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

          let addedSummary: string | undefined;
          let summaryError: string | undefined;
          if (this.summaryEnabled && compaction.dropped.length > 0) {
            const fresh = compaction.dropped.filter((message) => {
              const fingerprint = messageFingerprint(message);
              return !this.summarizedHashes.has(fingerprint) && !this.summaryFailedHashes.has(fingerprint);
            });
            if (fresh.length > 0) {
              if (
                this.compactionSummary !== undefined &&
                estimateMessagesTokens(fresh) <= MAX_RAW_FRESH_DROP_TOKENS
              ) {
                // Once a real summary exists, tiny incremental drops are
                // cheaper to carry verbatim than to send through the model.
                const excerpt = serializeMessagesForSummary(fresh, RAW_FRESH_DROP_CHARS);
                this.compactionSummary = truncateMiddle(
                  this.compactionSummary +
                    '\n\n## Additional omitted messages\n' +
                    excerpt,
                  MAX_COMPACTION_SUMMARY_CHARS,
                  '\n[... older compacted context truncated ...]\n',
                );
                addedSummary = excerpt;
                for (const message of fresh) this.summarizedHashes.add(messageFingerprint(message));
              } else {
                const outcome = await summarizeDroppedMessages({
                  router: this.options.router,
                  messages: fresh,
                  model: this.options.model,
                  sessionId: this.options.sessionId,
                  maxOutputTokens: this.summaryMaxTokens,
                  ...(signal ? { signal } : {}),
                });
                state.addUsage(outcome.usage);
                if (outcome.summary) {
                  this.compactionSummary = truncateMiddle(
                    this.compactionSummary
                      ? this.compactionSummary + '\n\n' + outcome.summary
                      : outcome.summary,
                    MAX_COMPACTION_SUMMARY_CHARS,
                    '\n[... older compacted context truncated ...]\n',
                  );
                  addedSummary = outcome.summary;
                  for (const message of fresh) this.summarizedHashes.add(messageFingerprint(message));
                }
                if (outcome.error) {
                  summaryError = outcome.error.message;
                  for (const message of fresh) this.summaryFailedHashes.add(messageFingerprint(message));
                }
              }
            }
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
              ...(addedSummary ? { summary: addedSummary } : {}),
              ...(summaryError ? { summaryError } : {}),
            });
          }

          const requestSystem = this.compactionSummary
            ? this.options.systemPrompt +
              '\n\n# Compacted context (summary of earlier conversation)\n' +
              this.compactionSummary
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

          text = '';
          calls = [];
          stopReason = 'end_turn';
          const llmStartedAt = Date.now();
          try {
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
          } catch (error) {
            const canRecover =
              !overflowRecoveryAttempted &&
              signal?.aborted !== true &&
              text.length === 0 &&
              calls.length === 0 &&
              error instanceof ProviderError &&
              error.category === 'context_overflow';
            if (!canRecover) throw error;
            // The estimate can be below the provider's real window. Force a
            // deterministic compaction and retry once before failing the turn.
            overflowRecoveryAttempted = true;
            forcedCompaction = true;
            continue;
          }

          this.emit({ type: 'llm.finished', turnId, durationMs: Math.max(0, Date.now() - llmStartedAt) });
          break;
        }

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
          if (step < this.options.maxSteps && await consumeQueuedPrompts()) {
            state.transition('assembling');
            continue;
          }
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
          const preHooks = await this.runHooks(
            'pre_tool_use',
            {
              sessionId: this.options.sessionId,
              cwd: this.options.cwd,
              toolName: call.name,
              toolInput: call.input,
            },
            { turnId, callId: call.id, ...(signal === undefined ? {} : { signal }) },
          );
          let result: ToolResult;
          if (preHooks?.blocked === true) {
            result = {
              content:
                'Blocked by pre_tool_use hook: ' +
                (preHooks.reason ?? 'the hook rejected this tool call.'),
              isError: true,
              meta: {
                code: 'HOOK_BLOCKED',
                hook: { event: 'pre_tool_use', command: preHooks.outcomes.at(-1)?.command },
              },
            };
          } else {
            result = await this.options.tools.execute(call.name, call.input, callContext);
            const postHooks = await this.runHooks(
              'post_tool_use',
              {
                sessionId: this.options.sessionId,
                cwd: this.options.cwd,
                toolName: call.name,
                toolInput: call.input,
                toolResult: { content: result.content, isError: result.isError === true },
              },
              { turnId, callId: call.id, ...(signal === undefined ? {} : { signal }) },
            );
            if (postHooks?.context.trim()) {
              result = {
                ...result,
                content: truncateMiddle(
                  result.content +
                    '\n\n[Hook context: post_tool_use]\n' +
                    postHooks.context.trim(),
                  this.options.maxOutputChars,
                  '\n[... hook context truncated ...]\n',
                ),
              };
            }
          }
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
          const sandbox = result.meta?.sandbox;
          if (typeof sandbox === 'object' && sandbox !== null && !Array.isArray(sandbox)) {
            const sandboxRecord = sandbox as Record<string, unknown>;
            if (sandboxRecord.denied === true) {
              await this.options.session.append({
                type: 'sandbox.denied',
                turnId,
                callId: call.id,
                kind: typeof sandboxRecord.kind === 'string' ? sandboxRecord.kind : 'sandbox',
                reason:
                  typeof sandboxRecord.reason === 'string'
                    ? sandboxRecord.reason
                    : 'The OS sandbox denied the operation.',
                retryable: true,
              });
            }
          }
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
        await this.runStopHooks('aborted', turnId);
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
      await this.runStopHooks('error', turnId);
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

  private compactForRequest(force = false): CompressionResult {
    const normalized = mergeConsecutiveUserMessages(this.messages);
    const available = Math.max(1_000, this.contextWindow - this.requestOverheadTokens);
    const {
      summaryMaxTokens: _summaryMaxTokens,
      summaryEnabled: _summaryEnabled,
      ...compressionOptions
    } = this.compression;
    return compactMessages(normalized, {
      ...compressionOptions,
      contextWindow: available,
      ...(force
        ? {
            thresholdRatio: 0,
            keepRecentMessages: Math.min(compressionOptions.keepRecentMessages ?? 4, 4),
            toolResultMaxChars: Math.min(compressionOptions.toolResultMaxChars ?? 2_000, 2_000),
          }
        : {}),
    });
  }

  private async finishDone(state: TurnState, turnId: string): Promise<TurnResult> {
    const durationMs = state.durationMs;
    await this.runStopHooks('done', turnId);
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

  private async runHooks(
    event: HookEvent,
    context: HookPayloadContext,
    options: Pick<HookRunOptions, 'turnId' | 'callId' | 'signal'>,
  ): Promise<HookRunResult | undefined> {
    const hooks = this.options.hooks;
    if (hooks === undefined || !hooks.has(event)) return undefined;
    try {
      const result = await hooks.run(event, context, {
        session: this.options.session,
        ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
        ...(options.callId === undefined ? {} : { callId: options.callId }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      for (const outcome of result.outcomes) {
        if (outcome.status === 'ok') continue;
        this.emit({
          type: 'hook.finished',
          event: result.event,
          status: outcome.status,
          command: outcome.command,
          durationMs: outcome.durationMs,
          ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
          ...(options.callId === undefined ? {} : { callId: options.callId }),
          ...(outcome.reason === undefined ? {} : { message: outcome.reason }),
        });
      }
      return result;
    } catch {
      return undefined;
    }
  }

  private async runStopHooks(status: 'done' | 'error' | 'aborted', turnId: string): Promise<void> {
    await this.runHooks(
      'stop',
      {
        sessionId: this.options.sessionId,
        cwd: this.options.cwd,
        stopStatus: status,
      },
      { turnId },
    );
  }

  private emit(event: UiEvent): void {
    try {
      this.options.emit?.(event);
    } catch {
      // A UI renderer bug must not fail the turn.
    }
  }
}
