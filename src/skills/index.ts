import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Skills are local instruction packs. Each skill lives in its own directory
 * with a SKILL.md whose YAML-ish frontmatter declares a name and a one-line
 * description. Only the catalog is sent to the model up front; the full body
 * is loaded on demand through the skill tool.
 */

export type SkillSource = 'global' | 'project';

export interface Skill {
  readonly name: string;
  readonly description: string;
  /** Markdown body after the frontmatter, trimmed. */
  readonly content: string;
  /** Absolute path to the SKILL.md file. */
  readonly filePath: string;
  /** Absolute skill directory; relative references in the body resolve here. */
  readonly directory: string;
  readonly source: SkillSource;
}

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
}

export interface LoadSkillsOptions {
  /** Per-user codingx home, normally ~/.codingx. */
  codingxHome: string;
  /** Git root (or cwd outside a repository). */
  projectRoot: string;
  /** Shared user skill directory, normally ~/.agents/skills. */
  agentsSkillsDir?: string;
  /** Skill files larger than this are skipped. Defaults to 256 KiB. */
  maxSkillBytes?: number;
}

export interface LoadedSkills {
  registry: SkillRegistry;
  warnings: string[];
}

export interface ParsedSkillDocument {
  fields: Record<string, string>;
  body: string;
}

const DEFAULT_MAX_SKILL_BYTES = 256 * 1024;
const MAX_DESCRIPTION_CHARS = 2_000;
const SUMMARY_DESCRIPTION_CHARS = 300;
const SKILL_FILE_NAME = 'SKILL.md';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const KEY_RE = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/u;
const INDENT_RE = /^[ \t]+/u;

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    const inner = value.slice(1, -1);
    if (first === "'") return inner.replaceAll("''", "'");
    return inner.replace(/\\(["\\])/gu, '$1').replaceAll('\\n', '\n');
  }
  return value;
}

function isBlockMarker(value: string): boolean {
  return value === '|' || value === '>' || value === '|-' || value === '>-' || value === '|+' || value === '>+';
}

function parseFields(lines: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    const match = KEY_RE.exec(line);
    if (match === null) continue;
    const key = match[1];
    if (key === undefined) continue;
    let value = (match[2] ?? '').trim();

    if (isBlockMarker(value)) {
      const block: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? '';
        if (next.trim().length === 0) {
          block.push('');
          index += 1;
          continue;
        }
        if (!INDENT_RE.test(next)) break;
        block.push(next.replace(/^[ \t]{1,4}/u, ''));
        index += 1;
      }
      while (block.length > 0 && block[block.length - 1] === '') block.pop();
      value = value.startsWith('>') ? block.join(' ').replace(/\s+/gu, ' ').trim() : block.join('\n');
    } else {
      value = unquote(value);
    }

    if (value.length > 0) fields[key] = value;
  }
  return fields;
}

/**
 * Split a SKILL.md into frontmatter fields and body. Files without frontmatter
 * are accepted but yield no metadata, which the loader treats as invalid.
 */
export function parseSkillDocument(text: string): ParsedSkillDocument {
  const normalized = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return { fields: {}, body: normalized.trim() };

  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() === '---') {
      closing = index;
      break;
    }
  }
  if (closing < 0) throw new Error('Unterminated YAML frontmatter.');
  return {
    fields: parseFields(lines.slice(1, closing)),
    body: lines.slice(closing + 1).join('\n').trim(),
  };
}

function summaryDescription(text: string): string {
  const single = text.replace(/\s+/gu, ' ').trim();
  if (single.length <= SUMMARY_DESCRIPTION_CHARS) return single;
  return single.slice(0, SUMMARY_DESCRIPTION_CHARS - 1) + '…';
}

/** Read-only, name-indexed view of the skills available in a session. */
export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  constructor(skills: Iterable<Skill> = []) {
    for (const skill of skills) this.skills.set(skill.name, skill);
  }

  get size(): number {
    return this.skills.size;
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  list(): Skill[] {
    return [...this.skills.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  /** One-line catalog entries for the system prompt; never includes bodies. */
  summaries(): SkillSummary[] {
    return this.list().map((skill) => ({
      name: skill.name,
      description: summaryDescription(skill.description),
    }));
  }
}

async function readSkillDirectory(
  root: string,
  source: SkillSource,
  found: Map<string, Skill>,
  warnings: string[],
  maxSkillBytes: number,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    warnings.push('Cannot read skills directory ' + root + ': ' + (error instanceof Error ? error.message : String(error)));
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const filePath = path.join(directory, SKILL_FILE_NAME);
    let size: number;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      size = info.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      warnings.push('Cannot read ' + filePath + ': ' + (error instanceof Error ? error.message : String(error)));
      continue;
    }
    if (size > maxSkillBytes) {
      warnings.push(
        'Skill file ' + filePath + ' is ' + size + ' bytes; the limit is ' + maxSkillBytes + ' bytes. It was skipped.',
      );
      continue;
    }

    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      warnings.push('Cannot read ' + filePath + ': ' + (error instanceof Error ? error.message : String(error)));
      continue;
    }

    let parsed: ParsedSkillDocument;
    try {
      parsed = parseSkillDocument(text);
    } catch (error) {
      warnings.push('Invalid skill ' + filePath + ': ' + (error instanceof Error ? error.message : String(error)));
      continue;
    }

    const name = (parsed.fields.name ?? entry.name).trim();
    const description = (parsed.fields.description ?? '').trim();
    if (!NAME_RE.test(name)) {
      warnings.push(
        'Skill ' + filePath + ' has an invalid name "' + name + '"; use letters, digits, dots, underscores or dashes.',
      );
      continue;
    }
    if (description.length === 0) {
      warnings.push('Skill ' + filePath + ' has no description; add a one-line description to its frontmatter.');
      continue;
    }
    if (parsed.body.length === 0) {
      warnings.push('Skill ' + filePath + ' has an empty body.');
      continue;
    }

    const skill: Skill = {
      name,
      description: description.slice(0, MAX_DESCRIPTION_CHARS),
      content: parsed.body,
      filePath,
      directory,
      source,
    };
    const existing = found.get(name);
    if (existing !== undefined) {
      warnings.push(
        'Skill "' + name + '" from ' + filePath + ' overrides ' + existing.filePath + '.',
      );
    }
    found.set(name, skill);
  }
}

/**
 * Load shared (~/.agents/skills), app-global (~/.codingx/skills) then project
 * (<root>/.codingx/skills) skills. Later roots override earlier ones with the
 * same name, so project skills win over both user-level directories and
 * codingx-specific skills win over shared agents skills. Missing directories
 * are not an error; unreadable or invalid entries become warnings.
 */
export async function loadSkills(options: LoadSkillsOptions): Promise<LoadedSkills> {
  const maxSkillBytes = options.maxSkillBytes ?? DEFAULT_MAX_SKILL_BYTES;
  const warnings: string[] = [];
  const found = new Map<string, Skill>();
  const agentsSkillsDir = options.agentsSkillsDir ?? path.join(os.homedir(), '.agents', 'skills');

  await readSkillDirectory(agentsSkillsDir, 'global', found, warnings, maxSkillBytes);
  await readSkillDirectory(
    path.join(options.codingxHome, 'skills'),
    'global',
    found,
    warnings,
    maxSkillBytes,
  );
  await readSkillDirectory(
    path.join(options.projectRoot, '.codingx', 'skills'),
    'project',
    found,
    warnings,
    maxSkillBytes,
  );

  return { registry: new SkillRegistry(found.values()), warnings };
}
