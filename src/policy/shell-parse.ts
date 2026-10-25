import os from 'node:os';
import path from 'node:path';
import { expandHome } from '../util/paths.js';
import type { ParsedShellCommand, ShellSegment } from './types.js';

const BACKTICK = '\u0060';

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function splitWords(piece: string): { words: string[]; parseError?: string; substitution: boolean; unsafe: boolean } {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let substitution = false;
  let unsafe = false;

  const push = (): void => {
    if (started) words.push(word);
    word = '';
    started = false;
  };

  for (let index = 0; index < piece.length; index += 1) {
    const char = piece[index] as string;
    if (escaped) {
      word += char;
      started = true;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') quote = null;
      else word += char;
      started = true;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      push();
      continue;
    }
    if (char === '\n') {
      push();
      continue;
    }
    if (char === '#' && !started) break;
    if (char === '(') {
      unsafe = true;
      word += char;
      started = true;
      continue;
    }
    if (char === '$' && piece[index + 1] === '(') {
      substitution = true;
      word += '$(';
      started = true;
      index += 1;
      continue;
    }
    word += char;
    started = true;
  }

  if (quote !== null) return { words, parseError: 'unterminated quote', substitution, unsafe };
  if (escaped) {
    word += '\\';
    started = true;
  }
  push();
  return { words, substitution, unsafe };
}

function buildSegment(words: string[], cwd: string, raw: string): ShellSegment | undefined {
  const redirects: ShellSegment['redirects'] = [];
  const commandWords: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    if (word === '>' || word === '>>' || word === '<') {
      const target = words[index + 1];
      if (target !== undefined) {
        redirects.push({ operator: word, path: target });
        index += 1;
      }
      continue;
    }
    const attached = /^([0-9]?>>?|<)(.+)$/.exec(word);
    if (attached && attached[2] !== undefined) {
      redirects.push({ operator: attached[1] === '<' ? '<' : attached[1] === '>>' ? '>>' : '>', path: attached[2] });
      continue;
    }
    commandWords.push(word);
  }
  while (commandWords.length > 0 && isAssignment(commandWords[0] as string)) commandWords.shift();
  const program = commandWords.shift();
  if (program === undefined || program.length === 0) return undefined;
  return { program, args: commandWords, cwd, redirects, raw };
}

/**
 * Conservative, dependency-free approximation of a POSIX shell tokenizer.
 * The goal is policy input, not execution: anything we cannot confidently
 * split (substitutions, heredocs, subshells) is marked unsafe and must be
 * approved or denied rather than treated as a simple command.
 */
export function parseShellCommand(command: string, initialCwd: string): ParsedShellCommand {
  const pieces: string[] = [];
  let piece = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let substitutionDepth = 0;
  let inBacktick = false;
  let unsafe = false;

  const endPiece = (): void => {
    if (piece.trim().length > 0) pieces.push(piece);
    piece = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    if (escaped) {
      piece += char;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      piece += char;
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      piece += char;
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') quote = null;
      continue;
    }
    if (char === '\\') {
      piece += char;
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      piece += char;
      quote = char;
      continue;
    }
    if (inBacktick) {
      piece += char;
      if (char === BACKTICK) inBacktick = false;
      continue;
    }
    if (substitutionDepth > 0) {
      piece += char;
      if (char === '(') substitutionDepth += 1;
      else if (char === ')') substitutionDepth -= 1;
      continue;
    }
    if (char === BACKTICK) {
      piece += char;
      inBacktick = true;
      unsafe = true;
      continue;
    }
    if (char === '$' && command[index + 1] === '(') {
      piece += '$(';
      substitutionDepth = 1;
      index += 1;
      unsafe = true;
      continue;
    }
    if (char === '|' || char === ';' || char === '\n') {
      endPiece();
      continue;
    }
    if (char === '&' && command[index + 1] === '&') {
      endPiece();
      index += 1;
      continue;
    }
    if (char === '|' && command[index + 1] === '|') {
      endPiece();
      index += 1;
      continue;
    }
    if (char === '>' || char === '<') {
      if (piece.length > 0 && !piece.endsWith(' ')) piece += ' ';
      piece += char;
      if (char === '>' && command[index + 1] === '>') {
        piece += '>';
        index += 1;
      }
      piece += ' ';
      continue;
    }
    piece += char;
  }

  const parseErrors: string[] = [];
  if (quote !== null) parseErrors.push('unterminated quote');
  if (substitutionDepth !== 0) parseErrors.push('unterminated $( substitution');
  if (inBacktick) parseErrors.push('unterminated backtick');
  endPiece();

  const segments: ShellSegment[] = [];
  let logicalCwd = path.resolve(initialCwd);
  for (const rawPiece of pieces) {
    const split = splitWords(rawPiece);
    if (split.parseError) parseErrors.push(split.parseError);
    if (split.substitution || split.unsafe) unsafe = true;
    const segmentCwd = logicalCwd;
    const segment = buildSegment(split.words, segmentCwd, rawPiece.trim());
    if (segment === undefined) continue;
    if (segment.program === 'cd' && segment.args.length > 0 && !segment.args[0]?.startsWith('-')) {
      const target = segment.args[0] as string;
      logicalCwd = path.resolve(segmentCwd, expandHome(target, os.homedir()));
    }
    segments.push(segment);
  }

  const hasHeredoc = command.includes('<<');
  return {
    segments,
    ...(parseErrors.length > 0 ? { parseError: parseErrors.join('; ') } : {}),
    hasSubstitution: unsafe,
    hasHeredoc,
    hasUnsafeConstruct: unsafe || hasHeredoc || parseErrors.length > 0,
  };
}
