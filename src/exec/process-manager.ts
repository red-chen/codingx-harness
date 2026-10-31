import type { IPty } from 'node-pty';
import { TerminalFilter } from './terminal-filter.js';
import { redactProcessOutput, redactString } from '../util/redact.js';
import type { ProcessWriteRequest } from './types.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { abortError, CodingxError } from '../util/errors.js';
import type {
  ManagedProcess, ProcessManagerOptions, ProcessOutput, ProcessStartRequest, ProcessStopReason,
} from './types.js';

interface Entry {
  cleanup?: () => Promise<void>;
  networkDenials?: readonly string[];
  info: ManagedProcess;
  child?: ChildProcess;
  pty?: IPty;
  stdinClosed?: boolean;
  output: string;
  total: number;
  done: Promise<void>;
  resolve: () => void;
  waiters: Set<() => void>;
  finishing?: Promise<void>;
  stopTimer?: NodeJS.Timeout;
}

const terminal = (entry: Entry): boolean => entry.info.state === 'exited' || entry.info.state === 'failed';

/** CLI-owned processes. Rollout snapshots are audit records, never live handles. */
export class ProcessManager {
  private readonly entries = new Map<string, Entry>();
  private readonly maxProcesses: number;
  private readonly maxRecords: number;
  private readonly maxOutputChars: number;
  private readonly killGraceMs: number;
  private events: Promise<void> = Promise.resolve();
  private eventError: unknown;
  private closed = false;
  private resetting = false;
  private watchingExit = false;
  private watchingTerm = false;
  private readonly onExit = (): void => {
    for (const entry of this.entries.values()) this.signal(entry, 'SIGKILL');
  };
  private readonly onTerm = (): void => {
    // TUI supplies its own signal handler. Plain/exec use this fallback so
    // normal SIGTERM cannot leave detached groups behind.
    void this.close().catch(() => {}).finally(() => { process.kill(process.pid, 'SIGTERM'); });
  };

