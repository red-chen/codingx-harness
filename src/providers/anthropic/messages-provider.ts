import { abortError, isAbortError, isRetryableCategory, ProviderError } from '../../util/errors.js';
import type { ProviderErrorCategory } from '../../util/errors.js';
import { redactString } from '../../util/redact.js';
import { estimateMessagesTokens } from '../tokens.js';
import { SseParser, type SseEvent } from '../sse.js';
import type {
  Message,
  ModelEvent,
  ModelRequest,
  Provider,
  StopReason,
} from '../types.js';

const DEFAULT_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 120_000;

export interface AnthropicProviderOptions {
  id: string;
  endpoint: string;
  apiKey: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  version?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Append /v1/messages unless the endpoint already points at it. */
export function resolveMessagesUrl(endpoint: string): string {
  const url = new URL(endpoint);
  let pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/messages')) {
    if (!pathname.endsWith('/v1')) pathname += '/v1';
    pathname += '/messages';
  }
  url.pathname = pathname;
  return url.toString();
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function classifyHttp(status: number, message: string, errorType?: string): ProviderErrorCategory {
  if (errorType && /content_policy|refusal/i.test(errorType)) return 'content_policy';
  if (/content policy|safety system/i.test(message)) return 'content_policy';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status === 413) return 'context_overflow';
  if (status >= 500) return 'server';
  if (status === 400 && /context length|too many tokens|prompt is too long|maximum.*tokens/i.test(message)) {
    return 'context_overflow';
  }
  return 'bad_request';
}

function classifyStreamError(errorType: string | undefined, message: string, hitMaxTokens: boolean): ProviderErrorCategory {
  if (hitMaxTokens) return 'context_overflow';
  if (errorType === 'overloaded_error' || errorType === 'api_error') return 'server';
  if (errorType === 'rate_limit_error') return 'rate_limit';
  if (errorType === 'authentication_error' || errorType === 'permission_error') return 'auth';
  if (errorType === 'request_too_large') return 'context_overflow';
  if (errorType === 'invalid_request_error' || errorType === 'not_found_error') return 'bad_request';
  if (errorType === 'content_policy_error' || errorType === 'refusal') return 'content_policy';
  if (/overloaded|temporarily unavailable/i.test(message)) return 'server';
  return 'protocol';
}

function parseErrorPayload(body: string): { errorType?: string; message: string } {
  const text = body.slice(0, 8192);
  try {
    const parsed: unknown = JSON.parse(text);
    const root = asObject(parsed);
    const error = asObject(root?.error);
    const message = asString(error?.message) ?? asString(root?.message) ?? text.slice(0, 2000);
    const errorType = asString(error?.type) ?? asString(root?.type);
    return {
      ...(errorType ? { errorType } : {}),
      message: redactString(message).value,
    };
  } catch {
    return { message: redactString(text.slice(0, 2000)).value };
  }
}

function httpError(status: number, retryAfterHeader: string | null, body: string): ProviderError {
  const parsed = parseErrorPayload(body);
  const category = classifyHttp(status, parsed.message, parsed.errorType);
  const retryAfterMs = parseRetryAfter(retryAfterHeader);
  return new ProviderError(
    'Anthropic request failed (HTTP ' + status + '): ' + parsed.message,
    {
      category,
      status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      retryable: isRetryableCategory(category),
      ...(parsed.errorType ? { details: { errorType: parsed.errorType } } : {}),
    },
  );
}

function streamError(payload: Record<string, unknown>): ProviderError {
  const error = asObject(payload.error);
  const errorType = asString(error?.type) ?? asString(payload.type);
  const message = redactString(asString(error?.message) ?? 'Anthropic stream error.').value;
  const category = classifyStreamError(errorType, message, errorType === 'max_tokens_error');
  return new ProviderError(
    'Anthropic stream error' + (errorType ? ' (' + errorType + ')' : '') + ': ' + message,
    {
      category,
      retryable: isRetryableCategory(category),
      ...(errorType ? { details: { errorType } } : {}),
    },
  );
}

function mapStopReason(value: string | undefined): StopReason | undefined {
  switch (value) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'end_turn';
    default:
      return undefined;
  }
}

interface ToolState {
  id: string;
  name: string;
  json: string;
}

class AnthropicStreamState {
  private inputTokens = 0;
  private outputTokens = 0;
  private hasInputTokens = false;
  private hasOutputTokens = false;
  private cacheReadTokens = 0;
  private hasCacheReadTokens = false;
  private cacheCreationTokens = 0;
  private readonly tools = new Map<number, ToolState>();
  private stopReason: StopReason | undefined;
  private messageStopped = false;
  private toolCalls = 0;

