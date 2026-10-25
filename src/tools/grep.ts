import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import ignore from 'ignore';
import { z } from 'zod';
import { abortError, ToolError } from '../util/errors.js';
import { canonicalizePath, isPathInside } from '../util/paths.js';
import { resolveWorkspacePath } from './paths.js';
import type { ToolContext, ToolDef, ToolResult } from './types.js';

const MAX_MATCHES = 100;
const RG_TIMEOUT_MS = 15_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_FALLBACK_FILE_BYTES = 10 * 1024 * 1024;
const TRUNCATION_FOOTER = '[... matches truncated; narrow the search ...]';

const DEFAULT_IGNORES = [
  '.git/',
  'node_modules/',
  'dist/',
  'build/',
  'coverage/',
  '.codingx/',
  '.DS_Store',
  '*.log',
];

const GLOB_IGNORES = ['.git/**', 'node_modules/**', 'dist/**', 'build/**', 'coverage/**'];

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.7z',
  '.jar', '.class', '.so', '.dylib', '.dll', '.exe', '.bin', '.wasm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.flac',
  '.sqlite', '.db',
]);

const RG_MATCH_RE = /^(.+?):(\d+):(.*)$/;
const RG_CONTEXT_RE = /^(\d+)-(.*)$/;

const schema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('Regular expression to search for in file contents, for example "TODO|FIXME" or "className=\\"[^\\"]+\\"".'),
  path: z
    .string()
    .min(1)
    .optional()
    .default('.')
    .describe('File or directory to search, relative to the workspace root (or absolute inside an allowed root). Defaults to the workspace root.'),
  glob: z
    .string()
    .min(1)
    .optional()
    .describe('Optional file-name filter such as "*.ts" or "src/**/*.ts"; only matching files are searched.'),
  context: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .default(0)
    .describe('Number of surrounding lines to include for each match (0-5). Defaults to 0.'),
});

export interface BuiltinGrepOptions {
  /** Canonical workspace root; matched files must resolve inside it. */
  workspaceRoot: string;
  /** Absolute file or directory to search, already confined to the workspace. */
  target: string;
  pattern: string;
  glob?: string;
  context?: number;
  maxMatches?: number;
  /** Base directory for the paths in the returned lines. Defaults to workspaceRoot. */
  displayRoot?: string;
  /** Extra sensitive-path filter applied after workspace containment. */
  denyPath?: (absolute: string) => boolean;
  signal?: AbortSignal;
}

export interface BuiltinGrepResult {
  lines: string[];
  matches: number;
  truncated: boolean;
  /** True when an invalid regular expression was matched as literal text. */
  literal: boolean;
}

