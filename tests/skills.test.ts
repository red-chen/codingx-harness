import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPrompt } from '../src/agent/index.js';
import { buildChildEnv } from '../src/exec/index.js';
import { loadSkills, parseSkillDocument, SkillRegistry } from '../src/skills/index.js';
import {
  ReadFileTracker,
  ToolRegistry,
  createBuiltinTools,
  type ToolContext,
} from '../src/tools/index.js';

let root: string;

async function setup(): Promise<void> {
  root = await mkdtemp(path.join(os.tmpdir(), 'codingx-skills-'));
}

async function writeSkill(
  skillsRoot: string,
  directory: string,
  frontmatter: string,
  body = '# Body\n\nDo the thing.',
): Promise<string> {
  const target = path.join(skillsRoot, directory);
  await mkdir(target, { recursive: true });
  const file = path.join(target, 'SKILL.md');
  await writeFile(file, '---\n' + frontmatter + '\n---\n' + body + '\n', 'utf8');
  return file;
}

function context(cwd: string, skills: SkillRegistry): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    readTracker: new ReadFileTracker(),
    maxOutputChars: 30_000,
    shell: {
      env: buildChildEnv(['PATH', 'HOME'], { ...process.env, HOME: cwd }),
      timeoutMs: 5_000,
    },
    skills,
  };
}

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe('parseSkillDocument', () => {
  it('parses quoted and folded frontmatter, tolerates CRLF and a BOM', () => {
    const parsed = parseSkillDocument(
      '\uFEFF---\r\nname: "office-docx"\r\ndescription: >\r\n  Create and edit\r\n  Word documents.\r\n---\r\n\r\n# Steps\r\n\r\n1. Read.\r\n',
    );
    expect(parsed.fields).toMatchObject({
      name: 'office-docx',
      description: 'Create and edit Word documents.',
    });
    expect(parsed.body).toBe('# Steps\n\n1. Read.');
  });

  it('rejects unterminated frontmatter and accepts files without frontmatter', () => {
    expect(() => parseSkillDocument('---\nname: x\nbody')).toThrow(/Unterminated/);
    expect(parseSkillDocument('# Just markdown\n')).toEqual({
      fields: {},
      body: '# Just markdown',
    });
  });
});

