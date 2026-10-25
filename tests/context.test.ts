import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildModelRequest,
  buildSystemPrompt,
  createContextSnapshot,
  estimateRequestTokens,
  mergeConsecutiveUserMessages,
  type ContextSnapshot,
} from '../src/agent/index.js';

let root: string;
let cwd: string;

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codingx-context-'));
  cwd = path.join(root, 'workspace');
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    cwd: '/work/repo',
    projectRoot: '/work/repo',
    platform: 'darwin',
    arch: 'arm64',
    nodeVersion: 'v24.0.0',
    agentsMd: { files: [], content: '', truncated: false },
    warnings: [],
    ...overrides,
  };
}

describe('createContextSnapshot', () => {
  it('captures cwd, platform and shell without requiring a git repository', async () => {
    const result = await createContextSnapshot({ cwd, env: { SHELL: '/bin/zsh' } });
    expect(result.cwd).toBe(cwd);
    expect(result.projectRoot).toBe(cwd);
    expect(result.platform).toBe(process.platform);
    expect(result.arch).toBe(os.arch());
    expect(result.nodeVersion).toBe(process.version);
    expect(result.shell).toBe('/bin/zsh');
    expect(result.git).toBeUndefined();
    expect(result.agentsMd).toEqual({ files: [], content: '', truncated: false });
  });

  it('loads AGENTS.md and CODINGX.md from the project root to the current directory', async () => {
    const project = path.join(root, 'project');
    const deeper = path.join(project, 'src', 'feature');
    await mkdir(path.join(project, '.git'), { recursive: true });
    await mkdir(deeper, { recursive: true });
    await writeFile(path.join(project, 'AGENTS.md'), '# Root rules\nUse pnpm.');
    await writeFile(path.join(project, 'src', 'AGENTS.md'), '## Source rules\nKeep ESM.');
    await writeFile(path.join(project, 'src', 'feature', 'CODINGX.md'), 'Feature note.');

    const result = await createContextSnapshot({ cwd: deeper, env: {} });
    expect(result.projectRoot).toBe(project);
    expect(result.agentsMd.files).toEqual(['AGENTS.md', 'src/AGENTS.md', 'src/feature/CODINGX.md']);
    expect(result.agentsMd.content).toContain('Root rules');
    expect(result.agentsMd.content).toContain('Source rules');
    expect(result.agentsMd.content).toContain('Feature note');
    expect(result.agentsMd.content.indexOf('Root rules')).toBeLessThan(result.agentsMd.content.indexOf('Source rules'));
    expect(result.agentsMd.content.indexOf('Source rules')).toBeLessThan(
      result.agentsMd.content.indexOf('Feature note'),
    );
    expect(result.git).toBeUndefined();
  });

  it('loads both AGENTS.md and CODINGX.md at the same level', async () => {
    await writeFile(path.join(cwd, 'AGENTS.md'), 'agents rules');
    await writeFile(path.join(cwd, 'CODINGX.md'), 'codingx rules');
    const result = await createContextSnapshot({ cwd, env: {} });
    expect(result.agentsMd.files).toEqual(['AGENTS.md', 'CODINGX.md']);
    expect(result.agentsMd.content).toContain('agents rules');
    expect(result.agentsMd.content).toContain('codingx rules');
  });

  it('truncates oversized project instructions and records a warning', async () => {
    await writeFile(path.join(cwd, 'AGENTS.md'), 'a'.repeat(50_000));
    const result = await createContextSnapshot({ cwd, env: {}, maxAgentsTokens: 100 });
    expect(result.agentsMd.truncated).toBe(true);
    expect(result.agentsMd.content).toContain('project instructions truncated');
    expect(result.agentsMd.content.length).toBeLessThan(10_000);
    expect(result.warnings.join('\n')).toMatch(/exceeded 100 tokens/);
  });

  it.skipIf(!gitAvailable)('captures git branch and dirty state', async () => {
    execFileSync('git', ['init', '-q'], { cwd });
    await writeFile(path.join(cwd, 'tracked.txt'), 'hello');
    const result = await createContextSnapshot({ cwd, env: {} });
    expect(result.projectRoot).toBe(cwd);
    expect(result.git).toBeDefined();
    expect(result.git?.branch.length).toBeGreaterThan(0);
    expect(result.git?.dirty).toBe(true);
    expect(result.git?.root).toBe(cwd);
  });
});