interface RipgrepRun {
  unavailable: boolean;
  failure?: string;
  aborted: boolean;
  timedOut: boolean;
  outputTruncated: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

type IgnoreMatcher = ReturnType<typeof ignore>;

interface LineMatcher {
  test(line: string): boolean;
  literal: boolean;
}

/** Compile a regex, degrading to literal substring matching for invalid patterns. */
function createMatcher(pattern: string): LineMatcher {
  try {
    const regex = new RegExp(pattern);
    return { test: (line) => regex.test(line), literal: false };
  } catch {
    return { test: (line) => line.includes(pattern), literal: true };
  }
}

function isBinaryName(name: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function toDisplayPath(displayRoot: string, absolute: string): string {
  return path.relative(displayRoot, absolute).split(path.sep).join('/');
}

async function loadIgnoreMatcher(root: string): Promise<IgnoreMatcher> {
  const matcher = ignore().add(DEFAULT_IGNORES);
  try {
    const text = await readFile(path.join(root, '.gitignore'), 'utf8');
    if (text.trim().length > 0) matcher.add(text);
  } catch {
    // A missing .gitignore is fine.
  }
  return matcher;
}

async function verifyWorkspaceFile(file: string, workspaceRoot: string): Promise<string | undefined> {
  try {
    const canonical = await canonicalizePath(file);
    return isPathInside(workspaceRoot, canonical) ? canonical : undefined;
  } catch {
    return undefined;
  }
}

async function collectFiles(
  target: string,
  workspaceRoot: string,
  matcher: IgnoreMatcher,
  signal?: AbortSignal,
): Promise<string[]> {
  if (signal?.aborted) throw abortError('grep aborted.');
  const info = await stat(target);
  if (info.isFile()) return [target];
  if (!info.isDirectory()) throw new ToolError('Not a file or directory: ' + target + '.');

  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    if (signal?.aborted) throw abortError('grep aborted.');
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new ToolError(
        'Cannot search ' + directory + ': ' + (error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    for (const entry of entries) {
      if (signal?.aborted) throw abortError('grep aborted.');
      // Do not follow symlinks: their targets may be outside the workspace.
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relativeToRoot = path.relative(workspaceRoot, absolute).split(path.sep).join('/');
      if (relativeToRoot === '..' || relativeToRoot.startsWith('../')) continue;
      const ignoreKey = relativeToRoot + (entry.isDirectory() ? '/' : '');
      try {
        if (matcher.ignores(ignoreKey)) continue;
      } catch {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile() || isBinaryName(entry.name)) continue;
      files.push(absolute);
    }
  };

  await walk(target);
  return files;
}

async function filterFilesByGlob(
  files: string[],
  target: string,
  glob: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (signal?.aborted) throw abortError('grep aborted.');
  const info = await stat(target);
  const base = info.isDirectory() ? target : path.dirname(target);
  let matched: string[];
  try {
    matched = await fg(glob, {
      cwd: base,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
      baseNameMatch: true,
      ignore: GLOB_IGNORES,
    });
  } catch (error) {
    throw new ToolError('Invalid glob filter "' + glob + '": ' + (error instanceof Error ? error.message : String(error)), {
      cause: error,
    });
  }
  const allowed = new Set(matched.map((item) => path.resolve(base, item)));
  return files.filter((file) => allowed.has(path.resolve(file)));
}

async function fileHasMatch(
  file: string,
  matcher: LineMatcher,
  workspaceRoot: string,
  signal?: AbortSignal,
  denyPath?: (absolute: string) => boolean,
): Promise<boolean> {
  if (signal?.aborted) throw abortError('grep aborted.');
  if (isBinaryName(file)) return false;
  const canonical = await verifyWorkspaceFile(file, workspaceRoot);
  if (!canonical || denyPath?.(canonical) === true) return false;
  const info = await stat(canonical).catch(() => undefined);
  if (!info || !info.isFile() || info.size > MAX_FALLBACK_FILE_BYTES) return false;
  const buffer = await readFile(canonical).catch(() => undefined);
  if (!buffer || buffer.subarray(0, 8192).includes(0)) return false;
  return splitLines(buffer.toString('utf8')).some((line) => matcher.test(line));
}

/**
 * Built-in grep fallback used when ripgrep is unavailable. Exported so the
 * recursive walk, ignore handling and matching can be tested directly.
 */
export async function grepBuiltin(options: BuiltinGrepOptions): Promise<BuiltinGrepResult> {
  const maxMatches = options.maxMatches ?? MAX_MATCHES;
  const context = options.context ?? 0;
  const lineMatcher = createMatcher(options.pattern);
  const matcher = await loadIgnoreMatcher(options.workspaceRoot);
  let files = await collectFiles(options.target, options.workspaceRoot, matcher, options.signal);
  if (options.glob) files = await filterFilesByGlob(files, options.target, options.glob, options.signal);
  const displayRoot = options.displayRoot ?? options.workspaceRoot;

  const output: string[] = [];
  let matches = 0;
  let truncated = false;
  let atLimit = false;

  for (const file of files) {
    if (options.signal?.aborted) throw abortError('grep aborted.');

    if (atLimit) {
      // Max matches are already collected; scan only to learn whether more exist.
      if (await fileHasMatch(file, lineMatcher, options.workspaceRoot, options.signal, options.denyPath)) {
        truncated = true;
        break;
      }
      continue;
    }

    if (isBinaryName(file)) continue;
    const canonical = await verifyWorkspaceFile(file, options.workspaceRoot);
    if (!canonical || options.denyPath?.(canonical) === true) continue;
    const info = await stat(canonical).catch(() => undefined);
    if (!info || !info.isFile() || info.size > MAX_FALLBACK_FILE_BYTES) continue;
    const buffer = await readFile(canonical).catch(() => undefined);
    if (!buffer || buffer.subarray(0, 8192).includes(0)) continue;
    const fileLines = splitLines(buffer.toString('utf8'));

    const matchedIndexes: number[] = [];
    for (let index = 0; index < fileLines.length; index++) {
      if (lineMatcher.test(fileLines[index] ?? '')) matchedIndexes.push(index);
    }
    if (matchedIndexes.length === 0) continue;

    const remaining = maxMatches - matches;
    if (matchedIndexes.length > remaining) truncated = true;
    const take = Math.min(matchedIndexes.length, remaining);
    const selected = new Map<number, boolean>();
    for (let index = 0; index < take; index++) {
      const lineIndex = matchedIndexes[index] ?? 0;
      selected.set(lineIndex, true);
      const start = Math.max(0, lineIndex - context);
      const end = Math.min(fileLines.length - 1, lineIndex + context);
      for (let cursor = start; cursor <= end; cursor++) {
        if (!selected.has(cursor)) selected.set(cursor, false);
      }
    }

    const displayPath = toDisplayPath(displayRoot, canonical);
    for (const lineIndex of [...selected.keys()].sort((left, right) => left - right)) {
      const isMatch = selected.get(lineIndex) === true;
      const separator = isMatch ? ':' : '-';
      output.push(displayPath + separator + (lineIndex + 1) + separator + (fileLines[lineIndex] ?? ''));
    }

    matches += take;
    if (truncated) break;
    if (matches >= maxMatches) atLimit = true;
  }

  return { lines: output, matches, truncated, literal: lineMatcher.literal };
}

function parseRgContextLine(
  line: string,
  files: string[],
): { filePart: string; lineNo: number; text: string } | undefined {
  let best: string | undefined;
  for (const file of files) {
    if (line.startsWith(file + '-') && (best === undefined || file.length > best.length)) best = file;
  }
  if (best === undefined) return undefined;
  const match = RG_CONTEXT_RE.exec(line.slice(best.length + 1));
  if (!match) return undefined;
  return { filePart: best, lineNo: Number(match[1]), text: match[2] ?? '' };
}

async function parseRipgrepOutput(
  stdout: string,
  resolveRoot: string,
  allowedRoot: string,
  displayRoot: string,
  denyPath?: (absolute: string) => boolean,
): Promise<BuiltinGrepResult> {
  const rawLines = stdout.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const lines = rawLines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));

  const fileParts = new Set<string>();
  for (const line of lines) {
    const match = RG_MATCH_RE.exec(line);
    if (match) fileParts.add(match[1] ?? '');
  }

  const cache = new Map<string, string | null>();
  const displayFor = async (filePart: string): Promise<string | null> => {
    if (cache.has(filePart)) return cache.get(filePart) ?? null;
    let display: string | null = null;
    try {
      const canonical = await canonicalizePath(path.resolve(resolveRoot, filePart));
      if (isPathInside(allowedRoot, canonical) && denyPath?.(canonical) !== true) {
        const info = await stat(canonical);
        if (info.isFile()) display = toDisplayPath(displayRoot, canonical);
      }
    } catch {
      display = null;
    }
    cache.set(filePart, display);
    return display;
  };

  const verified: string[] = [];
  for (const filePart of fileParts) {
    if ((await displayFor(filePart)) !== null) verified.push(filePart);
  }

  const output: string[] = [];
  let matches = 0;
  let truncated = false;
  for (const line of lines) {
    if (line === '--' || line.length === 0) continue;
    const match = RG_MATCH_RE.exec(line);
    if (match) {
      const filePart = match[1] ?? '';
      const display = await displayFor(filePart);
      if (display === null) continue;
      if (matches >= MAX_MATCHES) {
        truncated = true;
        break;
      }
      output.push(display + ':' + (match[2] ?? '') + ':' + (match[3] ?? ''));
      matches += 1;
      continue;
    }

    const contextLine = parseRgContextLine(line, verified);
    if (!contextLine) continue;
    const display = await displayFor(contextLine.filePart);
    if (display === null) continue;
    output.push(display + '-' + contextLine.lineNo + '-' + contextLine.text);
  }

  return { lines: output, matches, truncated, literal: false };
}

function runRipgrep(args: string[], cwd: string, ctx: ToolContext): Promise<RipgrepRun> {
  return new Promise<RipgrepRun>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let unavailable = false;
    let failure: string | undefined;
    let aborted = false;
    let timedOut = false;
    let outputTruncated = false;

    let child: ChildProcess;
    try {
      child = spawn('rg', args, {
        cwd,
        env: ctx.shell.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        unavailable: false,
        failure: 'Failed to start rg: ' + (error instanceof Error ? error.message : String(error)),
        aborted: false,
        timedOut: false,
        outputTruncated: false,
        stdout: '',
        stderr: '',
        code: null,
      });
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const kill = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        // The process may already be gone.
      }
      if (!forceTimer) {
        forceTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // The process may already be gone.
          }
        }, 1_000);
        forceTimer.unref();
      }
    };

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      ctx.signal.removeEventListener('abort', onAbort);
    };

    const finish = (result: RipgrepRun): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      kill();
    };

    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      kill();
    }, RG_TIMEOUT_MS);

    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_CAPTURE_BYTES) {
        stdoutChunks.push(chunk);
        return;
      }
      const room = MAX_CAPTURE_BYTES - (stdoutBytes - chunk.length);
      if (room > 0) stdoutChunks.push(chunk.subarray(0, room));
      outputTruncated = true;
      kill();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_CAPTURE_BYTES) {
        stderrChunks.push(chunk);
        return;
      }
      const room = MAX_CAPTURE_BYTES - (stderrBytes - chunk.length);
      if (room > 0) stderrChunks.push(chunk.subarray(0, room));
    });

    child.on('error', (error: Error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') unavailable = true;
      else failure = 'Failed to start rg: ' + error.message;
      finish({
        unavailable,
        ...(failure === undefined ? {} : { failure }),
        aborted,
        timedOut,
        outputTruncated,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        code: null,
      });
    });

    child.on('close', (code) => {
      finish({
        unavailable: unavailable || code === 127,
        ...(failure === undefined ? {} : { failure }),
        aborted,
        timedOut,
        outputTruncated,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        code,
      });
    });
  });
}

