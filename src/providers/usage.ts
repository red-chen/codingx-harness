import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { ModelClient, ModelEvent, ModelRequest, TokenUsage } from './types.js';
import { addUsage, EMPTY_USAGE } from './types.js';
import type { SessionHandle } from '../session/types.js';

const count = z.number().int().nonnegative().safe();
export const requestUsageSchema = z.object({
  requestId: z.string().min(1), turnId: z.string().min(1),
  provider: z.string(), model: z.string(), origin: z.string().optional(),
  startedAt: z.string().datetime(), purpose: z.enum(['turn', 'compaction']),
  complete: z.boolean(), cacheBreakdownKnown: z.boolean(),
  usage: z.object({ inputTokens: count, outputTokens: count, cacheReadTokens: count, cacheCreationTokens: count }),
});
export type RequestUsage = z.infer<typeof requestUsageSchema>;

/** inputTokens excludes cache reads/creation (Anthropic-compatible normalized buckets). */
export function restoreRequestUsage(events: readonly { type: string; [key: string]: unknown }[]): RequestUsage[] {
  const records = new Map<string, RequestUsage>();
  for (const event of events) {
    if (event.type !== 'usage.recorded') continue;
    const parsed = requestUsageSchema.safeParse(event.record);
    if (parsed.success) records.set(parsed.data.requestId, parsed.data);
  }
  return [...records.values()];
}

/** Record every request, including interrupted requests and compression, through the single writer. */
export async function* recordUsageStream(options: {
  client: ModelClient; request: ModelRequest; session: SessionHandle; turnId: string;
  provider: string; origin?: string; purpose: RequestUsage['purpose']; signal?: AbortSignal;
  emit: (record: RequestUsage) => void;
}): AsyncIterable<ModelEvent> {
  const requestId = randomUUID();
  const startedAt = new Date().toISOString();
  let usage: TokenUsage = { ...EMPTY_USAGE };
  let complete = false;
  let allUsageComplete = true;
  let cacheBreakdownKnown = true;
  try {
    for await (const event of options.client.stream(options.request, options.signal)) {
      if (event.type === 'usage') {
        usage = addUsage(usage, event);
        allUsageComplete &&= event.complete !== false;
        complete = allUsageComplete;
        cacheBreakdownKnown &&= event.cacheReadTokens !== undefined;
      }
      yield event;
    }
  } finally {
    const record: RequestUsage = {
      requestId, turnId: options.turnId, provider: options.provider, model: options.request.model,
      ...(options.origin ? { origin: options.origin } : {}), startedAt, purpose: options.purpose,
      complete, cacheBreakdownKnown: complete && cacheBreakdownKnown, usage,
    };
    await options.session.append({ type: 'usage.recorded', turnId: options.turnId, record });
    options.emit(record);
  }
}
