import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, symlink, unlink, rename, chmod, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EmbeddedSessionStore } from '../src/session/embedded-store.js';
import type { SessionHandle } from '../src/session/types.js';
import { FileChanges } from '../src/session/changes.js';
import { ReadFileTracker, ToolRegistry, createBuiltinTools, type ToolContext } from '../src/tools/index.js';
import { rebuildHistory, restoreReadTracker } from '../src/agent/history.js';
import { Attachments, hydrateImages, attachmentBlocks } from '../src/agent/attachments.js';
import { acquireResumable, restoreSessionHistory, sessionEntries } from '../src/cli/session-switch.js';
import { MAX_OBJECT_BYTES } from '../src/session/objects.js';

let cwd: string, session: SessionHandle, store: EmbeddedSessionStore, ctx: ToolContext, changes: FileChanges;
const registry = new ToolRegistry(createBuiltinTools());
beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'p0-p2-'));
  store = new EmbeddedSessionStore({ directory: path.join(cwd,'sessions') });
  session = await store.createSession({ cwd, model: 'fake', cliVersion: 'test' });
  const tracker = new ReadFileTracker();
  changes = new FileChanges(session, cwd, tracker);
  ctx = { cwd, readTracker: tracker, signal: new AbortController().signal, maxOutputChars: 30000, shell: { env: {}, timeoutMs: 1000 }, fileChanges: changes.forTurn('turn-1') };
});
afterEach(async () => { await session.close(); await rm(cwd,{recursive:true,force:true}); });
const call = (name: string, input: unknown) => registry.execute(name,input,ctx);
const write = (name: string, text: string) => writeFile(path.join(cwd,name),text);
const read = (name: string) => call('Read',{path:name,limit:1});
it.each(['same-size','replace','delete','symlink','symlink-same'])('rejects %s changes after a partial read',async kind => {
  await write('a','a\nb\n'); await write('b','z\ny\n');
  if (kind.startsWith('symlink')) await symlink('a',path.join(cwd,'alias'));
  const target = kind.startsWith('symlink') ? 'alias' : 'a';
  await read(target);
  if (kind==='same-size') await write('a','a\nc\n');
  if (kind==='replace') { await write('temp','a\nb\n'); await rename(path.join(cwd,'temp'),path.join(cwd,'a')); }
  if (kind==='delete') await unlink(path.join(cwd,'a'));
  if (kind.startsWith('symlink')) { await unlink(path.join(cwd,'alias')); await symlink(kind==='symlink-same'?'a':'b',path.join(cwd,'alias')); }
  const result=await call('Write',{path:target,content:'overwritten'});
  expect(result).toMatchObject({isError:true,meta:{code:'FILE_CHANGED'}});
  expect(await readFile(path.join(cwd,'b'),'utf8')).toBe('z\ny\n');
});
it('validates every patch target before writing any and preserves permissions',async()=>{
  await write('a','old\n'); await write('b','old\n'); await chmod(path.join(cwd,'a'),0o751);
  await read('a'); await read('b'); await write('b','new\n');
  const patch=['a','b'].map(name=>`--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+edited\n`).join('');
  expect(await call('ApplyPatch',{patch})).toMatchObject({isError:true,meta:{code:'FILE_CHANGED'}});
  expect(await readFile(path.join(cwd,'a'),'utf8')).toBe('old\n');
  await read('b');
  expect((await call('Edit',{path:'a',old_string:'old',new_string:'edited'})).isError).toBeUndefined();
  expect((await stat(path.join(cwd,'a'))).mode & 0o777).toBe(0o751);
});
it('aggregates edits and restores pre-existing user changes, with an audit trail',async()=>{
  await write('a','user work\n'); await read('a');
  await call('Edit',{path:'a',old_string:'user work',new_string:'agent 1'});
  await call('Edit',{path:'a',old_string:'agent 1',new_string:'agent 2'});
  expect((await changes.list())).toHaveLength(1);
  expect(await changes.command('/undo turn-1')).toContain('Confirm:');
  expect(await changes.command('/undo turn-1 --confirm')).toContain('Undid 1');
  expect(await readFile(path.join(cwd,'a'),'utf8')).toBe('user work\n');
  expect(await changes.list()).toHaveLength(0);
  expect(JSON.stringify(rebuildHistory(await session.replay()).messages)).toContain('User undid');
});
it('refuses undo after an external change and never accepts an unpreviewed confirmation',async()=>{
  await call('Write',{path:'a',content:'agent'});
  await expect(changes.command('/undo turn-1 --confirm')).rejects.toMatchObject({code:'UNDO_CONFLICT'});
  await changes.command('/undo turn-1'); await write('a','human');
  await expect(changes.command('/undo turn-1 --confirm')).rejects.toMatchObject({code:'UNDO_CONFLICT'});
  expect(await readFile(path.join(cwd,'a'),'utf8')).toBe('human');
});
it('undo deletes created files and restores deleted files',async()=>{
  await call('Write',{path:'new file',content:'created'});
  await changes.command('/undo turn-1 new file'); await changes.command('/undo turn-1 new file --confirm');
  await expect(stat(path.join(cwd,'new file'))).rejects.toMatchObject({code:'ENOENT'});
  await write('a','original\n'); await read('a');
  ctx.fileChanges=changes.forTurn('turn-2');
  expect((await call('ApplyPatch',{patch:'--- a/a\n+++ /dev/null\n@@ -1 +0,0 @@\n-original\n'})).isError).toBeUndefined();
  await changes.command('/undo turn-2'); await changes.command('/undo turn-2 --confirm');
  expect(await readFile(path.join(cwd,'a'),'utf8')).toBe('original\n');
});
it('stops mutations if object storage fails and does not trust legacy read events',async()=>{
  await write('a','original');
  const events=await session.append([{type:'assistant.message',calls:[{id:'c',name:'Read',input:{path:'a'}}]},{type:'tool.result',callId:'c',name:'Read',content:'original'}]);
  expect(await restoreReadTracker(rebuildHistory(events),cwd,ctx.readTracker)).toBe(0);
  expect((await call('Edit',{path:'a',old_string:'original',new_string:'bad'})).isError).toBe(true);
  await read('a');
  session.putObject=async()=>{throw new Error('disk full');};
  expect((await call('Write',{path:'a',content:'bad'})).isError).toBe(true);
  expect(await readFile(path.join(cwd,'a'),'utf8')).toBe('original');
});
it('bounds, verifies and retains binary objects through fork and deletion',async()=>{
  const bytes=Buffer.alloc(700000,117); const ref=await session.putObject!(bytes);
  await session.append({type:'test.object',object:ref});
  expect(await session.getObject!(ref)).toEqual(bytes);
  await expect(session.putObject!(Buffer.alloc(MAX_OBJECT_BYTES+1))).rejects.toMatchObject({code:'OBJECT_ERROR'});
  const id=session.id; await session.close();
  const fork=await store.forkSession(id,{cliVersion:'test'});
  try { await store.deleteSession(id); expect(await fork.getObject!(ref)).toEqual(bytes); }
  finally { await fork.close(); }
});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZ8AAAAASUVORK5CYII=','base64');
it('reads Chinese/space file ranges with budgets and preserves drafts on failure',async()=>{
  const attachments=new Attachments(session);
  await write('中文 file.txt',Array.from({length:250},(_,i)=>String(i+1)).join('\n'));
  attachments.add('"中文 file.txt" 3:240');
  const result=await attachments.prepare(ctx);
  expect(result[0]).toMatchObject({type:'file',start:3,end:202,truncated:true});
  expect(ctx.readTracker.size).toBeGreaterThan(0);
  attachments.add('missing');
  await expect(attachments.prepare(ctx)).rejects.toThrow(); expect(attachments.count).toBe(2);
});
it('replays image snapshots after original deletion and validates signatures/count',async()=>{
  await writeFile(path.join(cwd,'photo.png'),png);
  const attachments=new Attachments(session); attachments.add('photo.png');
  const stored=await attachments.prepare(ctx);
  await session.append({type:'user.message',text:'see this',attachments:stored});
  await unlink(path.join(cwd,'photo.png'));
  const messages=rebuildHistory(await session.replay()).messages;
  expect(JSON.stringify(messages)).not.toContain(png.toString('base64'));
  const loaded=await hydrateImages(messages,session);
  expect(loaded[0]?.content[1]).toMatchObject({type:'image',data:png.toString('base64')});
  await write('fake.png','not an image'); const invalid=new Attachments(session); invalid.add('fake.png');
  await expect(invalid.prepare(ctx)).rejects.toMatchObject({code:'ATTACHMENT_ERROR'});
  await writeFile(path.join(cwd,'photo.png'),png); const many=new Attachments(session);
  for(let i=0;i<5;i++)many.add('photo.png');
  await expect(many.prepare(ctx)).rejects.toMatchObject({code:'ATTACHMENT_ERROR'});
  const image=stored[0]!; if(image.type!=='image')throw new Error('image');
  await unlink(path.join(session.filePath+'.objects',image.object.chunks[0]!));
  await expect(restoreSessionHistory(session)).rejects.toThrow();
});
it('session switch takes a lease first and rejects busy/ended sessions without losing current',async()=>{
  const target=await store.createSession({cwd,model:'fake',cliVersion:'test'});
  await target.append({type:'user.message',text:'searchable title'});
  await expect(acquireResumable(store,cwd,target.id)).rejects.toMatchObject({code:'SESSION_BUSY'});
  await session.append({type:'test.current',text:'still usable'});
  await target.close();
  const opened=await acquireResumable(store,cwd,target.id);
  expect((await sessionEntries(store,cwd)).find(e=>e.value===target.id)?.label).toContain('searchable title');
  await opened.end(); await opened.close();
  await expect(acquireResumable(store,cwd,target.id)).rejects.toThrow(/fork/);
});

it('recovers a durable checkpoint when the final audit append fails after replacement',async()=>{
  await write('a','before');await read('a');
  const append=session.append.bind(session);let fail=true;
  session.append=async events=>{
    if(fail && !Array.isArray(events) && events.type==='file.change')throw new Error('disk full');
    return append(events);
  };
  expect(await call('Write',{path:'a',content:'after'})).toMatchObject({isError:true,meta:{code:'OBJECT_ERROR'}});
  fail=false;expect(await changes.command('/changes')).toContain('turn-1');
  await changes.command('/undo turn-1');await changes.command('/undo turn-1 --confirm');
  expect(await readFile(path.join(cwd,'a'),'utf8')).toBe('before');
});
