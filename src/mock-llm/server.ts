import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { CodingxError } from '../util/errors.js';
import { builtinScenarios } from './scenarios.js';
import { mockRequestSchema, mockScenarioSchema } from './types.js';
import type { MockBlock, MockRequest, MockRequestRecord, MockScenario, MockServer, MockServerOptions, MockStep } from './types.js';

function blocks(content: MockRequest['messages'][number]['content']): MockBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function error(res: ServerResponse, status: number, message: string, type = 'invalid_request_error'): void {
  json(res, status, { type: 'error', error: { type, message } });
}

function assertion(message: string): never {
  throw new CodingxError('PROVIDER_ERROR', 'Mock assertion failed: ' + message);
}

interface Selection {
  scenario: MockScenario;
  step: number;
  prefix: string;
  history: MockBlock[];
}

function select(request: MockRequest, scenarios: Map<string, MockScenario>, fallback: string): Selection {
  let turn = 0;
  for (let index = 0; index < request.messages.length; index++) {
    const message = request.messages[index]!;
    if (message.role === 'user' && blocks(message.content).some(block => block.type !== 'tool_result')) turn = index;
  }
  const prompt = blocks(request.messages[turn]!.content).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
  const id = /\[mock:([a-z][a-z0-9-]*)\]/.exec(prompt)?.[1]
    ?? (request.model.startsWith('mock-') ? request.model.slice(5) : fallback);
  const scenario = scenarios.get(id);
  if (!scenario) assertion('Unknown scenario. See GET /scenarios.');
  const history = request.messages.slice(turn).flatMap(message => blocks(message.content));
  const calls = request.messages.slice(turn).filter(message => message.role === 'assistant')
    .flatMap(message => blocks(message.content)).filter(block => block.type === 'tool_use');
  const prefix = `toolu_mock_${scenario.id}_`;
  let step = 0;
  for (const call of calls) {
    if (!call.id?.startsWith(prefix)) continue;
    const suffix = call.id.slice(prefix.length);
    const match = /^(\d+)_(\d+)_(\d+)$/.exec(suffix);
    if (match) step = Math.max(step, Number(match[2]) + 1);
  }
  // A turn index disambiguates IDs across turns, while progress comes from history,
  // not a global request counter. Resume/fork therefore keep their own progress.
  return { scenario, step, prefix: prefix + turn + '_', history };
}

function findResult(selection: Selection, step: number, index: number): MockBlock {
  const suffix = `_${step}_${index}`;
  const prefix = `toolu_mock_${selection.scenario.id}_`;
  const call = [...selection.history].reverse().find(block => block.type === 'tool_use' && block.id?.startsWith(prefix) && block.id.endsWith(suffix));
  if (!call) assertion(`Missing tool call at step ${step}, tool ${index}.`);
  const matches = selection.history.filter(block => block.type === 'tool_result' && block.tool_use_id === call.id);
  if (matches.length !== 1) assertion(`Expected one tool_result at step ${step}, tool ${index}.`);
  return matches[0]!;
}

function resultText(result: MockBlock): string {
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) return result.content.map(value => {
    if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string') return value.text;
    return '';
  }).join('\n');
  return '';
}

function checkPrevious(selection: Selection): void {
  if (selection.step === 0) return;
  const previous = selection.scenario.steps[selection.scenario.repeat ? (selection.step - 1) % selection.scenario.steps.length : selection.step - 1];
  if (!previous) assertion('Scenario exhausted. Start a new user turn.');
  previous.tools?.forEach((tool, index) => {
    const result = findResult(selection, selection.step - 1, index);
    const expected = tool.expect ?? { isError: false };
    if (expected.isError !== undefined && Boolean(result.is_error) !== expected.isError) {
      assertion(`Step ${selection.step - 1} ${tool.name}: expected is_error=${expected.isError}. Inspect codingx tool.result.`);
    }
    if (expected.contains !== undefined && !resultText(result).includes(expected.contains)) {
      assertion(`Step ${selection.step - 1} ${tool.name}: result does not contain the expected text.`);
    }
  });
}

/** {{step.tool.json.path}} references only parsed tool results; never evaluates code. */
function substitute(value: unknown, selection: Selection): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\d+)\.(\d+)\.([A-Za-z0-9_.]+)\}\}/g, (_match: string, step: string, tool: string, key: string) => {
      let parsed: unknown;
      try { parsed = JSON.parse(resultText(findResult(selection, Number(step), Number(tool)))); }
      catch { assertion('Template reference requires a JSON tool result.'); }
      for (const part of key.split('.')) {
        if (!parsed || typeof parsed !== 'object' || !Object.hasOwn(parsed, part)) assertion('Template field is missing.');
        parsed = (parsed as Record<string, unknown>)[part];
      }
      if (typeof parsed !== 'string' && typeof parsed !== 'number') assertion('Template field must be a string or number.');
      return String(parsed);
    });
  }
  if (Array.isArray(value)) return value.map(item => substitute(item, selection));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, selection)]));
  return value;
}