  handle(payload: unknown): ModelEvent[] {
    const record = asObject(payload);
    if (!record || typeof record.type !== 'string') {
      throw new ProviderError('Anthropic SSE event is missing a type.', { category: 'protocol' });
    }
    switch (record.type) {
      case 'message_start': {
        const message = asObject(record.message);
        this.readUsage(asObject(message?.usage));
        return [];
      }
      case 'content_block_start': {
        const index = asNumber(record.index);
        const block = asObject(record.content_block);
        if (index === undefined || !block) {
          throw new ProviderError('Malformed content_block_start event.', { category: 'protocol' });
        }
        if (block.type === 'tool_use') {
          const id = asString(block.id);
          const name = asString(block.name);
          if (!id || !name) throw new ProviderError('Tool use block is missing id or name.', { category: 'protocol' });
          this.tools.set(index, { id, name, json: '' });
        } else if (block.type === 'text') {
          const text = asString(block.text);
          if (text && text.length > 0) return [{ type: 'text.delta', text }];
        }
        return [];
      }
      case 'content_block_delta': {
        const delta = asObject(record.delta);
        if (!delta) throw new ProviderError('Malformed content_block_delta event.', { category: 'protocol' });
        if (delta.type === 'text_delta') {
          const text = asString(delta.text);
          return text && text.length > 0 ? [{ type: 'text.delta', text }] : [];
        }
        if (delta.type === 'input_json_delta') {
          const index = asNumber(record.index);
          const state = index === undefined ? undefined : this.tools.get(index);
          if (!state) throw new ProviderError('input_json_delta has no matching tool_use block.', { category: 'protocol' });
          const partial = asString(delta.partial_json);
          if (partial) state.json += partial;
        }
        return [];
      }
      case 'content_block_stop': {
        const index = asNumber(record.index);
        if (index === undefined) throw new ProviderError('content_block_stop is missing index.', { category: 'protocol' });
        return this.finishTool(index);
      }
      case 'message_delta': {
        const delta = asObject(record.delta);
        if (delta) {
          const reason = mapStopReason(asString(delta.stop_reason));
          if (reason) this.stopReason = reason;
        }
        this.readUsage(asObject(record.usage), true);
        return [];
      }
      case 'message_stop': {
        this.messageStopped = true;
        return this.finishOpenTools();
      }
      case 'ping':
        return [];
      case 'error':
        throw streamError(record);
      default:
        return [];
    }
  }

  finish(): ModelEvent[] {
    if (!this.messageStopped) {
      throw new ProviderError('Anthropic stream ended before message_stop.', { category: 'protocol' });
    }
    const events = this.finishOpenTools();
    events.push({
      type: 'usage',
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      ...(!this.hasInputTokens || !this.hasOutputTokens ? { complete: false } : {}),
      ...(this.hasCacheReadTokens ? { cacheReadTokens: this.cacheReadTokens } : {}),
      ...(this.cacheCreationTokens > 0 ? { cacheCreationTokens: this.cacheCreationTokens } : {}),
    });
    events.push({
      type: 'stop',
      reason: this.stopReason ?? (this.toolCalls > 0 ? 'tool_use' : 'end_turn'),
    });
    return events;
  }

  private readUsage(usage: Record<string, unknown> | undefined, final = false): void {
    if (!usage) return;
    const input = asNumber(usage.input_tokens);
    const output = asNumber(usage.output_tokens);
    const cacheRead = asNumber(usage.cache_read_input_tokens);
    const cacheCreation = asNumber(usage.cache_creation_input_tokens);
    if (input !== undefined) { this.inputTokens = input; this.hasInputTokens = true; }
    if (output !== undefined) { this.outputTokens = output; this.hasOutputTokens ||= final; }
    if (cacheRead !== undefined) {
      this.cacheReadTokens = cacheRead;
      this.hasCacheReadTokens = true;
    }
    if (cacheCreation !== undefined) this.cacheCreationTokens = cacheCreation;
  }

  private finishTool(index: number): ModelEvent[] {
    const state = this.tools.get(index);
    if (!state) return [];
    this.tools.delete(index);
    const raw = state.json.trim();
    let input: unknown = {};
    if (raw.length > 0) {
      try {
        input = JSON.parse(raw);
      } catch (error) {
        throw new ProviderError(
          'Invalid JSON for tool "' + state.name + '": ' + (error instanceof Error ? error.message : String(error)),
          { category: 'protocol', cause: error },
        );
      }
    }
    this.toolCalls += 1;
    return [{ type: 'tool.call', id: state.id, name: state.name, input }];
  }

  private finishOpenTools(): ModelEvent[] {
    const events: ModelEvent[] = [];
    for (const index of [...this.tools.keys()].sort((a, b) => a - b)) {
      events.push(...this.finishTool(index));
    }
    return events;
  }
}

