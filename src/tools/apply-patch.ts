import { assertVersion, prepareWrite } from './file-mutation.js';
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { ToolError } from '../util/errors.js';
import { isPathInside, isPathInsideReal } from '../util/paths.js';
import { resolveWorkspacePath } from './paths.js';
import type { ToolDef } from './types.js';
import { createFileDiff, type FileDiff } from './file-diff.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

type HunkLineKind = 'context' | 'add' | 'remove';

interface HunkLine {
  kind: HunkLineKind;
  text: string;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: HunkLine[];
}

interface FilePatch {
  /** null when the old side is /dev/null (new file). */
  oldPath: string | null;
  deleted?: boolean;
  source?: string;
  created: boolean;
  newPath: string;
  hunks: Hunk[];
  headerLine: number;
}

interface FilePlan {
  diff: FileDiff;
  root: string;
  absolute: string;
  relative: string;
  deleted?: boolean;
  source?: string;
  created: boolean;
  content: string;
  additions: number;
  deletions: number;
}

interface TextLines {
  lines: string[];
  trailingNewline: boolean;
}

interface AppliedHunks {
  lines: string[];
  additions: number;
  deletions: number;
}

const schema = z.object({
  patch: z
    .string()
    .min(1)
    .describe(
      'Unified diff text. Each file needs "--- old" and "+++ new" headers followed by one or more ' +
        '"@@ -oldStart,oldCount +newStart,newCount @@" hunks. Use "--- /dev/null" with "+++ b/path" to create a file. ' +
        'Paths are unquoted; a/ and b/ prefixes are stripped and a tab-separated timestamp suffix is ignored.',
    ),
});

function noNewlineError(lineNumber: number): ToolError {
  return new ToolError(
    'Invalid patch at line ' +
      lineNumber +
      ': "\\ No newline at end of file" markers are not supported because ApplyPatch preserves the ' +
      'target file\'s existing final-newline behavior. Remove the marker (or ensure both files end with a newline).',
  );
}

function isMetadataLine(line: string): boolean {
  return (
    line.startsWith('diff --git ') ||
    line.startsWith('index ') ||
    line.startsWith('new file mode ') ||
    line.startsWith('old mode ') ||
    line.startsWith('new mode ') ||
    line.startsWith('similarity index ') ||
    line.startsWith('dissimilarity index ')
  );
}

function parseDiffPath(line: string, side: 'old' | 'new', lineNumber: number): string {
  let value = line.slice(4);
  const tab = value.indexOf('\t');
  if (tab >= 0) {
    value = value.slice(0, tab);
  } else {
    // Also tolerate the common "path 2024-01-01 12:00:00 +0000" timestamp form.
    const timestamp = /^(.*?)[ \t]+\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[ \t]+[+-]\d{4})?$/.exec(
      value,
    );
    if (timestamp?.[1]) value = timestamp[1];
  }

  if (value.length === 0) {
    throw new ToolError('Invalid patch at line ' + lineNumber + ': the ' + side + ' file path is empty.');
  }
  if (value.startsWith('"') || value.endsWith('"')) {
    throw new ToolError(
      'Invalid patch at line ' +
        lineNumber +
        ': quoted or escaped paths are not supported. Use plain unquoted paths (a/ and b/ prefixes are stripped).',
    );
  }
  if (value.startsWith(' ') || value.endsWith(' ')) {
    throw new ToolError(
      'Invalid patch at line ' + lineNumber + ': ambiguous ' + side + ' path ' + JSON.stringify(value) + '.',
    );
  }
  if (value.includes('\0')) {
    throw new ToolError('Invalid patch at line ' + lineNumber + ': paths must not contain NUL bytes.');
  }

  if (value === '/dev/null') return value;
  const prefix = side === 'old' ? 'a/' : 'b/';
  if (value.startsWith(prefix)) value = value.slice(prefix.length);
  if (value.length === 0) {
    throw new ToolError('Invalid patch at line ' + lineNumber + ': the ' + side + ' file path is empty after stripping ' + prefix + '.');
  }
  return value;
}

