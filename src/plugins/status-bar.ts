import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { runShellCommand } from '../exec/process.js';
import { buildChildEnv } from '../exec/env.js';
import { ConfigError, CodingxError } from '../util/errors.js';
import { stripControlSequences } from '../tui/terminal/width.js';
import type { PluginExecution, PluginManifest, StatusBarInput, StatusBarSegment, StatusBarView, TurnSummaryInput, TurnSummaryView } from './types.js';

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const executionSchema = z.object({
  type: z.literal('command'), command: z.string().min(1), args: z.array(z.string()).max(64).default([]),
}).strict();
const manifestSchema = z.object({
  manifest_version: z.literal(1), id: idSchema, name: z.string().min(1), version: z.string().min(1),
  capabilities: z.object({
    status_bar: z.object({
      protocol: z.literal('codingx.status-bar/v1'), mode: z.literal('decorate'),
      placement: z.object({ after: z.literal('total_tokens') }).strict(),
      execution: executionSchema,
    }).strict(),
    turn_summary: z.object({
      protocol: z.literal('codingx.turn-summary/v1'), mode: z.literal('decorate'),
      placement: z.object({ after: z.literal('output_rate') }).strict(), execution: executionSchema,
    }).strict().optional(),
  }).passthrough(),
}).strict();
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const segmentsSchema = z.array(z.object({
    text: z.string().max(2048), fg: color.optional(), bg: color.optional(),
    bold: z.boolean().optional(), dim: z.boolean().optional(),
    italic: z.boolean().optional(), underline: z.boolean().optional(),
  }).strict()).max(32);
const viewSchema = z.object({
  version: z.literal(1), segments: segmentsSchema,
}).strict();
const turnViewSchema = viewSchema.extend({ details: z.array(z.object({ segments: segmentsSchema }).strict()).max(64).optional() });

export function parseTurnSummaryView(value: unknown): TurnSummaryView {
  const parsed = turnViewSchema.safeParse(value);
  if (!parsed.success) throw new CodingxError('PLUGIN_ERROR', 'Invalid turn summary response.');
  return { ...parseStatusBarView({ version: 1, segments: parsed.data.segments }),
    ...(parsed.data.details ? { details: parsed.data.details.map((line) => ({
      segments: parseStatusBarView({ version: 1, segments: line.segments }).segments,
    })) } : {}),
  };
}

export function parseStatusBarView(value: unknown): StatusBarView {
  const parsed = viewSchema.safeParse(value);
  if (!parsed.success) throw new CodingxError('PLUGIN_ERROR', 'Invalid status bar response.');
  return { ...parsed.data, segments: parsed.data.segments.map((segment) => ({
    ...segment, text: stripControlSequences(segment.text).replace(/[\r\n\t\u2028\u2029]/gu, ' '),
  })) };
}

export async function loadStatusBarPlugin(home: string, id: string): Promise<{ manifest: PluginManifest; directory: string }> {
  if (!idSchema.safeParse(id).success) throw new ConfigError('Invalid plugin ID.');
  const directory = path.join(home, 'plugins', id);
  const plugin = await readPluginDirectory(directory);
  if (plugin.manifest.id !== id) throw new ConfigError('Manifest ID does not match its directory.');
  return plugin;
}

/** Read and validate a local source without executing its entry point. */
export async function readPluginDirectory(directory: string): Promise<{ manifest: PluginManifest; directory: string }> {
  try {
    const file = path.join(directory, 'manifest.yaml');
    if ((await stat(file)).size > 32768) throw new Error('Manifest exceeds 32 KiB.');
    const document = parseDocument(await readFile(file, 'utf8'), { uniqueKeys: true });
    if (document.errors.length > 0) throw new Error('Invalid YAML.');
    const manifest = manifestSchema.parse(document.toJS({ maxAliasCount: 0 }));
    return { manifest, directory };
  } catch (error) {
    throw new ConfigError('Cannot load plugin manifest: invalid manifest, unsupported protocol, or missing file.', { cause: error });
  }
}