describe('buildSystemPrompt', () => {
  it('injects environment, project instructions and safety guidance', () => {
    const prompt = buildSystemPrompt(
      snapshot({
        git: { branch: 'main', dirty: false, root: '/work/repo' },
        shell: '/bin/bash',
        agentsMd: { files: ['AGENTS.md'], content: 'Use pnpm.', truncated: false },
      }),
    );
    expect(prompt).toContain('You are codingx');
    expect(prompt).toContain('# Environment');
    expect(prompt).toContain('- cwd: /work/repo');
    expect(prompt).toContain('- platform: darwin (arm64)');
    expect(prompt).toContain('- shell: /bin/bash');
    expect(prompt).toContain('- git branch: main');
    expect(prompt).toContain('- git status: clean');
    expect(prompt).toContain('Use pnpm.');
    expect(prompt).toContain('Tool output');
    expect(prompt).toContain('untrusted data');
    expect(prompt).toContain('ReadFile before editing');
    expect(prompt).toContain('# Project instructions');
  });

  it('lists additional writable directories when provided', () => {
    const plain = buildSystemPrompt(snapshot());
    expect(plain).toContain('File tools are confined to the workspace');
    expect(plain).not.toContain('additional writable directories');

    const prompt = buildSystemPrompt(snapshot(), { additionalDirs: ['/work/shared', '/tmp/output'] });
    expect(prompt).toContain('additional writable directories');
    expect(prompt).toContain('  - /work/shared');
    expect(prompt).toContain('  - /tmp/output');
    expect(prompt).not.toContain('File tools are confined to the workspace');
  });

  it('renders missing optional values explicitly and deterministically', () => {
    const first = buildSystemPrompt(snapshot());
    const second = buildSystemPrompt(snapshot());
    expect(first).toBe(second);
    expect(first).toContain('- git: not a repository');
    expect(first).toContain('(no AGENTS.md or CODINGX.md found)');
  });

  it('marks dirty repositories and missing project instructions', () => {
    const prompt = buildSystemPrompt(
      snapshot({ git: { branch: 'feature/x', dirty: true, root: '/work/repo' } }),
    );
    expect(prompt).toContain('- git status: uncommitted changes present');
    expect(prompt).toContain('(no AGENTS.md or CODINGX.md found)');
  });
});

describe('buildModelRequest', () => {
  it('assembles a provider request without mutating the history array', () => {
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }];
    const tools = [
      { name: 'ReadFile', description: 'read', inputSchema: { type: 'object' } },
    ];
    const request = buildModelRequest({
      model: 'model-a',
      system: 'system prompt',
      messages,
      tools,
      maxOutputTokens: 4096,
      temperature: 0,
      reasoningEffort: 'high',
      sessionId: 'session-1',
    });
    expect(request).toMatchObject({
      model: 'model-a',
      system: 'system prompt',
      maxOutputTokens: 4096,
      temperature: 0,
      reasoningEffort: 'high',
      sessionId: 'session-1',
    });
    expect(request.messages).toEqual(messages);
    expect(request.messages).not.toBe(messages);
    expect(request.tools).toEqual(tools);
    expect(estimateRequestTokens(request)).toBeGreaterThan(0);
  });

it('merges consecutive user messages without mutating saved history', () => {
    const first = { role: 'user' as const, content: [{ type: 'text' as const, text: 'first' }] };
    const second = {
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: 'c1', content: 'ok' }],
    };
    const third = { role: 'user' as const, content: [{ type: 'text' as const, text: 'next' }] };
    const merged = mergeConsecutiveUserMessages([first, { role: 'assistant', content: [] }, second, third]);
    expect(merged).toHaveLength(3);
    expect(merged[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
      { type: 'text', text: 'next' },
    ]);
    expect(first.content).toEqual([{ type: 'text', text: 'first' }]);
    expect(third.content).toEqual([{ type: 'text', text: 'next' }]);
  });

  it('omits optional temperature and sessionId', () => {
    const request = buildModelRequest({
      model: 'm',
      system: 's',
      messages: [],
      tools: [],
      maxOutputTokens: 1,
    });
    expect(request).not.toHaveProperty('temperature');
    expect(request).not.toHaveProperty('reasoningEffort');
    expect(request).not.toHaveProperty('sessionId');
  });
});