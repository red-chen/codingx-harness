import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodingxError } from '../util/errors.js';

export interface MockPlayground {
  root: string;
  home: string;
  workspace: string;
}

/** Refuse existing destinations so local config and files cannot be overwritten. */
export async function createMockPlayground(directory: string, endpoint: string): Promise<MockPlayground> {
  const root = path.resolve(directory);
  try { await mkdir(root); }
  catch (cause) { throw new CodingxError('CONFIG_ERROR', '--init needs a new directory with an existing parent.', { cause }); }
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await mkdir(home);
  await mkdir(path.join(workspace, '.codingx', 'skills', 'mock-check'), { recursive: true });
  await writeFile(path.join(home, 'config.toml'), `[provider.mock]
protocol = "anthropic-messages"
endpoint = ${JSON.stringify(endpoint)}
api_key_env = "MOCK_LLM_API_KEY"

[model]
route = "default"
max_output_tokens = 4096

[agent]
max_steps = 16
max_parallel_tools = 4

[routes.default]
max_attempts = 3

[[routes.default.targets]]
provider = "mock"
model = "mock"

[sessiond]
enabled = false
`);
  await writeFile(path.join(workspace, 'AGENTS.md'), '# Mock workspace\nThis disposable workspace is for deterministic codingx validation.\n');
  await writeFile(path.join(workspace, '.codingx', 'skills', 'mock-check', 'SKILL.md'), '---\nname: mock-check\ndescription: Verify mock skill loading.\n---\nMOCK_SKILL_READY\n');
  await writeFile(path.join(workspace, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZ8AAAAASUVORK5CYII=', 'base64'));
  return { root, home, workspace };
}
