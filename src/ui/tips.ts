import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { stripControlSequences } from '../tui/text/index.js';

export interface TipsConfig {
  readonly enabled: boolean;
  readonly tips: readonly string[];
}

export interface LoadedTips {
  readonly config: TipsConfig;
  readonly warnings: readonly string[];
}

export const DEFAULT_TIPS: readonly string[] = [
  'Use /model to choose a model and reasoning effort.',
  'Press Ctrl+R to search your input history.',
  'Use /help to see available commands and keyboard shortcuts.',
  'Start a prompt with ! to run a local shell command.',
  'Use /copy last to copy the latest assistant response.',
  'Use /clear to start fresh while keeping your input history.',
  '深度 Review 当前修改，关注功能正确性、是否有性能问题、是否破坏既有功能的正确性。注意：Review 一定要基于当前真实存在的场景，不要构造不存在的或极低概率的场景。',
  'Edit tips.json in CODINGX_HOME to customize these tips.',
];

const defaults: TipsConfig = { enabled: true, tips: DEFAULT_TIPS };
const schema = z.object({
  enabled: z.boolean().default(true),
  tips: z.array(z.string()).default([...DEFAULT_TIPS]),
}).strict();

/** Global UI preferences; never written to the session or sent to the model. */
export async function loadTips(codingxHome: string): Promise<LoadedTips> {
  const filename = path.join(codingxHome, 'tips.json');
  try {
    return { config: schema.parse(JSON.parse(await readFile(filename, 'utf8'))), warnings: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { config: defaults, warnings: ['Could not read tips.json; using default tips.'] };
    }
  }
  try {
    await mkdir(codingxHome, { recursive: true, mode: 0o700 });
    await writeFile(filename, JSON.stringify(defaults, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { config: defaults, warnings: [] };
  } catch (error) {
    // Another startup or the user may have created the file in the meantime.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        return { config: schema.parse(JSON.parse(await readFile(filename, 'utf8'))), warnings: [] };
      } catch {
        return { config: defaults, warnings: ['Could not read tips.json; using default tips.'] };
      }
    }
    return { config: defaults, warnings: ['Could not create tips.json; using default tips.'] };
  }
}

/** Select once per TUI launch so redraws and scrolling keep the same content. */
export function selectTip(config: TipsConfig, random: () => number = Math.random): string | undefined {
  if (!config.enabled) return undefined;
  const tips = config.tips.map((tip) => stripControlSequences(tip).replace(/\s+/gu, ' ').trim()).filter(Boolean);
  if (tips.length === 0) return undefined;
  return tips[Math.floor(random() * tips.length)];
}
