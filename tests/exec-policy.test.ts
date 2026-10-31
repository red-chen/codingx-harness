import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseRules, checkExecRules, loadExecRules } from '../src/policy/rules/index.js';
import { parseShellCommand } from '../src/policy/shell-parse.js';
import { createPolicyRuntime, parsePermissions } from '../src/policy/index.js';
import { SessionGrants, approvalPrefixFor } from '../src/policy/grants.js';
import { loadConfig } from '../src/config/index.js';
import { runCli } from '../src/cli/index.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'codingx-rules-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('data-only exec rules', () => {
  it('supports alternatives, comments, trailing commas and executable examples', () => {
    const rules = parseRules(`# comment
prefix_rule(pattern = ['git', ['status', 'diff']], decision = 'allow',
  match = ['git status --short', ['git', 'diff']], not_match = ['git push'],)
prefix_rule(pattern = ['git', 'push'], decision = 'prompt', justification = 'Remote write')`);
    const check = (command: string) => checkExecRules(rules, parseShellCommand(command, root));
    expect(check('git status --short').decision).toBe('allow');
    expect(check('git status && git diff').decision).toBe('allow');
    expect(check('git push').decision).toBe('prompt');
    expect(check('git status-extra').decision).toBe('none');
    expect(check('git status && curl https://example.com').decision).toBe('none');
    for (const command of ['git status > out', 'PATH=/tmp git status', 'git status "$X"', 'git status $(pwd)', 'git status *']) {
      expect(check(command).decision).not.toBe('allow');
    }
  });

  it('rejects executable syntax, malformed rules and failing examples', () => {
    for (const text of ["import os", "prefix_rule(pattern=['git'], decision='oops')", "prefix_rule(pattern=['git'], unknown='x')",
      "prefix_rule(pattern=['git'], match=['npm test'])", "prefix_rule(pattern=['git'], not_match=['git status'])",
      "prefix_rule(pattern=fn())", "prefix_rule(pattern=['git'], pattern=['npm'])", "prefix_rule(pattern=['git'",
      "prefix_rule(pattern=['git'], justification='unterminated)"]) {
      expect(() => parseRules(text, 'bad.rules')).toThrow(/bad.rules/);
    }
  });

  it('gives forbidden precedence over prompt and allow, including compound commands', async () => {
    const rules = parseRules(`prefix_rule(pattern=['git'], decision='allow')
prefix_rule(pattern=['git','push'], decision='prompt')
prefix_rule(pattern=['git','push','--force'], decision='forbidden')`);
    expect(checkExecRules(rules, parseShellCommand('git status; git push --force', root)).decision).toBe('forbidden');
    const runtime = await createPolicyRuntime({ cwd: root, env: { HOME: root }, additionalDirs: [],
      config: parsePermissions({}, ':danger-full-access'), approvalPolicy: 'never', reviewer: 'user', execRules: rules });
    expect(await runtime.evaluate('Shell', { command: 'git push --force' })).toMatchObject({ verdict: 'deny', code: 'POLICY_FORBIDDEN' });
    expect(await runtime.evaluate('Shell', { command: 'git push' })).toMatchObject({ verdict: 'deny' });
  });

  it('does not let allow rules widen filesystem or network permissions', async () => {
    const runtime = await createPolicyRuntime({ cwd: root, env: { HOME: root }, additionalDirs: [],
      config: parsePermissions({}, ':read-only'), approvalPolicy: 'on-request', reviewer: 'user',
      execRules: parseRules("prefix_rule(pattern=['curl'],decision='allow')\nprefix_rule(pattern=['printf'],decision='allow')") });
    expect((await runtime.evaluate('Shell', { command: 'curl https://example.com' })).verdict).toBe('ask');
    expect((await runtime.evaluate('Shell', { command: 'printf hi > ./out' })).verdict).toBe('ask');
  });

  it('loads global rules and rejects project rule overrides; errors are fail closed', async () => {
    const home = path.join(root, 'home'); const cwd = path.join(root, 'project');
    await mkdir(path.join(home, 'rules'), { recursive: true });
    await mkdir(path.join(cwd, '.codingx'), { recursive: true });
    await writeFile(path.join(home, 'rules', 'default.rules'), "prefix_rule(pattern=['git','push'],decision='forbidden')");
    await writeFile(path.join(home, 'extra.rules'), "prefix_rule(pattern=['npm','test'],decision='allow')");
    await writeFile(path.join(home, 'config.toml'), '[exec_policy]\nrule_files=["extra.rules"]');
    await writeFile(path.join(cwd, '.codingx', 'config.toml'), '[exec_policy]\nrule_files=["does-not-exist.rules"]');
    const loaded = await loadConfig({ cwd, codingxHome: home, env: {} });
    expect(loaded.config.execRules).toHaveLength(2);
    expect(loaded.warnings.join(' ')).toContain('exec_policy');
    await expect(loadExecRules(home, [path.join(home, 'missing.rules')])).rejects.toThrow(/Cannot load/);
    await writeFile(path.join(home, 'rules', 'broken.rules'), 'import os');
    await expect(loadConfig({ cwd, codingxHome: home, env: {} })).rejects.toThrow(/Expected prefix_rule/);
  });

  it('diagnoses argv and shell commands through CLI without provider credentials', async () => {
    await mkdir(path.join(root, 'rules'));
    await writeFile(path.join(root, 'rules', 'default.rules'), "prefix_rule(pattern=['git','push'],decision='forbidden')");
    let output = '';
    const io = { stdout: { write: (s: string) => { output += s; } }, stderr: { write: (_s: string) => {} }, env: { CODINGX_HOME: root } };
    expect(await runCli(['execpolicy', 'check', '--', 'git', 'push', '--force'], io)).toBe(1);
    expect(JSON.parse(output).decision).toBe('forbidden');
    output = '';
    expect(await runCli(['execpolicy', 'check', '--command', 'git status; git push'], io)).toBe(1);
    expect(JSON.parse(output).matches).toHaveLength(1);
  });

  it('validates proposed prefixes and never reuses grants for scoped escalation', async () => {
    const runtime = await createPolicyRuntime({ cwd: root, env: {}, additionalDirs: [], config: parsePermissions({}, ':workspace'), approvalPolicy: 'on-request', reviewer: 'user' });
    const decision = await runtime.evaluate('Shell', { command: 'npm test -- --run', prefix_rule: ['npm', 'test'] });
    expect(approvalPrefixFor(decision.action, root)).toEqual(['npm', 'test']);
    const grants = new SessionGrants(root);
    expect(grants.grant(decision.action, 'prefix')).toBe(true);
    expect(grants.permits({ ...decision.action, command: 'npm test -- other' })).toBe(true);
    expect(grants.permits({ ...decision.action, command: 'PATH=/tmp npm test' })).toBe(false);
    expect(grants.permits({ ...decision.action, additionalPermissions: { filesystem: { write: ['/tmp'] } } })).toBe(false);
    expect((await runtime.evaluate('Shell', { command: 'npm test; echo hi', prefix_rule: ['npm'] })).verdict).toBe('deny');
  });
});