function parseHunk(lines: string[], start: number): { hunk: Hunk; next: number } {
  const header = lines[start] ?? '';
  const lineNumber = start + 1;
  const match = HUNK_HEADER.exec(header);
  if (!match) {
    throw new ToolError(
      'Invalid patch at line ' +
        lineNumber +
        ': malformed hunk header ' +
        JSON.stringify(header) +
        '. Expected "@@ -oldStart,oldCount +newStart,newCount @@".',
    );
  }

  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if (![oldStart, oldCount, newStart, newCount].every((value) => Number.isSafeInteger(value))) {
    throw new ToolError('Invalid patch at line ' + lineNumber + ': hunk line numbers are too large.');
  }
  if ((oldCount > 0 && oldStart < 1) || (newCount > 0 && newStart < 1)) {
    throw new ToolError(
      'Invalid patch at line ' + lineNumber + ': hunk starts must be at least 1 when the corresponding count is positive.',
    );
  }
  if (oldCount === 0 && newCount === 0) {
    throw new ToolError('Invalid patch at line ' + lineNumber + ': hunk "' + header + '" changes no lines.');
  }

  const body: HunkLine[] = [];
  let cursor = start + 1;
  let oldSeen = 0;
  let newSeen = 0;
  while (oldSeen < oldCount || newSeen < newCount) {
    if (cursor >= lines.length) {
      throw new ToolError(
        'Invalid patch at line ' +
          lineNumber +
          ': hunk "' +
          header +
          '" ends before its declared counts are satisfied (header expects ' +
          oldCount +
          ' old / ' +
          newCount +
          ' new lines, found ' +
          oldSeen +
          ' old / ' +
          newSeen +
          ' new lines).',
      );
    }
    const raw = lines[cursor] ?? '';
    if (raw.startsWith('\\')) throw noNewlineError(cursor + 1);

    const marker = raw[0];
    let kind: HunkLineKind;
    if (marker === ' ') {
      kind = 'context';
      oldSeen += 1;
      newSeen += 1;
    } else if (marker === '-') {
      kind = 'remove';
      oldSeen += 1;
    } else if (marker === '+') {
      kind = 'add';
      newSeen += 1;
    } else {
      throw new ToolError(
        'Invalid patch at line ' +
          cursor +
          ': hunk body lines must start with a space, "+" or "-". ' +
          (raw.length === 0 ? 'Empty lines are not valid hunk content.' : ''),
      );
    }

    if (oldSeen > oldCount || newSeen > newCount) {
      throw new ToolError(
        'Invalid patch at line ' +
          lineNumber +
          ': hunk "' +
          header +
          '" declares ' +
          oldCount +
          ' old / ' +
          newCount +
          ' new lines but its body contains more.',
      );
    }

    body.push({ kind, text: raw.slice(1) });
    cursor += 1;
  }

  return {
    hunk: { oldStart, oldCount, newStart, newCount, header, lines: body },
    next: cursor,
  };
}

