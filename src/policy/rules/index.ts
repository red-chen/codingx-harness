import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../../util/errors.js';
import { parseShellCommand } from '../shell-parse.js';
import type { ExecRule, ParsedShellCommand } from '../types.js';

const token = z.string().min(1).max(4096);
const example = z.union([token, z.array(token).min(1)]);
const schema = z.object({
  pattern: z.array(z.union([token, z.array(token).min(1)])).min(1),
  decision: z.enum(['allow', 'prompt', 'forbidden']).default('allow'),
  justification: z.string().optional(),
  match: z.array(example).optional(),
  not_match: z.array(example).optional(),
}).strict();

/** Data-only parser: calls, imports, variables and expressions are never evaluated. */
export function parseRules(text: string, source = '<rules>'): ExecRule[] {
  if (text.length > 1_000_000) throw new ConfigError(source + ': rules file exceeds 1 MB.');
  let offset = 0;
  const fail = (message: string): never => { throw new ConfigError(source + ':' + (text.slice(0, offset).split('\n').length) + ': ' + message); };
  const skip = (): void => {
    for (;;) {
      const match = /^(?:\s+|#[^\n]*)/.exec(text.slice(offset));
      if (!match) return;
      offset += match[0].length;
    }
  };
  const take = (expected: string): void => {
    skip();
    if (!text.startsWith(expected, offset)) fail('Expected ' + expected);
    offset += expected.length;
  };
  const value = (depth = 0): unknown => {
    if (depth > 3) fail('Literal nesting is too deep.');
    skip();
    const quote = text[offset];
    if (quote === '"' || quote === "'") {
      offset++;
      let result = '';
      while (offset < text.length) {
        const char = text[offset++]!;
        if (char === quote) return result;
        if (char === '\n' || char === '\r') fail('Newline in string.');
        if (char !== '\\') { result += char; continue; }
        const escaped = text[offset++];
        const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'" };
        if (escaped === undefined || escapes[escaped] === undefined) fail('Unsupported string escape.');
        result += escapes[escaped!];
      }
      return fail('Unterminated string.');
    }
    if (quote === '[') {
      offset++;
      const items: unknown[] = [];
      skip();
      while (text[offset] !== ']') {
        items.push(value(depth + 1));
        skip();
        if (text[offset] === ']') break;
        take(','); skip();
      }
      take(']');
      return items;
    }
    return fail('Only string and list literals are supported.');
  };
  const rules: ExecRule[] = [];
  skip();
  while (offset < text.length) {
    take('prefix_rule'); take('(');
    const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    skip();
    while (text[offset] !== ')') {
      const key = /^[a-z_]+/.exec(text.slice(offset))?.[0];
      if (!key) fail('Expected keyword argument.');
      offset += key!.length;
      if (Object.hasOwn(fields, key!)) fail('Duplicate argument: ' + key);
      take('='); fields[key!] = value(); skip();
      if (text[offset] === ')') break;
      take(','); skip();
    }
    take(')');
    const checked = schema.safeParse(fields);
    if (!checked.success) fail(checked.error.message);
    const rule: ExecRule = { ...checked.data!, source };
    for (const [examples, expected] of [[rule.match, true], [rule.not_match, false]] as const) {
      for (const input of examples ?? []) {
        const parsed = typeof input === 'string' ? parseShellCommand(input, '/') : undefined;
        if (parsed && (parsed.hasUnsafeConstruct || parsed.segments.length !== 1 || parsed.segments[0]!.redirects.length)) fail('Rule example must be a simple command.');
        const argv = typeof input === 'string' ? [parsed!.segments[0]!.program, ...parsed!.segments[0]!.args] : input;
        if (matchesPrefix(rule.pattern, argv) !== expected) fail('Rule example failed: ' + JSON.stringify(input));
      }
    }
    rules.push(rule); skip();
  }
  return rules;
}

export function matchesPrefix(pattern: ExecRule['pattern'], argv: readonly string[]): boolean {
  return argv.length >= pattern.length && pattern.every((part, index) =>
    typeof part === 'string' ? argv[index] === part : part.includes(argv[index]!));
}

export interface RuleCheck {
  decision: 'allow' | 'prompt' | 'forbidden' | 'none';
  matches: ExecRule[];
  unsafe: boolean;
}

export function checkExecRules(rules: readonly ExecRule[], parsed: ParsedShellCommand): RuleCheck {
  // Redirections, assignments and expansion cannot gain an allow from argv matching.
  const unsafe = parsed.hasUnsafeConstruct || parsed.segments.some((s) =>
    s.redirects.length > 0 || /(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=|[$*?{}~]/u.test(s.raw));
  const matches: ExecRule[] = [];
  let everySegmentAllowed = parsed.segments.length > 0 && !unsafe;
  for (const segment of parsed.segments) {
    const found = rules.filter((rule) => matchesPrefix(rule.pattern, [segment.program, ...segment.args]));
    matches.push(...found);
    if (!found.some((rule) => rule.decision === 'allow')) everySegmentAllowed = false;
  }
  const decision = matches.some((r) => r.decision === 'forbidden') ? 'forbidden'
    : matches.some((r) => r.decision === 'prompt') ? 'prompt'
      : everySegmentAllowed ? 'allow' : 'none';
  return { decision, matches: [...new Set(matches)], unsafe };
}

export async function loadExecRules(home: string, files: readonly string[] = []): Promise<ExecRule[]> {
  const directory = path.join(home, 'rules');
  let defaults: string[] = [];
  try { defaults = (await readdir(directory)).filter((name) => name.endsWith('.rules')).sort().map((name) => path.join(directory, name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigError('Cannot read rules directory.', { cause: error }); }
  return loadRuleFiles([...defaults, ...files]);
}

export async function loadRuleFiles(files: readonly string[]): Promise<ExecRule[]> {
  const rules: ExecRule[] = [];
  for (const file of new Set(files)) {
    try { rules.push(...parseRules(await readFile(file, 'utf8'), file)); }
    catch (error) { if (error instanceof ConfigError) throw error; throw new ConfigError('Cannot load exec policy: ' + file, { cause: error }); }
  }
  return rules;
}
