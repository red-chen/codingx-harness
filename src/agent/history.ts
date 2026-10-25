import path from 'node:path';
import type { Message, ReasoningEffort, ToolCall } from '../providers/types.js';
import { assistantMessage, isReasoningEffort, toolResultsMessage } from '../providers/types.js';
import type { RolloutEvent } from '../session/types.js';
import type { ReadFileTracker } from '../tools/read-tracker.js';
import type { PlanStep } from '../tools/types.js';
import { canonicalizePath, expandHome, isPathInside } from '../util/paths.js';

export const SYNTHETIC_TOOL_RESULT =
  'Synthetic tool result: the session was interrupted while this tool call was executing or awaiting approval.';

export interface SyntheticToolResult {
  turnId: string;
  callId: string;
  name: string;
  content: string;
  isError: true;
  synthetic: true;
}

export interface ReadFileCall {
  path: string;
  isError: boolean;
}

export interface RebuiltHistory {
  messages: Message[];
  syntheticResults: SyntheticToolResult[];
  readFileCalls: ReadFileCall[];
  /** Last plan snapshot persisted by UpdatePlan, if any. */
  plan?: PlanStep[];
  lastTurnId?: string;
}

interface StoredToolResult {
  content: string;
  isError: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCall[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const id = asString(item.id);
    const name = asString(item.name);
    if (!id || !name) continue;
    calls.push({ id, name, input: item.input });
  }
  return calls;
}

function collectResults(events: readonly RolloutEvent[]): Map<string, StoredToolResult> {
  const results = new Map<string, StoredToolResult>();
  for (const event of events) {
    if (event.type !== 'tool.result') continue;
    const callId =
      asString(event.callId) ?? asString(event.toolCallId) ?? asString(event.id);
    if (!callId) continue;
    results.set(callId, {
      content: asString(event.content) ?? '',
      isError: event.isError === true,
    });
  }
  return results;
}

function appendUserText(messages: Message[], text: string): void {
  if (text.length === 0) return;
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    last.content.push({ type: 'text', text });
  } else {
    messages.push({ role: 'user', content: [{ type: 'text', text }] });
  }
}

/**
 * Rebuild the canonical message history from a rollout. Tool results are
 * attached to the assistant tool_use message they belong to; a missing result
 * (CLI crash / interrupt during tool execution) becomes an explicit synthetic
 * error so the next request keeps a valid tool_use/tool_result pairing.
 */
export function rebuildHistory(events: readonly RolloutEvent[]): RebuiltHistory {
  const results = collectResults(events);
  const messages: Message[] = [];
  const syntheticResults: SyntheticToolResult[] = [];
  const readFileCalls: ReadFileCall[] = [];
  let plan: PlanStep[] | undefined;
  let lastTurnId: string | undefined;

  for (const event of events) {
    if (event.type === 'turn.start' || event.type === 'turn.end' || event.type === 'turn.aborted') {
      const turnId = asString(event.turnId);
      if (turnId) lastTurnId = turnId;
      continue;
    }
    if (event.type === 'user.message') {
      appendUserText(messages, asString(event.text) ?? '');
      continue;
    }
    if (event.type === 'plan.updated') {
      const rawSteps = Array.isArray(event.steps) ? event.steps : [];
      const steps: PlanStep[] = [];
      for (const raw of rawSteps) {
        if (!isObject(raw)) continue;
        const text = asString(raw.step);
        const status = asString(raw.status);
        if (!text) continue;
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue;
        steps.push({ step: text, status });
      }
      if (steps.length > 0) plan = steps;
      continue;
    }
    if (event.type !== 'assistant.message') continue;

    const turnId = asString(event.turnId) ?? '';
    if (turnId) lastTurnId = turnId;
    const text = asString(event.text) ?? '';
    const calls = parseCalls(event.calls);
    if (text.length === 0 && calls.length === 0) continue;

    messages.push(assistantMessage(text, calls));
    if (calls.length === 0) continue;

    const orderedResults: Array<{ id: string; content: string; isError: boolean }> = [];
    for (const call of calls) {
      const stored = results.get(call.id);
      const isError = stored ? stored.isError : true;
      const content = stored ? stored.content : SYNTHETIC_TOOL_RESULT;
      if (!stored) {
        syntheticResults.push({
          turnId,
          callId: call.id,
          name: call.name,
          content: SYNTHETIC_TOOL_RESULT,
          isError: true,
          synthetic: true,
        });
      }
      if (call.name === 'ReadFile' && isObject(call.input)) {
        const rawPath = asString(call.input.path);
        if (rawPath) readFileCalls.push({ path: rawPath, isError });
      }
      orderedResults.push({ id: call.id, content, isError });
    }
    messages.push(toolResultsMessage(orderedResults));
  }

  return {
    messages,
    syntheticResults,
    readFileCalls,
    ...(plan ? { plan } : {}),
    ...(lastTurnId ? { lastTurnId } : {}),
  };
}

/** Latest model/effort selected in a rollout; absent fields mean provider defaults. */
export interface StoredModelSelection {
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

/**
 * Find the last `model.changed` event so resume can continue with the model the
 * user selected. Unknown/malformed effort values are treated as cleared.
 */
export function latestModelSelection(events: readonly RolloutEvent[]): StoredModelSelection {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'model.changed') continue;
    const model = asString(event.model);
    const effort = isReasoningEffort(event.reasoningEffort) ? event.reasoningEffort : undefined;
    return {
      ...(model && model.length > 0 ? { model } : {}),
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    };
  }
  return {};
}

/** Mark files successfully read before a resume so EditFile still works. */
export async function restoreReadTracker(
  rebuilt: RebuiltHistory,
  cwd: string,
  tracker: ReadFileTracker,
  additionalDirs: readonly string[] = [],
): Promise<number> {
  const roots = [await canonicalizePath(cwd)];
  for (const directory of additionalDirs) {
    const root = await canonicalizePath(directory);
    if (!roots.includes(root)) roots.push(root);
  }
  let marked = 0;
  for (const call of rebuilt.readFileCalls) {
    if (call.isError) continue;
    try {
      const expanded = expandHome(call.path);
      const absolute = await canonicalizePath(path.resolve(cwd, expanded));
      if (!roots.some((root) => isPathInside(root, absolute))) continue;
      tracker.markRead(absolute);
      marked += 1;
    } catch {
      // A path that no longer exists must not prevent resume.
    }
  }
  return marked;
}
