import { lookup } from 'node:dns/promises';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { allowsPrivateHost, domainDecision, domainMatches, isPublicAddress, normalizeHost } from '../policy/domains.js';
import { isLocalHost } from '../policy/network.js';

export interface NetworkProxy {
  port: number;
  url: string;
  /** Bounded, host-only denial diagnostics. No URLs, headers or credentials. */
  denied: string[];
  close(): Promise<void>;
}

export interface NetworkProxyOptions {
  localOnly?: boolean;
  domains: Record<string, 'allow' | 'deny'>;
  /** Tests use a local resolver; execution always uses node:dns. */
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
}

function cleanHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  const remove = ['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'upgrade', 'te', 'trailer', 'transfer-encoding',
    ...(headers.connection ?? '').split(',').map((s) => s.trim().toLowerCase())];
  for (const key of remove) delete result[key];
  return result;
}

/** One process owns one proxy. Closing it destroys all active tunnels. */
export async function startNetworkProxy(options: NetworkProxyOptions): Promise<NetworkProxy> {
  const sockets = new Set<Duplex>();
  const denied: string[] = [];
  let closed = false;
  let port = 0;
  const domains = { ...options.domains };
  const track = <T extends Duplex>(socket: T): T => {
    if (closed) { socket.destroy(); return socket; }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    return socket;
  };
  const reject = (host: string): never => {
    if (denied.length < 16) denied.push('Network proxy denied host: ' + host);
    throw new Error('NETWORK_DENIED');
  };
  const resolve = async (rawHost: string, targetPort: number): Promise<{ host: string; address: string; family: number }> => {
    const host = normalizeHost(rawHost);
    if (domainDecision(domains, host) !== 'allow') return reject(host);
    if (targetPort < 1 || targetPort > 65535) return reject(host);
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }]
      : await (options.lookup ?? ((name) => lookup(name, { all: true })))(host);
    if (closed || addresses.length === 0) throw new Error('Proxy closed or DNS returned no addresses.');
    // Validate ALL answers and then dial the chosen numeric IP. No second DNS lookup.
    for (const item of addresses) {
      if (!isIP(item.address)) return reject(host);
      if (Object.entries(domains).some(([pattern, decision]) => decision === 'deny' && domainMatches(pattern, item.address))) return reject(host);
      if (options.localOnly && !isLocalHost(item.address)) return reject(host);
      const localAlias = host === 'localhost' && (item.address === '127.0.0.1' || item.address === '::1') && allowsPrivateHost(domains, host);
      if (!isPublicAddress(item.address) && !localAlias && !allowsPrivateHost(domains, item.address)) return reject(host);
      if (targetPort === port && (item.address === '127.0.0.1' || item.address === '::1')) return reject(host);
    }
    return { host, ...addresses[0]! };
  };
  const server = createServer({ maxHeaderSize: 16_384, requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    req.on('error', () => res.destroy());
    res.on('error', () => {});
    void (async () => {
      const target = new URL(req.url ?? '');
      if (target.protocol !== 'http:' || target.username || target.password) { res.writeHead(400).end(); return; }
      const destination = await resolve(target.hostname, Number(target.port || 80));
      if (closed || res.destroyed) return;
      const headers = cleanHeaders(req.headers);
      headers.host = target.host;
      const upstream = request({
        host: destination.address, family: destination.family, port: Number(target.port || 80),
        method: req.method, path: target.pathname + target.search, headers, agent: false,
      }, (response) => {
        res.writeHead(response.statusCode ?? 502, cleanHeaders(response.headers));
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      upstream.on('socket', track);
      upstream.setTimeout(30_000, () => upstream.destroy());
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => upstream.destroy());
      req.on('aborted', () => upstream.destroy());
      req.pipe(upstream);
    })().catch(() => { if (!res.headersSent) res.writeHead(403); res.end('Network proxy denied request.'); });
  });
  server.maxConnections = 128;
  server.maxRequestsPerSocket = 64;
  server.on('connection', (socket: Socket) => {
    if (sockets.size >= 256) { socket.destroy(); return; }
    track(socket);
    socket.setTimeout(60_000, () => socket.destroy());
  });
  server.on('connect', (req, client, head) => {
    void (async () => {
      const authority = req.url ?? '';
      if (!/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):[0-9]{1,5}$/u.test(authority)) throw new Error('Invalid CONNECT authority.');
      const target = new URL('http://' + authority);
      const targetPort = Number(authority.slice(authority.lastIndexOf(':') + 1));
      const destination = await resolve(target.hostname, targetPort);
      if (closed || client.destroyed) return;
      const upstream = track(connect({ host: destination.address, port: targetPort, family: destination.family }));
      upstream.setTimeout(30_000, () => upstream.destroy());
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
      upstream.once('error', () => client.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
    })().catch(() => { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => { server.off('error', rejectListen); resolveListen(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Proxy has no TCP address.');
  port = address.port;
  let closing: Promise<void> | undefined;
  return {
    port, url: 'http://127.0.0.1:' + port, denied,
    close: () => {
      closing ??= new Promise<void>((done) => {
        closed = true;
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      });
      return closing;
    },
  };
}