function grepResult(
  input: { pattern: string; glob?: string },
  relativePath: string,
  engine: 'rg' | 'builtin',
  result: BuiltinGrepResult,
  outputTruncated = false,
): ToolResult {
  const truncated = result.truncated || outputTruncated;
  const meta = { pattern: input.pattern, path: relativePath, matches: result.matches, truncated, engine };
  if (result.matches === 0) {
    return {
      content: truncated
        ? 'No complete matches were captured before the search output limit was reached; narrow the search.'
        : 'No matches for "' + input.pattern + '" in ' +
          (relativePath === '.' ? 'the workspace' : relativePath) +
          (input.glob === undefined ? '' : ' (glob "' + input.glob + '")') + '.',
      meta,
    };
  }
  return {
    content: result.lines.join('\n') + (truncated ? '\n' + TRUNCATION_FOOTER : ''),
    meta,
  };
}

function grepError(content: string, input: { pattern: string }, relativePath: string): ToolResult {
  return {
    content,
    isError: true,
    meta: { pattern: input.pattern, path: relativePath, matches: 0, truncated: false, engine: 'rg' },
  };
}

export const grepTool: ToolDef<typeof schema> = {
  name: 'Grep',
  description:
    'Search file contents inside the workspace or an --add-dir root with a regular expression. Use Grep for content (a symbol, string or pattern inside files); ' +
    'use Glob to discover files by their names. ripgrep is preferred and a built-in scanner is used when rg is unavailable. ' +
    'path may be a file or directory; the glob filter narrows the files searched and context includes surrounding lines. ' +
    'Output is file:line:content and is capped at 100 matches with an explicit truncation marker. ' +
    'Invalid regular expressions and search failures are reported as errors so the pattern can be fixed. ' +
    'If a search returns no matches, widen the pattern or check the path before concluding the code is absent; ' +
    'do not fall back to shell grep.',
  schema,
  parallelSafe: true,
  approval: 'none',
  async execute(input, ctx) {
    const requested = input.path ?? '.';
    const resolved = await resolveWorkspacePath(ctx, requested, { mustExist: true, access: 'read' });
    const info = await stat(resolved.absolute);
    if (!info.isFile() && !info.isDirectory()) {
      throw new ToolError('Not a file or directory: ' + requested + '.');
    }
    if (ctx.signal.aborted) throw abortError('grep aborted.');

    const args = ['-n', '--no-heading', '--color', 'never', '--with-filename'];
    if (input.context > 0) args.push('-C', String(input.context));
    if (input.glob) args.push('-g', input.glob);
    args.push('--', input.pattern, resolved.relative);

    const run = await runRipgrep(args, resolved.workspaceRoot, ctx);
    if (run.aborted || ctx.signal.aborted) throw abortError('grep aborted.');

    if (run.unavailable) {
      const result = await grepBuiltin({
        workspaceRoot: resolved.root,
        target: resolved.absolute,
        pattern: input.pattern,
        ...(input.glob === undefined ? {} : { glob: input.glob }),
        context: input.context,
        maxMatches: MAX_MATCHES,
        displayRoot: resolved.workspaceRoot,
        ...(ctx.policy === undefined
          ? {}
          : { denyPath: (candidate: string) => ctx.policy?.isPathDenied(candidate) === true }),
        signal: ctx.signal,
      });
      const formatted = grepResult(input, resolved.relative, 'builtin', result);
      if (!result.literal) return formatted;
      return {
        content:
          'Invalid regular expression "' + input.pattern +
          '"; the built-in engine searched for it as literal text.\n\n' + formatted.content,
        isError: true,
        meta: formatted.meta,
      };
    }

    if (run.timedOut) {
      return grepError(
        'grep timed out after ' + RG_TIMEOUT_MS + 'ms; narrow the path or pattern.',
        input,
        resolved.relative,
      );
    }

    const failed = !run.outputTruncated && (run.failure !== undefined || (run.code !== 0 && run.code !== 1));
    if (failed) {
      const detail =
        run.failure ??
        (run.stderr.trim().length > 0
          ? run.stderr.trim()
          : 'rg exited with code ' + (run.code === null ? 'unknown' : run.code));
      const invalid = /regex parse error|error parsing regex|invalid regex/i.test(detail);
      return grepError(
        (invalid ? 'Invalid regular expression: ' : 'grep failed: ') + detail,
        input,
        resolved.relative,
      );
    }

    const parsed = await parseRipgrepOutput(
      run.stdout,
      resolved.workspaceRoot,
      resolved.root,
      resolved.workspaceRoot,
      ctx.policy === undefined
        ? undefined
        : (candidate: string) => ctx.policy?.isPathDenied(candidate) === true,
    );
    return grepResult(input, resolved.relative, 'rg', parsed, run.outputTruncated);
  },
};
