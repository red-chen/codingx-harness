/** Exercise both built entry points, a custom script, and graceful shutdown. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(os.tmpdir(), 'codingx-mock-smoke-'));
const env = {
  PATH: process.env.PATH ?? '', HOME: root, TMPDIR: os.tmpdir(),
  LANG: 'en_US.UTF-8', TERM: 'dumb',
};
const server = spawn(process.execPath, [
  path.join(repo, 'dist/mock-llm.js'), '--port', '0', '--init', path.join(root, 'playground'),
  '--scenario-file', path.join(repo, 'docs/mock-llm-example.json'),
], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = once(server, 'exit');
// Attach a handler immediately to avoid an unhandled spawn error.
void exited.catch(() => undefined);
let stdout = '';
let stderr = '';
server.stderr.on('data', chunk => { stderr += chunk; });

try {
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Mock startup timeout: ' + stderr)), 10_000);
    const cleanup = () => { clearTimeout(timer); server.off('error', fail); server.off('exit', earlyExit); server.stdout.off('data', data); };
    const fail = error => { cleanup(); reject(error); };
    const earlyExit = () => fail(new Error('Mock exited during startup: ' + stderr));
    const data = chunk => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      try { const value = JSON.parse(stdout.slice(0, newline)); cleanup(); resolve(value); }
      catch (error) { fail(error); }
    };
    server.once('error', fail); server.once('exit', earlyExit); server.stdout.on('data', data);
  });
  assert.equal(ready.event, 'mock.ready');
  assert.equal((await fetch(ready.endpoint + '/health')).status, 200);
  const { home, workspace } = ready.playground;
  const run = async (prompt, flags = [], execFlags = []) => promisify(execFile)(process.execPath, [
    path.join(repo, 'bin/codingx.js'), '-C', workspace, ...flags, 'exec', ...execFlags, prompt,
  ], { cwd: repo, env: { ...env, CODINGX_HOME: home, MOCK_LLM_API_KEY: 'mock-local-only' }, timeout: 30_000 });
  assert.match((await run('[mock:files]')).stdout, /MOCK PASS: files/);
  assert.equal(await readFile(path.join(workspace, 'mock-output/hello.txt'), 'utf8'), 'hello codingx\nverified\n');
  assert.match((await run('[mock:custom-smoke]')).stdout, /MOCK PASS: custom-smoke/);
  assert.match((await run('[mock:permission]', ['--sandbox', 'read-only', '--ask-for-approval', 'never'])).stdout, /MOCK PASS: permission/);
  assert.match((await run('[mock:image]', [], ['--image', 'image.png'])).stdout, /MOCK PASS: image/);
  const stats = await fetch(ready.endpoint + '/stats').then(response => response.json());
  assert.ok(stats.recent.some(record => record.scenario === 'custom-smoke' && record.step === 1));
  assert.ok(stats.recent.some(record => record.images === 1));
  server.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
  console.log('Built Mock + codingx: files, custom scenario, read-only policy, image, stats and SIGTERM PASS');
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    await exited.catch(() => undefined);
  }
  await rm(root, { recursive: true, force: true });
}
