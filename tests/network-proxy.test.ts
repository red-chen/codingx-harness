import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { startNetworkProxy, type NetworkProxy } from '../src/sandbox/network.js';
import { domainMatches, isPublicAddress } from '../src/policy/domains.js';

let server: Server;
let port: number;
let hits: number;
const proxies: NetworkProxy[] = [];
beforeEach(async () => {
  hits = 0;
  server = createServer((req, res) => { hits++; res.end(JSON.stringify({ host: req.headers.host, proxyAuth: req.headers['proxy-authorization'], path: req.url })); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.close()));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function proxy(options: Parameters<typeof startNetworkProxy>[0]): Promise<NetworkProxy> {
  const result = await startNetworkProxy(options); proxies.push(result); return result;
}
function get(p: NetworkProxy, target: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: p.port, path: target, headers, agent: false }, (res) => {
      let body = ''; res.on('data', (chunk) => { body += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject); req.end();
  });
}
function tunnel(p: NetworkProxy, authority: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: p.port, method: 'CONNECT', path: authority, agent: false });
    req.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) { socket.destroy(); resolve({ status: res.statusCode!, body: '' }); return; }
      let body = head.toString();
      socket.on('data', (chunk) => { body += String(chunk); });
      socket.on('end', () => { socket.destroy(); resolve({ status: res.statusCode!, body }); });
      socket.on('error', reject);
      socket.write('GET /tunnel HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    });
    req.on('error', reject); req.end();
  });
}
describe('managed network proxy', () => {
  it('uses exact/single/deep wildcard matching and classifies nonpublic addresses', () => {
    expect(domainMatches('*.example.com', 'a.example.com')).toBe(true);
    expect(domainMatches('*.example.com', 'a.b.example.com')).toBe(false);
    expect(domainMatches('**.example.com', 'example.com')).toBe(true);
    expect(domainMatches('**.example.com', 'a.b.example.com.')).toBe(true);
    expect(domainMatches('*.example.com', 'badexample.com')).toBe(false);
    for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::']) expect(isPublicAddress(ip)).toBe(false);
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('forwards HTTP, fixes Host, strips proxy credentials and rejects unlisted hosts', async () => {
    const p = await proxy({ domains: { '127.0.0.1': 'allow' } });
    const response = await get(p, 'http://127.0.0.1:' + port + '/path?q=1', { Host: 'spoofed.example', 'Proxy-Authorization': 'secret' });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ host: '127.0.0.1:' + port, path: '/path?q=1' });
    expect((await get(p, 'http://localhost:' + port)).status).toBe(403);
    expect(hits).toBe(1);
    expect(p.denied.join(' ')).not.toContain('secret');
  });

  it('supports CONNECT and denies forbidden or malformed destinations', async () => {
    const p = await proxy({ domains: { '127.0.0.1': 'allow', localhost: 'deny' } });
    const response = await tunnel(p, '127.0.0.1:' + port);
    expect(response.status).toBe(200); expect(response.body).toContain('/tunnel');
    expect((await tunnel(p, 'localhost:' + port)).status).toBe(403);
    expect((await tunnel(p, 'user@127.0.0.1:' + port)).status).toBe(403);
    expect(hits).toBe(1);
  });

  it('applies deny over wildcard allow before DNS or upstream access', async () => {
    let lookups = 0;
    const p = await proxy({ domains: { '**.example.test': 'allow', 'blocked.example.test': 'deny' },
      lookup: async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }]; } });
    expect((await get(p, 'http://blocked.example.test:' + port)).status).toBe(403);
    expect(lookups).toBe(0); expect(hits).toBe(0);
  });

  it('blocks DNS rebinding, mixed public/private answers and encoded IP literals', async () => {
    const p = await proxy({ domains: { 'allowed.test': 'allow' }, lookup: async () => [
      { address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 },
    ] });
    expect((await get(p, 'http://allowed.test:' + port)).status).toBe(403);
    expect((await get(p, 'http://2130706433:' + port)).status).toBe(403);
    expect((await get(p, 'http://0x7f000001:' + port)).status).toBe(403);
    expect(hits).toBe(0);
  });

  it('pins a validated DNS answer and requires a separate exact private IP grant', async () => {
    let lookups = 0;
    const p = await proxy({ domains: { 'allowed.test': 'allow', '127.0.0.1': 'allow' }, lookup: async () => {
      lookups++; return [{ address: '127.0.0.1', family: 4 }];
    } });
    const response = await get(p, 'http://allowed.test:' + port);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).host).toBe('allowed.test:' + port);
    expect(lookups).toBe(1);
  });

  it('destroys active sockets and releases its port on cleanup', async () => {
    const p = await proxy({ domains: {} });
    const socket = connect(p.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const ended = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await p.close(); await ended; await p.close();
    await expect(get(p, 'http://127.0.0.1:' + port)).rejects.toThrow(/ECONNREFUSED/);
  });
});