function* streamFrames(request: MockRequest, selection: Selection, step: MockStep, crlf: boolean): Generator<string> {
  const nl = crlf ? '\r\n' : '\n';
  const frame = (type: string, data: Record<string, unknown> = {}): string => `event: ${type}${nl}data: ${JSON.stringify({ type, ...data })}${nl}${nl}`;
  const usage = selection.scenario.usage ?? { input_tokens: 120, output_tokens: 32, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 };
  yield `: codingx mock${nl}${nl}`;
  yield frame('message_start', { message: { id: 'msg_mock', type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } });
  yield frame('ping');
  let index = 0;
  if (step.text) {
    yield frame('content_block_start', { index, content_block: { type: 'text', text: '' } });
    const chars = Array.from(step.text);
    for (let offset = 0; offset < chars.length; offset += 48) {
      yield frame('content_block_delta', { index, delta: { type: 'text_delta', text: chars.slice(offset, offset + 48).join('') } });
    }
    yield frame('content_block_stop', { index: index++ });
  }
  if (step.fault === 'stream-error') {
    yield frame('error', { error: { type: 'overloaded_error', message: 'Mock stream failure after content.' } });
    return;
  }
  if (step.fault === 'malformed-json') {
    yield `event: content_block_delta${nl}data: {invalid JSON${nl}${nl}`;
    return;
  }
  if (step.fault === 'disconnect') return; // Intentionally omit message_stop.
  for (const [toolIndex, tool] of (step.tools ?? []).entries()) {
    yield frame('content_block_start', { index, content_block: { type: 'tool_use', id: selection.prefix + selection.step + '_' + toolIndex, name: tool.name, input: {} } });
    const input = JSON.stringify(substitute(tool.input, selection));
    for (let offset = 0; offset < input.length; offset += 13) {
      yield frame('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: input.slice(offset, offset + 13) } });
    }
    yield frame('content_block_stop', { index: index++ });
  }
  yield frame('message_delta', { delta: { stop_reason: step.stop ?? (step.tools?.length ? 'tool_use' : 'end_turn'), stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  yield frame('message_stop');
}

async function writeFrame(res: ServerResponse, frame: string, size: number, delayMs: number, signal: AbortSignal): Promise<void> {
  const bytes = Buffer.from(frame);
  for (let offset = 0; offset < bytes.length; offset += size) {
    if (signal.aborted) return;
    // The callback respects socket backpressure and prevents unbounded buffering.
    await new Promise<void>((resolve, reject) => res.write(bytes.subarray(offset, offset + size), err => err ? reject(err) : resolve()));
    if (delayMs) await delay(delayMs, undefined, { signal });
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = (): void => {
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAborted);
    };
    const onError = (cause: Error): void => { cleanup(); reject(cause); };
    const onAborted = (): void => onError(new CodingxError('ABORTED', 'Mock request aborted.'));
    const onData = (buffer: Buffer): void => {
      bytes += buffer.length;
      if (bytes > maxBytes) {
        cleanup();
        req.resume();
        reject(new CodingxError('PROVIDER_ERROR', 'Request body exceeds mock limit.', { details: { status: 413 } }));
      } else chunks.push(buffer);
    };
    const onEnd = (): void => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
      catch (cause) { reject(cause); }
    };
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAborted);
  });
}

