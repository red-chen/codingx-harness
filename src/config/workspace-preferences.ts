import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { REASONING_EFFORTS } from '../providers/types.js';
import { canonicalizePath } from '../util/paths.js';
import { ConfigError } from '../util/errors.js';
import { legacyWorkspaceKey, workspaceDirectory } from '../util/workspace.js';
import type { WorkspaceModelPreference, WorkspacePreferences } from './types.js';

const modelSchema = z.object({
  model: z.string().trim().min(1),
  provider: z.string().min(1),
  route: z.string().min(1),
  reasoningEffort: z.enum([...REASONING_EFFORTS, 'default']),
}).strict();
const profileSchema = z.string().min(1);

/** Independent atomic files prevent model/profile changes from overwriting each other. */
export class WorkspacePreferencesStore {
  private constructor(public directory: string, readonly cwd: string, private readonly root: string) {}

  static async open(home: string, cwd: string): Promise<WorkspacePreferencesStore> {
    const canonical = await canonicalizePath(cwd);
    const root = path.join(home, 'workspaces');
    return new WorkspacePreferencesStore(await workspaceDirectory(root, canonical), canonical, root);
  }

  private async read<T>(name: string, schema: z.ZodType<T>, warnings: string[]): Promise<T | undefined> {
    try {
      this.directory = await workspaceDirectory(this.root, this.cwd);
      let text: string;
      try {
        text = await readFile(path.join(this.directory, name + '.json'), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        text = await readFile(path.join(this.root, await legacyWorkspaceKey(this.cwd), name + '.json'), 'utf8');
      }
      const value: unknown = JSON.parse(text);
      const parsed = z.object({ version: z.literal(1), cwd: z.literal(this.cwd), value: schema }).strict().safeParse(value);
      if (!parsed.success) throw new Error('invalid preferences');
      return parsed.data.value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        warnings.push('Could not read cwd ' + name + ' preferences; using configured defaults.');
      }
      return undefined;
    }
  }

  async load(warnings: string[] = []): Promise<WorkspacePreferences> {
    const model = await this.read('model', modelSchema, warnings);
    const permissionProfile = await this.read('permissions', profileSchema, warnings);
    return { ...(model ? { model } : {}), ...(permissionProfile ? { permissionProfile } : {}) };
  }

  private async write(name: string, value: unknown): Promise<void> {
    let target = path.join(this.directory, name + '.json');
    try {
      this.directory = await workspaceDirectory(this.root, this.cwd, true);
      target = path.join(this.directory, name + '.json');
    } catch (error) {
      throw new ConfigError('Could not save cwd ' + name + ' preferences to ' + target + '.', { cause: error });
    }
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify({ version: 1, cwd: this.cwd, value }) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } catch (error) {
      throw new ConfigError('Could not save cwd ' + name + ' preferences to ' + target + '.', { cause: error });
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async saveModel(value: WorkspaceModelPreference): Promise<void> {
    const parsed = modelSchema.safeParse(value);
    if (!parsed.success) throw new ConfigError('Invalid cwd model preferences.');
    await this.write('model', parsed.data);
  }

  async savePermissionProfile(profile: string): Promise<void> {
    const parsed = profileSchema.safeParse(profile);
    if (!parsed.success) throw new ConfigError('Invalid cwd permission profile.');
    await this.write('permissions', parsed.data);
  }
}