function toWireMessages(messages: readonly Message[]): unknown[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map((block) => {
      if (block.type === 'image') {
        if (!block.data) throw new ProviderError('Image snapshot was not loaded: ' + block.name, { category: 'protocol' });
        return { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } };
      }
      if (block.type === 'text') return { type: 'text', text: block.text };
      if (block.type === 'tool_use') {
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} };
      }
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error ? { is_error: true } : {}),
      };
    }),
  }));
}

function buildRequestBody(req: ModelRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxOutputTokens,
    messages: toWireMessages(req.messages),
    stream: true,
  };
  if (req.system.length > 0) {
    body.system = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.reasoningEffort !== undefined) {
    // Anthropic Messages exposes reasoning intensity as output_config.effort.
    body.output_config = { effort: req.reasoningEffort };
  }
  if (req.tools.length > 0) {
    body.tools = req.tools.map((tool, index) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      ...(index === req.tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
    }));
  }
  return body;
}

/** Anthropic Messages protocol adapter (streaming, tool use, prompt caching). */
export class AnthropicMessagesProvider implements Provider {
  readonly id: string;
  readonly protocol = 'anthropic-messages' as const;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly version: string;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey) throw new ProviderError('Anthropic provider requires an API key.', { category: 'auth' });
    this.id = options.id;
    this.endpoint = resolveMessagesUrl(options.endpoint);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.version = options.version ?? DEFAULT_VERSION;
  }

  async countTokens(messages: Message[]): Promise<number> {
    return estimateMessagesTokens(messages);
  }

  async *stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    if (signal?.aborted) throw abortError();
    const timeoutController = new AbortController();
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    // This is an idle timeout, not a wall-clock deadline: a long response may
    // stream for many minutes as long as bytes keep arriving.
    const armTimeout = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        timeoutController.abort();
      }, this.requestTimeoutMs);
    };
    armTimeout();
    const onAbort = (): void => timeoutController.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const body = JSON.stringify(buildRequestBody(req));
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'x-api-key': this.apiKey,
            'anthropic-version': this.version,
          },
          body,
          signal: timeoutController.signal,
        });
      } catch (error) {
        throw this.transportError(error, signal, timedOut);
      }

      if (!response.ok) {
        let text = '';
        try {
          text = await response.text();
        } catch (error) {
          throw this.transportError(error, signal, timedOut);
        }
        const error = httpError(response.status, response.headers.get('retry-after'), text);
        if (req.messages.some(message => message.content.some(block => block.type === 'image'))) error.message = 'Request with image attachments rejected: ' + error.message;
        throw error;
      }
      if (!response.body) {
        throw new ProviderError('Anthropic response has no body.', { category: 'protocol' });
      }
      armTimeout();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      const state = new AnthropicStreamState();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          armTimeout();
          const text = decoder.decode(chunk.value, { stream: true });
          for (const sse of parser.push(text)) {
            for (const event of this.consumeSse(sse, state)) yield event;
          }
        }
        const tail = decoder.decode();
        if (tail.length > 0) {
          for (const sse of parser.push(tail)) {
            for (const event of this.consumeSse(sse, state)) yield event;
          }
        }
        for (const sse of parser.end()) {
          for (const event of this.consumeSse(sse, state)) yield event;
        }
        for (const event of state.finish()) yield event;
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (timedOut) throw this.timeoutError();
        if (error instanceof ProviderError) throw error;
        if (isAbortError(error)) throw abortError('Anthropic stream aborted.');
        throw new ProviderError(
          'Anthropic stream failed: ' + (error instanceof Error ? error.message : String(error)),
          { category: 'network', retryable: true, cause: error },
        );
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private consumeSse(sse: SseEvent, state: AnthropicStreamState): ModelEvent[] {
    if (sse.data.length === 0 || sse.data === '[DONE]') return [];
    let payload: unknown;
    try {
      payload = JSON.parse(sse.data);
    } catch (error) {
      throw new ProviderError(
        'Invalid JSON in Anthropic SSE event: ' + (error instanceof Error ? error.message : String(error)),
        { category: 'protocol', cause: error },
      );
    }
    return state.handle(payload);
  }

  private transportError(error: unknown, signal: AbortSignal | undefined, timedOut: boolean): Error {
    if (signal?.aborted) return abortError();
    if (timedOut) return this.timeoutError();
    if (isAbortError(error)) return abortError('Anthropic request aborted.');
    return new ProviderError(
      'Anthropic request failed: ' + (error instanceof Error ? error.message : String(error)),
      { category: 'network', retryable: true, cause: error },
    );
  }

  private timeoutError(): ProviderError {
    return new ProviderError('Anthropic request was idle for ' + this.requestTimeoutMs + 'ms.', {
      category: 'timeout',
      retryable: true,
    });
  }
}
