import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

const roots: string[] = [];
const children: ChildProcess[] = [];
const ownedPids: number[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const pid of ownedPids.splice(0)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* Already reaped. */ } }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Compile the actual manager into an isolated runner: signals must never be
// sent to the Vitest process, and testing does not depend on stale dist output.
async function runner(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codingx-process-shutdown-'));
  roots.push(root);
  for (const [source, destination] of [
    ['src/exec/process-manager.ts', 'manager.mjs'], ['src/util/errors.ts', 'errors.mjs'],
    ['src/exec/terminal-filter.ts', 'terminal-filter.mjs'], ['src/util/redact.ts', 'redact.mjs'],
  ]) {
    const text = (await readFile(source!, 'utf8')).replace('../util/errors.js', './errors.mjs').replace('./terminal-filter.js', './terminal-filter.mjs').replace('../util/redact.js', './redact.mjs');
    const compiled = transpileModule(text, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } });
    await writeFile(path.join(root, destination!), compiled.outputText);
  }
  const file = path.join(root, 'runner.mjs');
  await writeFile(file, `import { ProcessManager } from './manager.mjs';
    const pm = new ProcessManager({ killGraceMs: 50 });
    const child = await pm.start({ command: 'sleep 60', cwd: process.cwd(), env: { PATH: '/usr/bin:/bin' } });
    console.log(child.pid);
    process.stdin.on('data', () => process.exit(0));`);
  return file;
}

describe('process owner termination', () => {
  it.each(['SIGTERM', 'exit'] as const)('reaps detached groups on %s', async (mode) => {
    const child = spawn(process.execPath, [await runner()], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    await expect.poll(() => output, { timeout: 3000 }).toMatch(/^\d+\n/);
    const pid = Number(output.trim());
    ownedPids.push(pid);
    if (mode === 'exit') child.stdin.end('exit');
    else child.kill('SIGTERM');
    await ended;
    await expect.poll(() => { try { process.kill(-pid, 0); return true; } catch { return false; } }).toBe(false);
  });
});
