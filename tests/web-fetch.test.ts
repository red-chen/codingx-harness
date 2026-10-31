import { beforeAll, afterAll, beforeEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { ReadFileTracker, ToolRegistry, type ToolContext } from '../src/tools/index.js';
import { webFetchTool } from '../src/tools/web-fetch.js';
const state=vi.hoisted(()=>({port:0,addresses:[{address:'93.184.216.34',family:4}],pins:[] as string[],hits:0}));
vi.mock('node:dns/promises',()=>({lookup:vi.fn(async()=>state.addresses)}));
vi.mock('node:https',async importOriginal=>{
  const original=await importOriginal<typeof import('node:https')>();
  return {...original,request:(url:URL,options:import('node:https').RequestOptions,callback:Parameters<typeof original.request>[2])=>{
    // Test-only transport redirects the validated public destination to a local TLS fixture.
    (options.lookup as Function)('fixture',{},(_error:unknown,address:string)=>state.pins.push(address));
    return original.request(new URL(url.pathname+url.search,'https://localhost:'+state.port),{...options,lookup:undefined,ca:readFileSync(new URL('./fixtures/web/cert.pem',import.meta.url))},callback!);
  }};
});
let server:Server;
beforeAll(async()=>{
  server=createServer({key:readFileSync(new URL('./fixtures/web/key.pem',import.meta.url)),cert:readFileSync(new URL('./fixtures/web/cert.pem',import.meta.url))},(req,res)=>{
    state.hits++;
    if(req.url==='/redirect'){res.writeHead(302,{Location:'https://example.test/page'});res.end();return;}
    if(req.url==='/private'){res.writeHead(302,{Location:'https://127.0.0.1/'});res.end();return;}
    if(req.url==='/loop'){res.writeHead(302,{Location:'/loop'});res.end();return;}
    if(req.url==='/binary'){res.setHeader('content-type','image/png');res.end('binary');return;}
    if(req.url==='/slow'){return;}
    if(req.url==='/bomb'){res.writeHead(200,{'content-type':'text/plain','content-encoding':'gzip'});res.end(gzipSync('x'.repeat(2*1024*1024+1)));return;}
    if(req.url==='/json'){res.setHeader('content-type','application/json');res.end('{"answer":42}');return;}
    res.setHeader('content-type','text/html');res.end('<title>Test &amp; page</title><nav>omit nav</nav><main><h1>Hello</h1><script>bad()</script><p>Useful <a href="/docs">link</a></p>'+('content '.repeat(100))+'</main>');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));state.port=(server.address() as AddressInfo).port;
});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
beforeEach(()=>{state.addresses=[{address:'93.184.216.34',family:4}];state.hits=0;state.pins=[];});
function context():ToolContext{return {cwd:process.cwd(),readTracker:new ReadFileTracker(),signal:new AbortController().signal,maxOutputChars:3000,shell:{env:{},timeoutMs:1000},web:{enabled:true,allowedDomains:['example.test','127.0.0.1']}};}
const registry=new ToolRegistry([webFetchTool]);
const fetchPage=(pathname:string,ctx=context())=>registry.execute('WebFetch',{url:'https://example.test'+pathname},ctx);
it('extracts title/body/links, ignores scripts and pins DNS on each redirect',async()=>{
  const r=await fetchPage('/redirect'); expect(r.isError).toBeUndefined();expect(r.content).toContain('Test & page');expect(r.content).toContain('https://example.test/docs');expect(r.content).not.toContain('bad()');expect(r.content).not.toContain('omit nav');expect(state.pins).toEqual(['93.184.216.34','93.184.216.34']);
});
it('supports JSON and marks output truncation',async()=>{
  expect((await fetchPage('/json')).content).toContain('"answer":42');
  const ctx=context();ctx.maxOutputChars=250;expect(await fetchPage('/page',ctx)).toMatchObject({meta:{truncated:true}});
});
it('rejects binary, compressed bombs and excessive redirects',async()=>{
  for(const pathname of ['/binary','/bomb','/loop'])expect(await fetchPage(pathname)).toMatchObject({isError:true,meta:{code:'WEB_FETCH_ERROR'}});
});
it('denies disabled/domain/private/mixed DNS answers without connecting',async()=>{
  const disabled=context();disabled.web!.enabled=false;expect((await fetchPage('/page',disabled)).isError).toBe(true);
  const denied=context();denied.web!.allowedDomains=[];expect((await fetchPage('/page',denied)).isError).toBe(true);
  state.addresses.push({address:'127.0.0.1',family:4});expect((await fetchPage('/page')).isError).toBe(true);expect(state.hits).toBe(0);
});
it('rechecks redirected destinations and cancels an in-flight request',async()=>{
  expect(await fetchPage('/private')).toMatchObject({isError:true,meta:{code:'WEB_FETCH_ERROR'}});expect(state.hits).toBe(1);
  const ctx=context(),abort=new AbortController();ctx.signal=abort.signal;
  const pending=fetchPage('/slow',ctx);setTimeout(()=>abort.abort(),30);await expect(pending).rejects.toThrow();
});