/** Parse the documented subset of unified diff: unquoted paths, no renames/deletions, no EOF markers. */
function parseUnifiedDiff(patch: string): FilePatch[] {
  const lines = patch.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.endsWith('\r')) lines[index] = line.slice(0, -1);
  }

  if (lines.every((line) => line.trim().length === 0)) throw new ToolError('Patch is empty.');

  const files: FilePatch[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    if (line.startsWith('\\')) throw noNewlineError(lineNumber);
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      throw new ToolError(
        'Invalid patch at line ' +
          lineNumber +
          ': file renames are not supported. Delete + create is also rejected; edit the destination file in place instead.',
      );
    }
    if (line.startsWith('deleted file mode ')) { index += 1; continue; }
    if (isMetadataLine(line)) {
      index += 1;
      continue;
    }
    if (!line.startsWith('--- ')) {
      throw new ToolError(
        'Invalid patch at line ' + lineNumber + ': expected a "--- " file header, got ' + JSON.stringify(line) + '.',
      );
    }

    const oldPath = parseDiffPath(line, 'old', lineNumber);
    index += 1;
    if (index >= lines.length) {
      throw new ToolError('Invalid patch at line ' + lineNumber + ': missing "+++ " header after "--- ".');
    }
    const plusLine = lines[index] ?? '';
    const plusLineNumber = index + 1;
    if (plusLine.startsWith('\\')) throw noNewlineError(plusLineNumber);
    if (!plusLine.startsWith('+++ ')) {
      throw new ToolError(
        'Invalid patch at line ' +
          plusLineNumber +
          ': expected a "+++ " file header after "--- ", got ' +
          JSON.stringify(plusLine) +
          '.',
      );
    }
    const newPath = parseDiffPath(plusLine, 'new', plusLineNumber);
    index += 1;

    const deleted = newPath === '/dev/null';
    const created = oldPath === '/dev/null';
    if (!created && !deleted && oldPath !== newPath) {
      throw new ToolError(
        'Invalid patch at line ' +
          plusLineNumber +
          ': renames are not supported (old path ' +
          JSON.stringify(oldPath) +
          ', new path ' +
          JSON.stringify(newPath) +
          ').',
      );
    }

    const file: FilePatch = {
      oldPath: created ? null : oldPath,
      created,
      newPath: deleted ? oldPath : newPath,
      deleted,
      hunks: [],
      headerLine: lineNumber,
    };
    while (index < lines.length && (lines[index] ?? '').startsWith('@@')) {
      const parsed = parseHunk(lines, index);
      file.hunks.push(parsed.hunk);
      index = parsed.next;
    }
    if (file.hunks.length === 0) {
      throw new ToolError(
        'Invalid patch at line ' +
          lineNumber +
          ': file section for ' +
          JSON.stringify(newPath) +
          ' has no hunks. At least one "@@ ... @@" hunk is required.',
      );
    }

    if (index < lines.length) {
      const next = lines[index] ?? '';
      if (next.startsWith('\\')) throw noNewlineError(index + 1);
      if (
        next.startsWith(' ') ||
        (next.startsWith('+') && !next.startsWith('+++ ')) ||
        (next.startsWith('-') && !next.startsWith('--- '))
      ) {
        const last = file.hunks[file.hunks.length - 1];
        throw new ToolError(
          'Invalid patch at line ' +
            (index + 1) +
            ': hunk "' +
            (last?.header ?? '') +
            '" has more body lines than its @@ header declares.',
        );
      }
    }

    if (created) {
      for (const hunk of file.hunks) {
        if (hunk.oldStart !== 0 || hunk.oldCount !== 0) {
          throw new ToolError(
            'Invalid patch for new file ' +
              JSON.stringify(newPath) +
              ': a /dev/null patch must use "@@ -0,0 +1,N @@".',
          );
        }
        if (hunk.lines.some((item) => item.kind !== 'add')) {
          throw new ToolError(
            'Invalid patch for new file ' +
              JSON.stringify(newPath) +
              ': new-file hunks may contain only "+" lines (no context or removed lines).',
          );
        }
      }
    }

    files.push(file);
  }

  if (files.length === 0) throw new ToolError('Patch contains no file changes.');
  return files;
}

function splitText(text: string): TextLines {
  if (text.length === 0) return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function applyHunks(filePatch: FilePatch, displayPath: string, oldLines: string[]): AppliedHunks {
  const output: string[] = [];
  let cursor = 0;
  let additions = 0;
  let deletions = 0;

  for (const hunk of filePatch.hunks) {
    // The new-side start determines how many unchanged lines precede this hunk. This also
    // disambiguates a pure insertion at the start of a non-empty file, where the
    // conventional old-side start is 1 even though the insertion index is 0.
    const newLinesBefore = hunk.newCount > 0 ? hunk.newStart - 1 : hunk.newStart;
    if (newLinesBefore < output.length) {
      throw new ToolError(
        'Invalid patch for ' +
          displayPath +
          ': hunk "' +
          hunk.header +
          '" overlaps or is out of order (new-file start ' +
          hunk.newStart +
          ' is before the previous hunk ended).',
      );
    }

    const start = cursor + (newLinesBefore - output.length);
    if (start > oldLines.length) {
      throw new ToolError(
        'Invalid patch for ' +
          displayPath +
          ': hunk "' +
          hunk.header +
          '" starts beyond the end of the file (' +
          oldLines.length +
          ' line(s)).',
      );
    }

    const expectedOldStart =
      hunk.oldCount > 0 ? start + 1 : start === 0 ? (oldLines.length === 0 ? 0 : 1) : start;
    if (hunk.oldStart !== expectedOldStart) {
      throw new ToolError(
        'Invalid patch for ' +
          displayPath +
          ': hunk "' +
          hunk.header +
          '" has inconsistent coordinates (old start ' +
          hunk.oldStart +
          ', new start ' +
          hunk.newStart +
          '; expected old start ' +
          expectedOldStart +
          ').',
      );
    }

    if (hunk.oldCount > 0 && start + hunk.oldCount > oldLines.length) {
      throw new ToolError(
        'Invalid patch for ' +
          displayPath +
          ': hunk "' +
          hunk.header +
          '" needs ' +
          hunk.oldCount +
          ' old line(s) starting at ' +
          hunk.oldStart +
          ' but the file has only ' +
          oldLines.length +
          ' line(s).',
      );
    }

    output.push(...oldLines.slice(cursor, start));
    cursor = start;

    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        output.push(line.text);
        additions += 1;
        continue;
      }

      const expected = oldLines[cursor];
      if (expected === undefined) {
        throw new ToolError(
          'Invalid patch for ' +
            displayPath +
            ': hunk "' +
            hunk.header +
            '" needs another line but the file ended at line ' +
            oldLines.length +
            '.',
        );
      }
      if (expected !== line.text) {
        throw new ToolError(
          (line.kind === 'context' ? 'Context mismatch' : 'Line to remove does not match') +
            ' in ' +
            displayPath +
            ' at line ' +
            (cursor + 1) +
            ' (hunk "' +
            hunk.header +
            '"): expected ' +
            JSON.stringify(line.text) +
            ', found ' +
            JSON.stringify(expected) +
            '. Read the file again and regenerate the patch.',
        );
      }
      if (line.kind === 'context') output.push(line.text);
      else deletions += 1;
      cursor += 1;
    }
  }

  output.push(...oldLines.slice(cursor));
  return { lines: output, additions, deletions };
}

