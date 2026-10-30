import { afterEach, describe, expect, it } from 'vitest';
import { ProcessManager, buildChildEnv } from '../src/exec/index.js';
import type { ManagedProcess, ProcessStartRequest } from '../src/exec/types.js';

const managers: ProcessManager[] = [];
function manager(options: ConstructorParameters<typeof ProcessManager>[0] = {}): ProcessManager {
  const value = new ProcessManager({ killGraceMs: 80, ...options });
  managers.push(value);
  return value;
}
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
function node(code: string): ProcessStartRequest {
  return {
    command: quote(process.execPath) + ' -e ' + quote(code), cwd: process.cwd(),
    env: buildChildEnv(['PATH', 'HOME'], process.env),
  };
}
async function outputContaining(pm: ProcessManager, id: string, pattern: RegExp): Promise<string> {
  let output = '';
  await expect.poll(async () => {
    output = (await pm.read(id)).output;
    return output;
  }).toMatch(pattern);
  return output;
}
afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((pm) => pm.close()));
});

describe('ProcessManager', () => {
  it('serves HTTP across calls and survives abortion of the initiating turn', async () => {
    const states: ManagedProcess[] = [];
    const pm = manager({ onState: async (state) => { states.push(state); } });
    const controller = new AbortController();
    const started = await pm.start({ ...node(`const http = require('node:http');
      const server = http.createServer((req,res) => res.end('hello'));
      server.listen(0, '127.0.0.1', () => console.log('PORT:' + server.address().port));`), signal: controller.signal });
    expect(started.state).toBe('running');
    controller.abort();
    const output = await outputContaining(pm, started.processId, /PORT:\d+/);
    const port = /PORT:(\d+)/.exec(output)![1];
    expect(await (await fetch('http://127.0.0.1:' + port)).text()).toBe('hello');
    expect(pm.list()[0]?.state).toBe('running');
    const stopped = await pm.stop(started.processId);
    expect(stopped).toMatchObject({ state: 'exited', stopReason: 'requested' });
    await expect(fetch('http://127.0.0.1:' + port)).rejects.toThrow();
    expect(await pm.stop(started.processId)).toEqual(stopped);
    expect(states.map((state) => state.state)).toEqual(['starting', 'running', 'stopping', 'exited']);
    expect(JSON.stringify(states)).not.toContain('env');
  });

  it('returns non-zero exits, bounded UTF-8 output and incremental cursors', async () => {
    const pm = manager({ maxOutputChars: 100 });
    const started = await pm.start(node(`process.stdout.write('你'.repeat(500)); process.stderr.write('tail'); process.exitCode = 7;`));
    const first = await pm.read(started.processId, 0, 25, 3000);
    expect(first.process).toMatchObject({ state: 'exited', exitCode: 7 });
    expect(first.truncated).toBe(true);
    expect(first.output.length).toBe(25);
    expect(first.output).not.toContain('�');
    const next = await pm.read(started.processId, first.nextCursor, 100);
    expect(next.truncated).toBe(false);
    expect(first.output.length + next.output.length).toBe(100);
    expect((await pm.read(started.processId, next.nextCursor)).output).toBe('');
    await expect(pm.read(started.processId, next.nextCursor + 1)).rejects.toMatchObject({ code: 'TOOL_ERROR' });
  });

  it('represents spawn failure, and never treats old or arbitrary PIDs as handles', async () => {
    const pm = manager();
    const failed = await pm.start({ ...node(''), invocation: { file: '/missing-codingx-executable', args: [] } });
    expect(failed).toMatchObject({ state: 'failed', exitCode: null });
    await expect(pm.stop(String(process.pid))).rejects.toMatchObject({ code: 'PROCESS_NOT_FOUND' });
    await expect(manager().read(failed.processId)).rejects.toMatchObject({ code: 'PROCESS_NOT_FOUND' });
  });

  it('bounds active processes and clears all handles before allowing new starts', async () => {
    const pm = manager({ maxProcesses: 1, maxRecords: 1 });
    const running = await pm.start(node('setInterval(() => {}, 1000)'));
    await expect(pm.start(node(''))).rejects.toMatchObject({ code: 'PROCESS_LIMIT' });
    await pm.clear();
    expect(pm.list()).toEqual([]);
    await expect(pm.read(running.processId)).rejects.toMatchObject({ code: 'PROCESS_NOT_FOUND' });
    await pm.start(node(''));
    await pm.close();
    await expect(pm.start(node(''))).rejects.toMatchObject({ code: 'PROCESS_UNAVAILABLE' });
  });

  it('cancels a wait without stopping a running process and rejects aborted starts', async () => {
    const pm = manager();
    const running = await pm.start(node('setInterval(() => {}, 1000)'));
    const controller = new AbortController();
    const waiting = pm.read(running.processId, 0, 100, 30_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'ABORTED' });
    expect(pm.list()[0]?.state).toBe('running');
    await expect(pm.start({ ...node(''), signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(pm.list()).toHaveLength(1);
  });

  it('escalates TERM to KILL and cleans descendants even when their leader exits', async () => {
    const pm = manager();
    const stubborn = await pm.start(node(`process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);`));
    await outputContaining(pm, stubborn.processId, /ready/);
    expect((await pm.stop(stubborn.processId)).signal).toBe('SIGKILL');
    const parent = await pm.start(node(`const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('childready'); setInterval(() => {}, 1000)"], { stdio: ['ignore','pipe','ignore'] });
      child.stdout.once('data', () => { console.log('CHILD:' + child.pid); process.exit(0); });`));
    const completed = await pm.read(parent.processId, 0, 1000, 3000);
    expect(completed.process.state).toBe('exited');
    const childPid = Number(/CHILD:(\d+)/.exec(completed.output)![1]);
    await expect.poll(() => { try { process.kill(childPid, 0); return true; } catch { return false; } }).toBe(false);
  });

  it('reports persistence failure while still killing owned processes', async () => {
    const pm = manager({ onState: async (state) => { if (state.state === 'running') throw new Error('disk failed'); } });
    await expect(pm.start(node('setInterval(() => {}, 1000)'))).rejects.toThrow('disk failed');
    expect(pm.list()[0]?.state).toBe('exited');
    await expect(pm.close()).rejects.toThrow('disk failed');
  });
});
