import { createServer, connect } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JsonRpcPeer,
  RpcResponseError,
  RpcTimeoutError,
  SessiondRpcError,
} from '../src/sessiond/index.js';
import type { JsonRpcNotification } from '../src/sessiond/index.js';

interface Pair {
  server: JsonRpcPeer;
  client: JsonRpcPeer;
  notifications: JsonRpcNotification[];
  close(): Promise<void>;
}

const openPairs: Pair[] = [];

afterEach(async () => {
  while (openPairs.length > 0) {
    const pair = openPairs.pop();
    if (pair) await pair.close();
  }
});

async function openSockets(): Promise<{ a: Socket; b: Socket; server: Server; close(): Promise<void> }> {
  let resolveServer!: (socket: Socket) => void;
  const serverSocket = new Promise<Socket>((resolve) => {
    resolveServer = resolve;
  });
  const server = createServer((socket) => {
    resolveServer(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') throw new Error('no server address');
  const client = connect({ port: address.port, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });
  const a = await serverSocket;
  let closed = false;
  return {
    a,
    b: client,
    server,
    close: async () => {
      if (closed) return;
      closed = true;
      client.destroy();
      a.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function createPair(options: { delayMs?: number } = {}): Promise<Pair> {
  const sockets = await openSockets();
  const notifications: JsonRpcNotification[] = [];
  const server = new JsonRpcPeer({
    stream: sockets.a,
    onRequest: async (request) => {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (request.method === 'echo') return request.params;
      if (request.method === 'busy') throw new SessiondRpcError('SESSION_BUSY', 'session is busy', { sessionId: 's1' });
      if (request.method === 'boom') throw new Error('handler exploded');
      return { method: request.method };
    },
    onNotification: (notification) => {
      notifications.push(notification);
    },
  });
  const client = new JsonRpcPeer({
    stream: sockets.b,
    onNotification: (notification) => {
      notifications.push(notification);
    },
  });
  const pair: Pair = {
    server,
    client,
    notifications,
    close: async () => {
      client.close();
      server.close();
      await sockets.close();
    },
  };
  openPairs.push(pair);
  return pair;
}

describe('JsonRpcPeer', () => {
  it('round-trips requests and notifications', async () => {
    const pair = await createPair();
    await expect(pair.client.request('echo', { value: 42 })).resolves.toEqual({ value: 42 });
    await expect(pair.client.request('other', { x: 1 })).resolves.toEqual({ method: 'other' });
    pair.client.notify('client.note', { hello: true });
    pair.server.notify('server.note', { hello: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(new Set(pair.notifications.map((note) => note.method))).toEqual(
      new Set(['client.note', 'server.note']),
    );
  });

  it('maps SessiondRpcError to a structured response error', async () => {
    const pair = await createPair();
    await expect(pair.client.request('busy')).rejects.toMatchObject({
      name: 'RpcResponseError',
      code: -32002,
      kind: 'SESSION_BUSY',
    });
    const error = await pair.client.request('busy').catch((failure) => failure);
    expect(error).toBeInstanceOf(RpcResponseError);
    expect((error as RpcResponseError).data).toMatchObject({ kind: 'SESSION_BUSY', sessionId: 's1' });
  });

  it('maps handler exceptions to internal errors', async () => {
    const pair = await createPair();
    await expect(pair.client.request('boom')).rejects.toMatchObject({ code: -32603, message: 'handler exploded' });
  });

  it('times out outbound requests', async () => {
    const pair = await createPair({ delayMs: 100 });
    await expect(pair.client.request('slow', undefined, 20)).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it('rejects pending requests when closed', async () => {
    const pair = await createPair({ delayMs: 100 });
    const pending = pair.client.request('slow');
    pair.client.close();
    await expect(pending).rejects.toThrow(/closed/);
  });
});
