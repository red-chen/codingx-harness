// Real macOS PTY + headless VT smoke, entirely against a local fake Provider.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn as spawnPipe } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node-pty';
import xterm from '@xterm/headless';
const cli = fileURLToPath(new URL('../bin/codingx.js', import.meta.url));
const sse = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n';
const reply = sse('message_start', { message: { id:'smoke', role:'assistant', model:'fake', content:[], usage:{ input_tokens:1, output_tokens:0 } } }) +
  sse('content_block_start',{index:0,content_block:{type:'text',text:''}}) + sse('content_block_delta',{index:0,delta:{type:'text_delta',text:'Smoke response ready'}}) +
  sse('content_block_stop',{index:0}) + sse('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:3}}) + sse('message_stop',{});
const requests=[];
const server=createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{requests.push(JSON.parse(Buffer.concat(chunks).toString()));res.writeHead(200,{'content-type':'text/event-stream'});res.end(reply);});});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const root=await mkdtemp(path.join(os.tmpdir(),'codingx-p0-p2-smoke-'));
const wait=async (test,label)=>{const deadline=Date.now()+10000;while(Date.now()<deadline){if(test())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Timed out: '+label);};
try {
  for(const [cols,rows] of [[80,24],[120,40]]) {
    const home=path.join(root,cols+'-home'),cwd=path.join(root,cols+'-repo');await mkdir(home);await mkdir(cwd);
    await writeFile(path.join(home,'config.toml'),`[provider.primary]\nendpoint="http://127.0.0.1:${server.address().port}"\napi_key_env="SMOKE_KEY"\n[model]\nroute="default"\n[routes.default]\nmax_attempts=1\n[[routes.default.targets]]\nprovider="primary"\nmodel="fake"\n[sessiond]\nenabled=false\n`);
    await writeFile(path.join(cwd,'中文 file.ts'),'const answer = 42;\n');
    const env={PATH:process.env.PATH,HOME:root,CODINGX_HOME:home,SMOKE_KEY:'local-fake-key',TERM:'xterm-256color',LANG:'en_US.UTF-8'};
    const seed=spawnPipe(process.execPath,[cli,'--plain','-C',cwd],{env,stdio:['pipe','pipe','pipe']});
    seed.stdout.resume();let seedError='';seed.stderr.on('data',c=>seedError+=c);
    seed.stdin.end('prior prompt\n/quit\n');assert.equal(await new Promise(resolve=>seed.on('exit',resolve)),0,seedError);
    const term=new xterm.Terminal({cols,rows,allowProposedApi:true});
    const pty=spawn(process.execPath,[cli,'--tui','-C',cwd],{cwd,env,cols,rows,name:'xterm-256color'});
    let ended=false,code;
    pty.onExit(event=>{ended=true;code=event.exitCode;});pty.onData(data=>term.write(data));
    const screen=()=>Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i)?.translateToString(true)??'').join('\n');
    try {
      await wait(()=>screen().includes('Ask codingx'), 'welcome');
      pty.write('@');await wait(()=>screen().includes('Attach file'), 'file picker');
      pty.write('中文:1:1');await wait(()=>screen().includes('中文 file.ts'),'Chinese search');pty.write('\r');
      await wait(()=>screen().includes('Attached 中文'),'attachment');
      const before=requests.length;pty.write('你好 smoke\r');
      await wait(()=>requests.length>before && screen().includes('Smoke response ready'),'provider answer');
      assert.ok(JSON.stringify(requests.at(-1).messages).includes('const answer = 42;'));
      // Resize before session selection and verify the selected prior conversation is used.
      const newCols=cols===80?120:80,newRows=rows===24?40:24;term.resize(newCols,newRows);pty.resize(newCols,newRows);
      const oldSession=/session: ([0-9a-z-]+)/.exec(screen())?.[1];
      pty.write('/resume\r');await wait(()=>screen().includes('Resume session'),'session picker');
      pty.write('prior prompt');await wait(()=>screen().includes('prior prompt'),'session search');pty.write('\r');
      await wait(()=>screen().includes('prior prompt') && /session: ([0-9a-z-]+)/.exec(screen())?.[1] !== oldSession && !screen().includes('Resume session'),'session switch');
      const next=requests.length;pty.write('after switch\r');await wait(()=>requests.length>next,'resumed request');
      assert.ok(JSON.stringify(requests.at(-1).messages).includes('prior prompt'));
      assert.ok(!JSON.stringify(requests.at(-1).messages).includes('你好 smoke'));
      await wait(()=>screen().includes('Smoke response ready'),'resumed answer');
      pty.write('/quit\r');await wait(()=>ended,'exit');assert.equal(code,0);
      const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZ8AAAAASUVORK5CYII=','base64');
      await writeFile(path.join(cwd,'image.png'),png);
      const imageChild=spawnPipe(process.execPath,[cli,'-C',cwd,'exec','--image','image.png','describe'],{env,stdio:['ignore','pipe','pipe']});
      imageChild.stdout.resume();let imageError='';imageChild.stderr.on('data',c=>imageError+=c);
      assert.equal(await new Promise(resolve=>imageChild.on('exit',resolve)),0,imageError);
      const image=requests.at(-1).messages.flatMap(message=>message.content).find(block=>block.type==='image');
      assert.equal(image.source.data,png.toString('base64'));
      console.log(`${cols}x${rows}: @ file/range, CJK, provider send, resize, /resume, history, exit, exec --image PASS`);
    } catch(error) { console.error(screen());throw error; }
    finally { if(!ended)pty.kill('SIGKILL');term.dispose(); }
  }
} finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true}); }