  constructor(private readonly options: ProcessManagerOptions = {}) {
    this.maxProcesses = options.maxProcesses ?? 32;
    this.maxRecords = options.maxRecords ?? 100;
    this.maxOutputChars = options.maxOutputChars ?? 65_536;
    this.killGraceMs = options.killGraceMs ?? 1_000;
    for (const value of [this.maxProcesses, this.maxRecords, this.maxOutputChars, this.killGraceMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new CodingxError('TOOL_ERROR', 'Invalid process manager limit.');
    }
    if (this.maxRecords < this.maxProcesses) throw new CodingxError('TOOL_ERROR', 'maxRecords must cover maxProcesses.');
  }

  private record(entry: Entry): void {
    const snapshot = { ...entry.info };
    this.events = this.events.then(async () => {
      await this.options.onState?.(snapshot);
    }).catch((error: unknown) => { this.eventError ??= error; });
  }

  async flush(): Promise<void> {
    await this.events;
    if (this.eventError !== undefined) throw this.eventError;
  }

  private require(processId: string): Entry {
    const entry = this.entries.get(processId);
    if (!entry) throw new CodingxError('PROCESS_NOT_FOUND', 'Unknown processId in this CLI session: ' + processId);
    return entry;
  }

  private watchExit(): void {
    if (!this.watchingExit) {
      this.watchingExit = true;
      process.on('exit', this.onExit);
    }
    if (!this.watchingTerm && process.listenerCount('SIGTERM') === 0) {
      this.watchingTerm = true;
      process.once('SIGTERM', this.onTerm);
    }
  }

  private unwatchExit(): void {
    process.off('exit', this.onExit);
    process.off('SIGTERM', this.onTerm);
    this.watchingExit = false;
    this.watchingTerm = false;
  }

  list(): ManagedProcess[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.info }));
  }

  private signal(entry: Entry, signal: NodeJS.Signals): void {
    if (entry.info.pid === undefined || terminal(entry)) return;
    try { process.kill(-entry.info.pid, signal); } catch { /* Group already gone. */ }
  }

  private groupAlive(entry: Entry): boolean {
    if (entry.info.pid === undefined) return false;
    try { process.kill(-entry.info.pid, 0); return true; } catch { return false; }
  }

  private finish(entry: Entry, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (entry.finishing) return entry.finishing;
    entry.finishing = (async () => {
      // A shell can exit while descendants retain pipes, or redirect them away.
      // Reap the owned group on leader exit instead of relying on pipe close.
      this.signal(entry, 'SIGTERM');
      if (this.groupAlive(entry)) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.killGraceMs));
        this.signal(entry, 'SIGKILL');
      }
      if (entry.stopTimer) clearTimeout(entry.stopTimer);
      // Let final pipe data drain. Escaped/daemonized children must not hold cleanup open.
      if (entry.child && !entry.child.stdout?.destroyed) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 50);
          const child = entry.child!;
          function done(): void { clearTimeout(timer); child.off('close', done); resolve(); }
          child.once('close', done);
        });
      }
      entry.child?.stdout?.destroy();
      entry.child?.stderr?.destroy();
      try { await entry.cleanup?.(); } catch (error) { this.eventError ??= error; }
      entry.info.state = entry.info.state === 'failed' ? 'failed' : 'exited';
      entry.info.exitCode = code;
      entry.info.signal = signal;
      entry.info.endedAt = new Date().toISOString();
      this.record(entry);
      entry.resolve();
      for (const waiter of entry.waiters) waiter();
      if ([...this.entries.values()].every(terminal)) this.unwatchExit();
    })();
    return entry.finishing;
  }

  async start(request: ProcessStartRequest): Promise<ManagedProcess> {
    if (this.closed || this.resetting) throw new CodingxError('PROCESS_UNAVAILABLE', 'Process manager is closing or clearing.');
    if (request.signal?.aborted) throw abortError();
    if (typeof request.stdin === 'string' && (Buffer.byteLength(request.stdin) > 65536 || redactString(request.stdin).redacted)) throw new CodingxError('TOOL_ERROR', 'Process input is limited to 64 KiB and cannot contain recognized credentials.');
    for (const size of [request.cols ?? 80, request.rows ?? 24]) if (!Number.isSafeInteger(size) || size < 1 || size > 1000) throw new CodingxError('TOOL_ERROR', 'Invalid terminal dimensions.');
    if (!request.command.trim()) throw new CodingxError('TOOL_ERROR', 'Command must not be empty.');
    if (this.list().filter((entry) => entry.state !== 'exited' && entry.state !== 'failed').length >= this.maxProcesses) {
      throw new CodingxError('PROCESS_LIMIT', 'Too many running processes; stop one before starting another.');
    }
    for (const [id, entry] of this.entries) {
      if (this.entries.size < this.maxRecords) break;
      if (terminal(entry)) this.entries.delete(id);
    }
    let resolve!: () => void;
    const entry: Entry = {
      cleanup: request.cleanup,
      networkDenials: request.networkDenials,
      info: {
        processId: randomUUID(), command: request.command, cwd: request.cwd,
        pty: request.pty ?? false, stdin: request.pty === true || request.stdin !== undefined && request.stdin !== false,
        state: 'starting', startedAt: new Date().toISOString(), exitCode: null, signal: null,
        ...(request.sandbox === undefined ? {} : { sandbox: { ...request.sandbox } }),
      },
      output: '', total: 0, done: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve(), waiters: new Set(),
    };
    this.entries.set(entry.info.processId, entry);
    this.watchExit();
    this.record(entry);
    const filter = new TerminalFilter();
    const append = (text: string): void => {
      text = filter.push(text);
      entry.total += text.length;
      entry.output = (entry.output + text).slice(-this.maxOutputChars);
    };
    const onAbort = (): void => { void this.stop(entry.info.processId, 'aborted').catch(() => {}); };
    try {
      // Persist ownership before spawning, and do not launch after concurrent close/clear.
      await this.flush();
      if (request.signal?.aborted || this.closed || this.resetting || entry.info.state !== 'starting') throw abortError();
      const invocation = request.invocation ?? { file: '/bin/bash', args: ['-lc', request.command] };
      if (request.pty) {
        let ptyModule: typeof import('node-pty');
        try { ptyModule = await import('node-pty'); }
        catch (error) { throw new CodingxError('PROCESS_UNAVAILABLE', 'PTY native module could not load; reinstall node-pty for this Node/macOS version.', { cause: error }); }
        if (request.signal?.aborted || this.closed || this.resetting) throw abortError();
        let pty: IPty;
        try { pty = ptyModule.spawn(invocation.file, invocation.args, { cwd: request.cwd, env: request.env, name: 'xterm-256color', cols: request.cols ?? 80, rows: request.rows ?? 24 }); }
        catch (error) { throw new CodingxError('PROCESS_UNAVAILABLE', 'PTY launch failed. Check node-pty native module and spawn-helper executable permissions: ' + String(error), { cause: error }); }
        entry.pty = pty; entry.info.pid = pty.pid;
        pty.onData(append);
        pty.onExit(event => { void this.finish(entry, event.exitCode, event.signal ? 'SIGTERM' : null); });
        request.signal?.addEventListener('abort', onAbort, { once: true });
      } else {
      const child = spawn(invocation.file, invocation.args, {
        cwd: request.cwd, env: request.env, detached: true, stdio: [request.stdin === undefined || request.stdin === false ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      entry.child = child;
      child.stdin?.on('error', () => { entry.stdinClosed = true; });
      if (child.pid !== undefined) entry.info.pid = child.pid;
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder('utf8');
        stream?.on('data', (chunk: Buffer) => append(decoder.write(chunk)));
        stream?.once('end', () => append(decoder.end()));
      }
      child.once('exit', (code, signal) => { void this.finish(entry, code, signal); });
      request.signal?.addEventListener('abort', onAbort, { once: true });
      await new Promise<void>((resolveSpawn, reject) => {
        child.once('spawn', resolveSpawn);
        child.once('error', reject);
      });
      }
      if (typeof request.stdin === 'string') await this.write(entry.info.processId, { text: request.stdin });
      if (request.signal?.aborted) throw abortError();
      if (entry.info.state === 'starting') {
        entry.info.state = 'running';
        this.record(entry);
      }
      await this.flush();
      if (request.signal?.aborted) throw abortError();
      return { ...entry.info };
    } catch (error) {
      if (terminal(entry)) throw error;
      if (entry.info.pid !== undefined) {
        await this.stop(entry.info.processId, 'aborted').catch(() => {});
        throw error;
      }
      entry.info.state = 'failed';
      entry.info.error = error instanceof Error ? error.message : String(error);
      await this.finish(entry, null, null);
      await this.flush();
      if (request.signal?.aborted) throw abortError();
      return { ...entry.info };
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  async write(processId: string, input: ProcessWriteRequest): Promise<ManagedProcess> {
    const entry = this.require(processId);
    if (terminal(entry) || entry.info.state === 'stopping') throw new CodingxError('PROCESS_UNAVAILABLE', 'Process is not running.');
    const resize = input.cols !== undefined || input.rows !== undefined;
    const count = Number(input.text !== undefined) + Number(input.eof === true) + Number(input.interrupt === true) + Number(resize);
    if (count !== 1) throw new CodingxError('TOOL_ERROR', 'Choose exactly one operation: text, eof, interrupt or resize.');
    const bytes = Buffer.byteLength(input.text ?? '');
    if (bytes > 65536 || redactString(input.text ?? '').redacted) throw new CodingxError('TOOL_ERROR', 'Input is limited to 64 KiB; recognized credentials are rejected.');
    if (resize && (!entry.pty || !Number.isSafeInteger(input.cols) || !Number.isSafeInteger(input.rows) || input.cols! < 1 || input.rows! < 1 || input.cols! > 1000 || input.rows! > 1000)) throw new CodingxError('TOOL_ERROR', 'Resize requires a PTY and dimensions 1–1000.');
    if (!entry.pty && !input.interrupt && (!entry.child?.stdin || entry.stdinClosed)) throw new CodingxError('PROCESS_UNAVAILABLE', 'Process stdin is closed or was not enabled.');
    await this.options.onInput?.({ processId, operation: resize ? 'resize' : input.eof ? 'eof' : input.interrupt ? 'interrupt' : 'text', bytes });
    if (resize) entry.pty!.resize(input.cols!, input.rows!);
    else if (input.interrupt) { if (entry.pty) entry.pty.write('\x03'); else this.signal(entry, 'SIGINT'); }
    else if (input.eof) { if (entry.pty) entry.pty.write('\x04'); else { entry.stdinClosed = true; entry.child!.stdin!.end(); } }
    else if (entry.pty) entry.pty.write(input.text!);
    else await new Promise<void>((resolve, reject) => entry.child!.stdin!.write(input.text!, error => error ? reject(error) : resolve()));
    return { ...entry.info };
  }

  async read(processId: string, cursor = 0, maxChars = 8_000, waitMs = 0, signal?: AbortSignal): Promise<ProcessOutput> {
    const entry = this.require(processId);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > entry.total ||
        !Number.isSafeInteger(maxChars) || maxChars <= 0 || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) {
      throw new CodingxError('TOOL_ERROR', 'Invalid process output cursor, limit or wait duration.');
    }
    if (signal?.aborted) throw abortError();
    if (waitMs > 0 && !terminal(entry)) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); entry.waiters.delete(done); };
        const done = (): void => { cleanup(); resolve(); };
        const abort = (): void => { cleanup(); reject(abortError()); };
        const timer = setTimeout(done, waitMs);
        signal?.addEventListener('abort', abort, { once: true });
        entry.waiters.add(done);
      });
      if (signal?.aborted) throw abortError();
    }
    await this.flush();
    const oldest = entry.total - entry.output.length;
    const start = Math.max(cursor, oldest);
    const rawOutput = redactProcessOutput(entry.output).slice(start - oldest, start - oldest + maxChars);
    const output = redactString(rawOutput).value;
    return { process: { ...entry.info }, output, nextCursor: start + rawOutput.length, truncated: cursor < oldest,
      ...(entry.networkDenials?.length ? { networkDenials: [...entry.networkDenials] } : {}) };
  }

  async stop(processId: string, reason: ProcessStopReason = 'requested'): Promise<ManagedProcess> {
    const entry = this.require(processId);
    if (!terminal(entry) && entry.info.state !== 'stopping') {
      entry.info.state = 'stopping';
      entry.info.stopReason = reason;
      this.record(entry);
      this.signal(entry, 'SIGTERM');
      if (entry.info.pid === undefined) {
        await this.finish(entry, null, null);
      } else {
        entry.stopTimer = setTimeout(() => this.signal(entry, 'SIGKILL'), this.killGraceMs);
      }
    }
    await entry.done;
    await this.flush();
    return { ...entry.info };
  }

  async clear(): Promise<void> {
    this.resetting = true;
    try {
      await this.stopAll('session_cleared');
      this.entries.clear();
    } finally { this.resetting = false; }
  }

  async close(): Promise<void> {
    this.closed = true;
    try { await this.stopAll('session_closed'); } finally { this.unwatchExit(); }
  }

  private async stopAll(reason: ProcessStopReason): Promise<void> {
    const results = await Promise.allSettled([...this.entries.keys()].map((id) => this.stop(id, reason)));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    await this.flush();
  }
}
