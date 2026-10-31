import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { existsSync } from 'node:fs';
import { ExecError } from '../util/errors.js';
import type { ExecRequest, ExecResult } from './types.js';

const FORCE_KILL_DELAY_MS = 5_000;
const HEAD_RATIO = 0.25;

class BoundedCapture {
  private total = 0;
  private head = '';
  private tail = '';
  private readonly headLimit: number;
  private readonly tailLimit: number;

  constructor(private readonly limit: number) {
    this.headLimit = Math.max(64, Math.floor(limit * HEAD_RATIO));
    this.tailLimit = Math.max(64, limit - this.headLimit);
  }

  push(text: string): void {
    this.total += text.length;
    if (this.head.length < this.headLimit) {
      const add = text.slice(0, this.headLimit - this.head.length);
      this.head += add;
      if (add.length < text.length) this.tail = (this.tail + text.slice(add.length)).slice(-this.tailLimit);
    } else {
      this.tail = (this.tail + text).slice(-this.tailLimit);
    }
  }

  get truncated(): boolean {
    return this.total > this.headLimit + this.tailLimit;
  }

  get length(): number {
    return this.total;
  }

  text(): string {
    if (!this.truncated) return this.head + this.tail;
    const omitted = Math.max(0, this.total - this.head.length - this.tail.length);
    return this.head + '\n[... ' + omitted + ' characters omitted ...]\n' + this.tail;
  }
}

function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  const shell = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
  return { file: shell, args: ['-lc', command] };
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may already be gone.
  }
}

function validateRequest(request: ExecRequest): void {
  if (request.command.trim().length === 0) throw new ExecError('Command must not be empty.');
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new ExecError('timeoutMs must be a positive number.');
  }
  if (!Number.isInteger(request.maxOutputChars) || request.maxOutputChars <= 0) {
    throw new ExecError('maxOutputChars must be a positive integer.');
  }
}

/** Run a shell command in its own process group with bounded output. */
export async function runShellCommand(request: ExecRequest): Promise<ExecResult> {
  validateRequest(request);
  const startedAt = Date.now();

  if (request.signal?.aborted) {
    return Promise.resolve({
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: true,
      durationMs: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutChars: 0,
      stderrChars: 0,
    });
  }

  const { file, args } = request.invocation ?? shellInvocation(request.command);
  const stdout = new BoundedCapture(request.maxOutputChars);
  const stderr = new BoundedCapture(request.maxOutputChars);
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');

  return new Promise<ExecResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: request.cwd,
        env: request.env,
        detached: process.platform !== 'win32',
        stdio: [request.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new ExecError('Failed to spawn shell: ' + (error instanceof Error ? error.message : String(error)), { cause: error }));
      return;
    }

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      request.signal?.removeEventListener('abort', onAbort);
    };

    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        error instanceof ExecError
          ? error
          : new ExecError('Command execution failed: ' + (error instanceof Error ? error.message : String(error)), {
              cause: error,
            }),
      );
    };

    const requestKill = (): void => {
      terminate(child, 'SIGTERM');
      if (!forceTimer) {
        forceTimer = setTimeout(() => terminate(child, 'SIGKILL'), FORCE_KILL_DELAY_MS);
        forceTimer.unref();
      }
    };

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      requestKill();
    };

    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      requestKill();
    }, request.timeoutMs);

    request.signal?.addEventListener('abort', onAbort, { once: true });

    if (request.stdin !== undefined) {
      child.stdin?.on('error', () => {
        // The hook/tool may exit before consuming stdin; that is not a spawn failure.
      });
      child.stdin?.end(request.stdin);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.push(stdoutDecoder.write(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(stderrDecoder.write(chunk));
    });

    child.on('error', (error) => {
      fail(new ExecError('Failed to start command: ' + error.message, { cause: error }));
    });

    child.on('close', (code, signal) => {
      if (request.cleanupProcessGroup) terminate(child, 'SIGKILL');
      stdout.push(stdoutDecoder.end());
      stderr.push(stderrDecoder.end());
      finish({
        exitCode: code,
        signal: signal ?? null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdoutChars: stdout.length,
        stderrChars: stderr.length,
      });
    });
  });
}