export async function executeStatusBarPlugin(options: {
  manifest: PluginManifest; directory: string; input: StatusBarInput;
  timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal;
}): Promise<StatusBarView> {
  const execution = options.manifest.capabilities.status_bar.execution;
  return parseStatusBarView(await executePluginView({ ...options, execution }));
}

export async function executeTurnSummaryPlugin(options: {
  manifest: PluginManifest; directory: string; input: TurnSummaryInput;
  timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal;
}): Promise<TurnSummaryView> {
  const execution = options.manifest.capabilities.turn_summary?.execution;
  if (!execution) throw new CodingxError('PLUGIN_ERROR', 'Plugin has no turn_summary capability.');
  return parseTurnSummaryView(await executePluginView({ ...options, execution }));
}

async function executePluginView(options: {
  execution: PluginExecution; directory: string; input: StatusBarInput | TurnSummaryInput;
  timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal;
}): Promise<unknown> {
  const execution = options.execution;
  const input = JSON.stringify(options.input);
  if (Buffer.byteLength(input) > 8 * 1024 * 1024) throw new CodingxError('PLUGIN_ERROR', 'Plugin input exceeds 8 MiB.');
  const result = await runShellCommand({
    command: execution.command,
    invocation: { file: execution.command === 'node' ? process.execPath : execution.command, args: execution.args },
    cwd: options.directory, stdin: input + '\n', timeoutMs: options.timeoutMs,
    env: buildChildEnv(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'], options.env),
    maxOutputChars: 32768, signal: options.signal,
    cleanupProcessGroup: true,
  });
  if (result.exitCode !== 0 || result.timedOut || result.aborted || result.stdoutTruncated) {
    throw new CodingxError('PLUGIN_ERROR', 'Status bar plugin failed, timed out, or exceeded its output limit.');
  }
  try { return JSON.parse(result.stdout); }
  catch { throw new CodingxError('PLUGIN_ERROR', 'Invalid status bar plugin JSON response.'); }
}

/** Async single-flight host. Rendering never waits for the child; obsolete results cannot repaint. */
export class StatusBarPluginHost {
  private timer: NodeJS.Timeout | undefined;
  private active: AbortController | undefined;
  private pending: Promise<void> | undefined;
  private stopped = false;
  private key = '';
  private nextRun = 0;
  private warned = false;

  constructor(private readonly options: {
    manifest: PluginManifest; directory: string; timeoutMs: number; refreshMs: number; env: NodeJS.ProcessEnv;
    snapshot: () => StatusBarInput;
    publish: (segments: StatusBarSegment[]) => void;
    warn: (message: string) => void;
    execute?: typeof executeStatusBarPlugin;
  }) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), 100);
    this.timer.unref();
  }

  poll(): void {
    if (this.stopped) return;
    const input = this.options.snapshot();
    // The clock animates in the host. It must not invalidate every child result.
    const key = JSON.stringify({ ...input, status: { ...input.status, elapsedMs: 0 } });
    if (key !== this.key) {
      this.key = key;
      this.nextRun = 0;
      this.options.publish([]);
    }
    if (this.active || Date.now() < this.nextRun) return;
    const controller = this.active = new AbortController();
    this.pending = (async () => {
      try {
        const view = await (this.options.execute ?? executeStatusBarPlugin)({ ...this.options, input, signal: controller.signal });
        const latest = this.options.snapshot();
        const latestKey = JSON.stringify({ ...latest, status: { ...latest.status, elapsedMs: 0 } });
        if (!this.stopped && key === latestKey) this.options.publish(view.segments);
      } catch {
        if (!this.stopped) {
          this.options.publish([]);
          if (!this.warned) {
            this.warned = true;
            this.options.warn('PLUGIN_ERROR: status bar plugin failed; using the default status bar.');
          }
        }
      } finally {
        this.active = undefined;
        this.nextRun = Date.now() + this.options.refreshMs;
      }
    })();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.active?.abort();
    await this.pending;
  }
}