describe('loadSkills', () => {
  it('loads global and project skills, with project definitions overriding global ones', async () => {
    await setup();
    const codingxHome = path.join(root, 'codingx-home');
    const projectRoot = path.join(root, 'project');
    await mkdir(projectRoot, { recursive: true });
    const globalRoot = path.join(codingxHome, 'skills');
    const projectSkills = path.join(projectRoot, '.codingx', 'skills');

    await writeSkill(globalRoot, 'global-one', 'name: global-one\ndescription: Global helper.');
    await writeSkill(globalRoot, 'shared', 'name: shared\ndescription: Global shared.', '# Global shared');
    await writeSkill(projectSkills, 'project-one', 'name: project-one\ndescription: Project helper.');
    await writeSkill(projectSkills, 'shared-dir', 'name: shared\ndescription: Project shared.', '# Project shared');

    const loaded = await loadSkills({ codingxHome, projectRoot, agentsSkillsDir: path.join(root, 'agents-skills') });
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toMatch(/Skill "shared".*overrides/);
    expect(loaded.registry.list().map((skill) => skill.name)).toEqual([
      'global-one',
      'project-one',
      'shared',
    ]);
    expect(loaded.registry.get('global-one')).toMatchObject({
      source: 'global',
      description: 'Global helper.',
      content: '# Body\n\nDo the thing.',
    });
    expect(loaded.registry.get('shared')).toMatchObject({
      source: 'project',
      content: '# Project shared',
    });
    const summaries = loaded.registry.summaries();
    expect(summaries.map((summary) => summary.name)).toEqual(['global-one', 'project-one', 'shared']);
    expect(summaries[0]).not.toHaveProperty('content');
  });

  it('loads shared agents skills and lets codingx and project skills override them', async () => {
    await setup();
    const codingxHome = path.join(root, 'codingx-home');
    const projectRoot = path.join(root, 'project');
    const agentsSkillsDir = path.join(root, 'home', '.agents', 'skills');
    const codingxSkills = path.join(codingxHome, 'skills');
    const projectSkills = path.join(projectRoot, '.codingx', 'skills');

    await writeSkill(agentsSkillsDir, 'agents-only', 'name: agents-only\ndescription: Shared helper.');
    await writeSkill(agentsSkillsDir, 'shared', 'name: shared\ndescription: From agents.', '# Agents');
    await writeSkill(codingxSkills, 'shared', 'name: shared\ndescription: From codingx.', '# Codingx');
    await writeSkill(projectSkills, 'shared', 'name: shared\ndescription: From project.', '# Project');

    const loaded = await loadSkills({ codingxHome, projectRoot, agentsSkillsDir });

    expect(loaded.registry.list().map((skill) => skill.name)).toEqual(['agents-only', 'shared']);
    expect(loaded.registry.get('agents-only')).toMatchObject({
      source: 'global',
      content: '# Body\n\nDo the thing.',
    });
    expect(loaded.registry.get('shared')).toMatchObject({
      source: 'project',
      content: '# Project',
    });
    const warnings = loaded.warnings.join('\n');
    expect(warnings.match(/"shared".*overrides/g)).toHaveLength(2);
  });

  it('warns about invalid, oversized and missing skill files without failing', async () => {
    await setup();
    const codingxHome = path.join(root, 'codingx-home');
    const projectRoot = path.join(root, 'project');
    const skillsRoot = path.join(codingxHome, 'skills');
    await mkdir(projectRoot, { recursive: true });

    await writeSkill(skillsRoot, 'no-description', 'name: no-description');
    await writeSkill(skillsRoot, 'bad-name', 'name: Bad Name\ndescription: Nope.');
    await writeSkill(skillsRoot, 'empty-body', 'name: empty-body\ndescription: Empty.', '');
    const broken = path.join(skillsRoot, 'broken', 'SKILL.md');
    await mkdir(path.dirname(broken), { recursive: true });
    await writeFile(broken, '---\nname: broken\ndescription: Broken\n', 'utf8');
    await writeSkill(skillsRoot, 'large', 'name: large\ndescription: Large.', 'x'.repeat(200));
    await mkdir(path.join(skillsRoot, 'no-file'), { recursive: true });

    const loaded = await loadSkills({ codingxHome, projectRoot, agentsSkillsDir: path.join(root, 'agents-skills'), maxSkillBytes: 100 });
    expect(loaded.registry.size).toBe(0);
    const warnings = loaded.warnings.join('\n');
    expect(warnings).toMatch(/no description/);
    expect(warnings).toMatch(/invalid name/);
    expect(warnings).toMatch(/empty body/);
    expect(warnings).toMatch(/Unterminated/);
    expect(warnings).toMatch(/limit is 100 bytes/);
  });

  it('returns an empty registry when no skill directories exist', async () => {
    await setup();
    const loaded = await loadSkills({ codingxHome: path.join(root, 'none'), projectRoot: root, agentsSkillsDir: path.join(root, 'agents-skills') });
    expect(loaded.registry.size).toBe(0);
    expect(loaded.warnings).toEqual([]);
  });
});

describe('skill catalog and tool', () => {
  it('adds a skills section to the system prompt only when skills exist', () => {
    const snapshot = {
      cwd: '/work',
      projectRoot: '/work',
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v20.0.0',
      agentsMd: { files: [], content: '', truncated: false },
      warnings: [],
    };
    const without = buildSystemPrompt(snapshot);
    expect(without).not.toContain('# Skills');
    const prompt = buildSystemPrompt(snapshot, {
      skills: [{ name: 'office-docx', description: 'Create Word documents.' }],
    });
    expect(prompt).toContain('# Skills');
    expect(prompt).toContain('- office-docx: Create Word documents.');
    expect(prompt).toContain('call the Skill tool');
  });

  it('loads the full body for a known skill and rejects unknown names', async () => {
    await setup();
    const codingxHome = path.join(root, 'codingx-home');
    const projectRoot = path.join(root, 'project');
    const file = await writeSkill(
      path.join(codingxHome, 'skills'),
      'docx',
      'name: docx\ndescription: Word helper.',
      '# Workflow\n\nUse the template.',
    );
    const loaded = await loadSkills({ codingxHome, projectRoot, agentsSkillsDir: path.join(root, 'agents-skills') });
    const registry = new ToolRegistry(createBuiltinTools());
    const ctx = context(projectRoot, loaded.registry);

    const result = await registry.execute('Skill', { name: 'docx' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Skill "docx" loaded from ' + file);
    expect(result.content).toContain('Base directory: ' + path.dirname(file));
    expect(result.content).toContain('# Workflow');
    expect(result.meta).toMatchObject({ skill: 'docx', path: file });

    const unknown = await registry.execute('Skill', { name: 'nope' }, ctx);
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toMatch(/Unknown skill "nope".*docx/);

    const disabled = await registry.execute('Skill', { name: 'docx' }, { ...ctx, skills: undefined });
    expect(disabled.isError).toBe(true);
    expect(disabled.content).toMatch(/not enabled/);
  });
});
