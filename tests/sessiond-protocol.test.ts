import { describe, expect, it } from 'vitest';
import {
  JSON_RPC_ERROR_CODES,
  MAX_FRAME_BYTES,
  NdjsonDecoder,
  SESSIOND_ERROR_CODES,
  SESSIOND_PROTOCOL_VERSION,
  encodeFrame,
  errorResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  notification,
  parseJsonRpcMessage,
  successResponse,
  validateEventSize,
} from '../src/sessiond/index.js';
import type { JsonRpcMessage } from '../src/sessiond/index.js';

function decoderFrames(frames: ReturnType<NdjsonDecoder['push']>): JsonRpcMessage[] {
  return frames.flatMap((frame) => (frame.type === 'message' ? [frame.message] : []));
}

describe('sessiond protocol types', () => {
  it('exposes the protocol version and stable error codes', () => {
    expect(SESSIOND_PROTOCOL_VERSION).toBe(1);
    expect(SESSIOND_ERROR_CODES.PROTOCOL_MISMATCH).toBe(-32001);
    expect(SESSIOND_ERROR_CODES.SESSION_BUSY).toBe(-32002);
    expect(SESSIOND_ERROR_CODES.LEASE_REVOKED).toBe(-32003);
    expect(JSON_RPC_ERROR_CODES.PARSE_ERROR).toBe(-32700);
  });

  it('distinguishes requests, notifications and responses', () => {
    const request = { jsonrpc: '2.0' as const, id: 1, method: 'initialize', params: { protocol: 1 } };
    const note = { jsonrpc: '2.0' as const, method: 'session.event', params: {} };
    const success = successResponse(1, { ok: true });
    const failure = errorResponse(1, 'SESSION_BUSY', 'busy');

    expect(isJsonRpcRequest(request)).toBe(true);
    expect(isJsonRpcNotification(request)).toBe(false);
    expect(isJsonRpcNotification(note)).toBe(true);
    expect(isJsonRpcResponse(success)).toBe(true);
    expect(isJsonRpcResponse(failure)).toBe(true);
    expect(parseJsonRpcMessage({ jsonrpc: '2.0', id: 1 })).toBeUndefined();
    expect(failure.error).toMatchObject({ code: -32002, data: { kind: 'SESSION_BUSY' } });
  });

  it('builds daemon notifications', () => {
    const msg = notification('session.status', { sessionId: 's1', status: 'idle' });
    expect(msg).toEqual({
      jsonrpc: '2.0',
      method: 'session.status',
      params: { sessionId: 's1', status: 'idle' },
    });
    expect(isJsonRpcNotification(msg)).toBe(true);
  });
});

describe('NdjsonDecoder', () => {
  it('decodes multiple frames, CRLF and split chunks', () => {
    const decoder = new NdjsonDecoder();
    const one = encodeFrame({ jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocol: 1 } });
    const two = encodeFrame(successResponse(2, { ok: true }));
    expect(decoderFrames(decoder.push(one.subarray(0, 3)))).toHaveLength(0);
    const frames = decoderFrames(decoder.push(Buffer.concat([one.subarray(3), two, Buffer.from('\r\n')])));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ id: 'a', method: 'initialize' });
    expect(frames[1]).toMatchObject({ id: 2, result: { ok: true } });
    expect(decoder.end()).toEqual([]);
  });

  it('reports parse errors and skips the bad line', () => {
    const decoder = new NdjsonDecoder();
    const frames = decoder.push('not json\n' + JSON.stringify({ jsonrpc: '2.0', method: 'ping' }) + '\n');
    expect(frames[0]).toMatchObject({ type: 'error', code: JSON_RPC_ERROR_CODES.PARSE_ERROR });
    expect(frames[1]).toMatchObject({ type: 'message', message: { method: 'ping' } });
  });

  it('enforces the frame size limit and resynchronizes', () => {
    const decoder = new NdjsonDecoder();
    const tooLarge = decoder.push('x'.repeat(MAX_FRAME_BYTES + 1));
    expect(tooLarge).toEqual([
      { type: 'error', code: SESSIOND_ERROR_CODES.FRAME_TOO_LARGE, message: expect.any(String) },
    ]);
    expect(decoder.push('\n')).toEqual([]);
    const note = notification('session.lagged', { sessionId: 's1', lastSeq: 1, dropped: 2 });
    const frames = decoderFrames(decoder.push(encodeFrame(note)));
    expect(frames).toEqual([note]);
  });

  it('reports an incomplete trailing frame at end()', () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push('{"jsonrpc":"2.0"')).toEqual([]);
    expect(decoder.end()).toEqual([
      { type: 'error', code: JSON_RPC_ERROR_CODES.PARSE_ERROR, message: expect.stringMatching(/Incomplete/) },
    ]);
  });
});

describe('frame encoding and event limits', () => {
  it('rejects oversized outbound frames and events', () => {
    expect(() =>
      encodeFrame({ jsonrpc: '2.0', id: 1, method: 'x', params: { blob: 'x'.repeat(MAX_FRAME_BYTES + 1) } }),
    ).toThrow(/frame exceeds/i);

    expect(() => validateEventSize({ text: 'x'.repeat(1024 * 1024 + 1) })).toThrow(/event exceeds/i);
    expect(() => validateEventSize({ text: 'small' })).not.toThrow();
  });
});
