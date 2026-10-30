import type { FileDiff, FileDiffLine } from '../../tools/file-diff.js';
import type { ExecCell } from '../state/types.js';
import { TUI_COLORS, TRANSCRIPT_COLORS } from '../state/types.js';
import { ATTR_BOLD, ATTR_DIM, rgbColor, type Style } from '../terminal/buffer.js';
import { displayWidth, stripControlSequences } from '../text/index.js';
import { wrapStyledSegments } from './markdown.js';
import type { StyledTextLine, StyledTextSegment } from './welcome.js';

const MUTED: Style = { attrs: ATTR_DIM };
const ADD: Style = { fg: TUI_COLORS.diffAdd };
const REMOVE: Style = { fg: TUI_COLORS.diffDel };
const KEYWORD: Style = { fg: rgbColor(198, 155, 227) };
const NUMBER: Style = { fg: rgbColor(222, 169, 119) };
const STRING: Style = { fg: TRANSCRIPT_COLORS.code };

export function isEdited(cell: ExecCell): boolean {
  return !cell.running && !cell.isError && (cell.fileDiffs?.length ?? 0) > 0;
}

function counts(additions: number, deletions: number): StyledTextSegment[] {
  return [
    { text: ' (', style: {} }, { text: '+' + additions, style: ADD },
    { text: ' ', style: {} }, { text: '-' + deletions, style: REMOVE }, { text: ')', style: {} },
  ];
}

/** Lightweight lexical colors; never interpret source as Markdown or terminal escapes. */
function sourceSegments(text: string, path: string): StyledTextSegment[] {
  const clean = stripControlSequences(text).replace(/\t/gu, '    ');
  if (!/\.(?:[cm]?[jt]sx?|json|py|rs|go|java|c|h|cpp|swift|sh)$/iu.test(path)) {
    return [{ text: clean, style: {} }];
  }
  const pattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*$|\b(?:const|let|var|function|return|if|else|for|while|class|interface|type|import|from|export|async|await|new|throw|try|catch|def|fn|pub|use|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b)/gu;
  const segments: StyledTextSegment[] = [];
  let cursor = 0;
  for (const match of clean.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) segments.push({ text: clean.slice(cursor, index), style: {} });
    const token = match[0];
    const style = token.startsWith('//') ? MUTED : /^["'`]/u.test(token) ? STRING
      : /^\d/u.test(token) ? NUMBER : KEYWORD;
    segments.push({ text: token, style });
    cursor = index + token.length;
  }
  if (cursor < clean.length) segments.push({ text: clean.slice(cursor), style: {} });
  return segments;
}

function diffRows(line: FileDiffLine, path: string, width: number, digits: number): StyledTextLine[] {
  const prefix = '    ' + String(line.line).padStart(digits) + ' ';
  const gutterWidth = displayWidth(prefix) + 2;
  const background = line.kind === 'add' ? TUI_COLORS.diffAddBg : TUI_COLORS.diffDelBg;
  const sign = line.kind === 'add' ? '+' : '-';
  const source = sourceSegments(line.text, path);
  const segments: StyledTextSegment[] = [
    { text: prefix, style: MUTED }, { text: sign + ' ', style: line.kind === 'add' ? ADD : REMOVE }, ...source,
  ];
  if (width <= gutterWidth + 1) {
    return wrapStyledSegments(segments, width).map((row) => ({ segments: row, background }));
  }
  const rows = wrapStyledSegments(source, width - gutterWidth).map((row, index) => ({
    segments: [
      ...(index === 0 ? segments.slice(0, 2) : [{ text: ' '.repeat(gutterWidth), style: MUTED }]), ...row,
    ], background,
  }));
  if (line.noNewline) rows.push(...wrapStyledSegments([
    { text: ' '.repeat(gutterWidth) + '\\ No newline at end of file', style: MUTED },
  ], width).map((row) => ({ segments: row, background })));
  return rows;
}

export function buildEditedLines(cells: readonly ExecCell[], width: number): StyledTextLine[] {
  const files = new Map<string, FileDiff>();
  for (const cell of cells) {
    for (const file of cell.fileDiffs ?? []) {
      const previous = files.get(file.path);
      files.set(file.path, previous === undefined ? file : {
        ...file, additions: previous.additions + file.additions, deletions: previous.deletions + file.deletions,
        lines: [...previous.lines, ...file.lines], truncated: previous.truncated || file.truncated,
        approximate: previous.approximate || file.approximate,
      });
    }
  }
  const expanded = cells.some((cell) => cell.expanded);
  const values = [...files.values()];
  const lines: StyledTextLine[] = [];
  const emit = (segments: StyledTextSegment[]): void => {
    lines.push(...wrapStyledSegments(segments, width).map((row) => ({ segments: row })));
  };
  emit([
    { text: '• ', style: MUTED }, { text: 'Edited ', style: { attrs: ATTR_BOLD } },
    { text: files.size + (files.size === 1 ? ' file' : ' files'), style: {} },
    ...counts(values.reduce((n, file) => n + file.additions, 0), values.reduce((n, file) => n + file.deletions, 0)),
  ]);
  values.forEach((file, index) => {
    if (index > 0) lines.push({ segments: [] });
    emit([{ text: '  └ ', style: MUTED },
      { text: stripControlSequences(file.path).replace(/[\n\t]/gu, ' '), style: {} },
      ...counts(file.additions, file.deletions)]);
    const digits = file.lines.reduce((max, line) => Math.max(max, String(line.line).length), 2);
    const rows = file.lines.flatMap((line) => diffRows(line, file.path, width, digits));
    lines.push(...(expanded ? rows : rows.slice(0, 3)));
    if (file.truncated) emit([{ text: '    … Diff preview truncated', style: MUTED }]);
    if (file.approximate) emit([{ text: '    … Large rewrite: changed region shown as replacement', style: MUTED }]);
    if (file.additions === 0 && file.deletions === 0) emit([{ text: '    No content changes', style: MUTED }]);
  });
  emit([{ text: expanded ? '    − Hide details (Ctrl+O)' : '    + Show details (Ctrl+O)', style: MUTED }]);
  return lines;
}
