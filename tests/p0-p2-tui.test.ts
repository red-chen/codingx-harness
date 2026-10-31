import { expect,it } from 'vitest';
import { TuiApp,type CellBuffer } from '../src/tui/index.js';
import type { KeyEvent } from '../src/tui/terminal/input.js';
const key=(code:string,text?:string):KeyEvent=>({type:'key',code,text,mods:{ctrl:false,alt:false,shift:false,meta:false}});
const text=(frame:CellBuffer)=>Array.from({length:frame.height},(_,y)=>Array.from({length:frame.width},(_,x)=>frame.get(x,y)?.symbol??' ').join('')).join('\n');
it.each([[80,24],[120,40]])('smokes file and session pickers at %ix%i', (width,height)=>{
  const app=new TuiApp({session:{sessionId:'s',cwd:'/work',model:'fake'},version:'test',width,height});
  app.restoreDraft('keep this draft');expect(app.handleKey(key('@','@'))).toEqual({type:'files'});
  app.openPicker('file',[{value:'中文 space.ts',label:'中文 space.ts',detail:'range supported'},{value:'other',label:'other',detail:''}]);
  for(const c of '中文:2:20')app.handleKey(key(c,c));
  expect(text(app.frame())).toContain('中文 space.ts');
  expect(app.handleKey(key('enter'))).toEqual({type:'pick',purpose:'file',value:'中文 space.ts',range:'2:20'});
  expect(app.composer.text).toBe('keep this draft');
  app.openPicker('session',[{value:'id1',label:'one id1 idle updated',detail:'recent message'},{value:'id2',label:'two id2 running',detail:'busy',disabled:true}]);
  expect(text(app.frame())).toContain('recent message');app.handleKey(key('down'));expect(app.handleKey(key('enter'))).toBeUndefined();
  app.handleKey(key('escape'));expect(app.mode).toBe('main');expect(app.composer.text).toBe('keep this draft');
});