function joinText(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

async function lstatOptional(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ToolError('Cannot access ' + target + ': ' + (error instanceof Error ? error.message : String(error)), {
      cause: error,
    });
  }
}

function readFailure(relative: string): { content: string; isError: true; meta: Record<string, unknown> } {
  return {
    content:
      'Refusing to apply the patch to ' +
      relative +
      ' before it has been read. Call Read on this file first, then retry ApplyPatch.',
    isError: true,
    meta: { path: relative, reason: 'read-before-write' },
  };
}

export const applyPatchTool: ToolDef<typeof schema> = {
  name: 'ApplyPatch',
  description:
    'Apply a standard unified diff to one or more UTF-8 text files inside the workspace or an --add-dir root. Supports multiple files ' +
    'and multiple "@@ -oldStart,oldCount +newStart,newCount @@" hunks per file. Paths are unquoted; a/ and b/ ' +
    'header prefixes are stripped and tab-separated timestamps are ignored. Create a new file with "--- /dev/null" ' +
    'and "+++ b/path"; the target must not already exist and parent directories are created. ' +
    'Every existing target must have been read with Read in this session first. Deletion uses +++ /dev/null with hunks removing all lines. Renames, quoted ' +
    'paths, and "\\ No newline at end of file" markers are rejected. All hunks are parsed, validated and applied in ' +
    'memory before anything is written, so a validation failure leaves every file unchanged. Existing file modes and ' +
    'final-newline behavior are preserved. Use Edit for a single targeted replacement and Write for a full rewrite.',
  schema,
  parallelSafe: false,
  approval: 'on-write',
  async execute(input, ctx) {
    const filePatches = parseUnifiedDiff(input.patch);
    const plans: FilePlan[] = [];
    const seen = new Set<string>();

    for (const filePatch of filePatches) {
      const resolved = await resolveWorkspacePath(ctx, filePatch.newPath, { mustExist: !filePatch.created, access: 'write' });
      if (seen.has(resolved.absolute)) {
        throw new ToolError('Patch changes the same file more than once: ' + resolved.relative + '.');
      }
      seen.add(resolved.absolute);

      if (filePatch.created) {
        if (resolved.exists) {
          throw new ToolError('Cannot create ' + resolved.relative + ': the file already exists.');
        }
        const existingEntry = await lstatOptional(resolved.absolute);
        if (existingEntry) {
          if (existingEntry.isSymbolicLink()) {
            throw new ToolError(
              'Cannot create ' + resolved.relative + ': a symbolic link already exists at that path.',
            );
          }
          throw new ToolError('Cannot create ' + resolved.relative + ': the path already exists.');
        }

        const parent = path.dirname(resolved.absolute);
        if (!isPathInside(resolved.root, parent)) {
          throw new ToolError('Path is outside the workspace: ' + filePatch.newPath + '.');
        }
        if (!(await isPathInsideReal(resolved.root, parent))) {
          throw new ToolError('Parent directory resolves outside the workspace: ' + filePatch.newPath + '.');
        }

        const applied = applyHunks(filePatch, resolved.relative, []);
        plans.push({
          root: resolved.root,
          absolute: resolved.absolute,
          relative: resolved.relative,
          created: true,
          content: joinText(applied.lines, true),
          diff: createFileDiff(resolved.relative, '', joinText(applied.lines, true)),
          additions: applied.additions,
          deletions: applied.deletions,
        });
        continue;
      }

      const info = await stat(resolved.absolute);
      if (!info.isFile()) {
        throw new ToolError('Not a regular file: ' + resolved.relative + '.');
      }
      if (info.size > MAX_FILE_BYTES) {
        throw new ToolError(
          'File is too large to patch (' + Math.ceil(info.size / 1024 / 1024) + ' MiB); the limit is 10 MiB.',
        );
      }

      const buffer = await readFile(resolved.absolute);
      if (buffer.includes(0)) {
        throw new ToolError('File appears to be binary and cannot be patched: ' + resolved.relative + '.');
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        throw new ToolError('File is not valid UTF-8 and cannot be patched: ' + resolved.relative + '.');
      }

      if (!ctx.readTracker.hasRead(resolved.absolute)) return readFailure(resolved.relative);

      const before = splitText(text);
      const applied = applyHunks(filePatch, resolved.relative, before.lines);
      if (filePatch.deleted && applied.lines.length) throw new ToolError('Deletion patch must remove the entire file.');
      const trailingNewline = text.length === 0 ? applied.lines.length > 0 : before.trailingNewline;
      plans.push({
        root: resolved.root,
        absolute: resolved.absolute,
        relative: resolved.relative,
        created: false,
        deleted: filePatch.deleted,
        source: path.resolve(ctx.cwd, filePatch.newPath),
        content: joinText(applied.lines, trailingNewline),
        diff: createFileDiff(resolved.relative, text, joinText(applied.lines, trailingNewline)),
        additions: applied.additions,
        deletions: applied.deletions,
      });
    }

    // Parent directories are prepared only after every file/hunk has validated.
    for (const plan of plans) {
      if (!plan.created) continue;
      const parent = path.dirname(plan.absolute);
      if (!isPathInside(plan.root, parent)) {
        throw new ToolError('Path is outside the workspace: ' + plan.relative + '.');
      }
      try {
        await mkdir(parent, { recursive: true });
      } catch (error) {
        throw new ToolError(
          'Cannot create parent directory for ' + plan.relative + ': ' +
            (error instanceof Error ? error.message : String(error)),
          { cause: error },
        );
      }
      if (!(await isPathInsideReal(plan.root, parent))) {
        throw new ToolError('Parent directory resolves outside the workspace: ' + plan.relative + '.');
      }
      const parentInfo = await stat(parent);
      if (!parentInfo.isDirectory()) {
        throw new ToolError('Parent path is not a directory: ' + plan.relative + '.');
      }
    }

    // Snapshot every target and persist every checkpoint before the first mutation.
    const writes = [];
    for (const plan of plans) writes.push(await prepareWrite(ctx, plan.absolute, plan.deleted ? undefined : plan.content, plan.source));
    for (const plan of plans) {
      ctx.readTracker.assertUnchanged(plan.absolute);
      if (plan.created) assertVersion(plan.absolute, undefined);
    }
    const versions = [];
    for (const write of writes) versions.push(await write());

    const totalAdditions = plans.reduce((sum, plan) => sum + plan.additions, 0);
    const totalDeletions = plans.reduce((sum, plan) => sum + plan.deletions, 0);
    const details = plans
      .map(
        (plan) =>
          (plan.deleted ? 'deleted ' : plan.created ? 'created ' : 'updated ') +
          plan.relative +
          ' (+' +
          plan.additions +
          '/-' +
          plan.deletions +
          ')',
      )
      .join(', ');
    return {
      content:
        'Applied patch to ' +
        plans.length +
        ' file' +
        (plans.length === 1 ? '' : 's') +
        ' (' +
        totalAdditions +
        ' addition' +
        (totalAdditions === 1 ? '' : 's') +
        ', ' +
        totalDeletions +
        ' deletion' +
        (totalDeletions === 1 ? '' : 's') +
        '): ' +
        details +
        '.',
      meta: {
        versions,
        fileDiffs: plans.map((plan) => plan.diff),
        files: plans.map((plan) => ({
          path: plan.relative,
          created: plan.created,
          deleted: plan.deleted ?? false,
          additions: plan.additions,
          deletions: plan.deletions,
        })),
        filesChanged: plans.length,
      },
    };
  },
};
