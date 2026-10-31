import path from 'node:path';
import { z } from 'zod';
import { canonicalizePath, expandHome } from '../util/paths.js';
import { normalizeDomainPattern } from './domains.js';
import type { AdditionalPermissions } from './types.js';

const paths = z.array(z.string().min(1).max(4096).refine((s) => !/[\0\r\n*?]/u.test(s), 'Use literal paths, without wildcards.')).max(16);
const domain = z.string().min(1).refine((value) => {
  try { normalizeDomainPattern(value); return true; } catch { return false; }
}, 'Use an exact hostname, IP address, *.domain or **.domain, without a scheme or port.');
export const escalationFields = {
  sandbox_permissions: z.enum(['use_default', 'require_escalated']).optional(),
  justification: z.string().trim().min(1).max(2000).optional(),
  additional_permissions: z.object({
    filesystem: z.object({ read: paths.optional(), write: paths.optional() }).strict().optional(),
    network: z.object({ domains: z.array(domain).min(1).max(32) }).strict().optional(),
  }).strict().optional(),
  prefix_rule: z.array(z.string().min(1).max(4096)).min(1).max(32).optional(),
};

export async function canonicalPermissions(input: AdditionalPermissions, cwd: string, home: string): Promise<AdditionalPermissions> {
  const normalize = async (entries: string[] | undefined): Promise<string[]> =>
    [...new Set(await Promise.all((entries ?? []).map((entry) => canonicalizePath(path.resolve(cwd, expandHome(entry, home))))))];
  return {
    ...(input.filesystem === undefined ? {} : { filesystem: { read: await normalize(input.filesystem.read), write: await normalize(input.filesystem.write) } }),
    ...(input.network === undefined ? {} : { network: { domains: [...new Set(input.network.domains.map(normalizeDomainPattern))] } }),
  };
}

export function hasPermissions(input?: AdditionalPermissions): boolean {
  return !!(input?.filesystem?.read?.length || input?.filesystem?.write?.length || input?.network?.domains.length);
}