/** Local-only, no upstream calls and no credential/request-body logging. */
export async function startMockServer(options: MockServerOptions = {}): Promise<MockServer> {
  const scenarios = new Map<string, MockScenario>();
  for (const value of [...builtinScenarios, ...(options.scenarios ?? [])]) {
    const parsed = mockScenarioSchema.safeParse(value);
    if (!parsed.success) throw new CodingxError('CONFIG_ERROR', 'Invalid mock scenario: ' + parsed.error.message);
    if (scenarios.has(parsed.data.id)) throw new CodingxError('CONFIG_ERROR', 'Duplicate mock scenario: ' + parsed.data.id);
    scenarios.set(parsed.data.id, parsed.data);
  }
  const fallback = options.scenario ?? 'text';
  if (!scenarios.has(fallback)) throw new CodingxError('CONFIG_ERROR', 'Unknown default mock scenario.');
  const chunkBytes = options.chunkBytes ?? 1024;
  const delayMs = options.delayMs ?? 0;
  const maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
    throw new CodingxError('CONFIG_ERROR', 'Invalid mock port.');
  }
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 1_048_576 || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000 || !Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new CodingxError('CONFIG_ERROR', 'Invalid mock chunkBytes, delayMs or maxBodyBytes.');
  }
  const records: MockRequestRecord[] = [];
  const attempts = new Map<string, number>();
  let sequence = 0;
  const server = createServer((req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    void (async () => {
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, service: 'codingx-mock-llm' });
      if (req.method === 'GET' && req.url === '/scenarios') return json(res, 200, [...scenarios.values()].map(({ id, description }) => ({ id, description })));
      if (req.method === 'GET' && req.url === '/stats') return json(res, 200, { requests: sequence, recent: records });
      if (req.method !== 'POST' || req.url !== '/v1/messages') return error(res, 404, 'Use POST /v1/messages, GET /health, /scenarios or /stats.');
      let body: unknown;
      try { body = await readBody(req, maxBodyBytes); }
      catch (cause) {
        if (!res.destroyed) {
          const status = cause instanceof CodingxError && cause.details?.status === 413 ? 413 : 400;
          res.setHeader('connection', 'close');
          error(res, status, status === 413 ? 'Request body exceeds mock limit.' : 'Invalid JSON request body.');
        }
        return;
      }
      const parsed = mockRequestSchema.safeParse(body);
      if (!parsed.success) return error(res, 400, 'Expected streaming Anthropic Messages request: model, max_tokens, stream=true, messages.');
      const request = parsed.data;
      const system = typeof request.system === 'string' ? request.system : request.system?.map(block => block.text ?? '').join('\n') ?? '';
      const summarizing = system.startsWith('You compress conversation history for a coding agent');
      let selection: Selection;
      try {
        selection = summarizing ? {
          scenario: { id: 'summary', description: 'Compression fixture', steps: [{ text: '## Completed\nMock history received for compression.\n## Key files\nSee retained messages.\n## Decisions\nContinue the deterministic mock scenario.\n## Open questions\nThis fixture is not a semantic summary.' }] },
          step: 0, prefix: '', history: [],
        } : select(request, scenarios, fallback);
      } catch { return error(res, 400, 'Unknown scenario. See GET /scenarios.'); }
      const images = request.messages.flatMap(message => blocks(message.content)).filter(block => block.type === 'image').length;
      const record: MockRequestRecord = {
        sequence: ++sequence, scenario: selection.scenario.id, step: selection.step, status: 200,
        messages: request.messages.length, images, tools: request.tools?.length ?? 0,
        ...(request.output_config ? { effort: request.output_config.effort } : {}),
        systemCache: Array.isArray(request.system) && request.system.some(block => block.cache_control !== undefined),
        toolsCache: request.tools?.some(tool => tool.cache_control !== undefined) ?? false,
      };
      records.push(record);
      if (records.length > 100) records.shift();
      const failure = selection.scenario.httpError;
      if (failure) {
        const key = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const attempt = (attempts.get(key) ?? 0) + 1;
        if (failure.attempts === undefined || attempt <= failure.attempts) {
          if (failure.attempts !== undefined) {
            attempts.set(key, attempt);
            if (attempts.size > 1000) attempts.delete(attempts.keys().next().value!);
          }
          record.status = failure.status;
          res.setHeader('retry-after', '0');
          return error(res, failure.status, failure.message, failure.type);
        }
        attempts.delete(key);
      }
      const step = selection.scenario.steps[selection.scenario.repeat ? selection.step % selection.scenario.steps.length : selection.step];
      let frames: string[];
      try {
        checkPrevious(selection);
        if (!step) assertion('Scenario exhausted. Start a new user turn.');
        if (selection.scenario.requireImage && !selection.history.some(block => block.type === 'image')) assertion('Image scenario requires an image in the current turn.');
        frames = [...streamFrames(request, selection, step, options.crlf ?? false)];
      } catch (cause) {
        record.status = 409;
        return error(res, 409, cause instanceof CodingxError ? cause.message : 'Mock scenario assertion failed.');
      }
      if (step.delayMs) await delay(step.delayMs, undefined, { signal: controller.signal });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      for (const frame of frames) {
        await writeFrame(res, frame, chunkBytes, delayMs, controller.signal);
        if (controller.signal.aborted) return;
      }
      res.end();
    })().catch(() => {
      if (res.destroyed) return;
      if (!res.headersSent) error(res, 500, 'Mock server failure.', 'api_error');
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new CodingxError('INTERNAL', 'Mock server has no TCP address.');
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}`, records,
    close: () => closing ??= new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
      server.closeAllConnections();
    }),
  };
}
