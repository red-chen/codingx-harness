import { CodingxError } from '../util/errors.js';
import { networkMode } from '../policy/network.js';
import type { SandboxPolicy } from '../policy/types.js';
import { createSeatbeltBackend } from './seatbelt.js';
import type {
  SandboxBackend,
  SandboxBackendOptions,
  SandboxCapabilities,
  SandboxShellInvocation,
  SandboxStatus,
} from './types.js';

export { buildSeatbeltProfile, createSeatbeltBackend, SeatbeltBackend } from './seatbelt.js';
export type * from './types.js';

class NoneBackend implements SandboxBackend {
  readonly kind = 'none' as const;
  readonly capabilities: SandboxCapabilities = {
    fileSystem: 'none',
    network: 'none',
    unixSockets: false,
  };
  readonly status: SandboxStatus;

  constructor(platform: NodeJS.Platform) {
    // Linux is expected to gain Landlock in M3.4. Until then Shell is
    // unsandboxed but starts with an explicit warning; macOS/Windows/other
    // must fail closed rather than silently run without isolation.
    const required = platform !== 'linux';
    const reason =
      platform === 'linux'
        ? 'Linux Landlock/seccomp sandboxing (M3.4) is not implemented yet; Shell commands run with the user permissions.'
        : platform === 'win32'
          ? 'Windows sandboxing is not implemented; Shell commands cannot be isolated on this platform.'
          : 'No OS sandbox backend is available on this platform.';
    this.status = {
      kind: 'none',
      platform,
      available: false,
      required,
      capabilities: this.capabilities,
      reason,
      warnings: [reason],
    };
  }

  async available(): Promise<boolean> {
    return false;
  }

  wrapShell(_command: string, _policy: SandboxPolicy): SandboxShellInvocation {
    throw new CodingxError(
      'SANDBOX_UNAVAILABLE',
      this.status.reason ?? 'No OS sandbox backend is available.',
    );
  }
}

/**
 * Pick the backend for this host. macOS gets Seatbelt; other platforms are
 * explicit degraded modes until their backend milestone lands.
 */
export async function createSandboxBackend(options: SandboxBackendOptions = {}): Promise<SandboxBackend> {
  const platform = options.platform ?? process.platform;
  const backend: SandboxBackend =
    platform === 'darwin' ? createSeatbeltBackend({ ...options, platform }) : new NoneBackend(platform);
  await backend.available();
  return backend;
}

/** Prompt/UI projection of the active sandbox for the current profile. */
export function sandboxSummary(status: SandboxStatus, policy: SandboxPolicy): {
  kind: string;
  active: boolean;
  network: 'deny' | 'allow' | 'none' | 'local' | 'proxy';
  required: boolean;
  reason?: string;
} {
  const active = status.available && !policy.yolo;
  return {
    kind: status.kind,
    active,
    network: !active ? 'none' : networkMode(policy.network) !== 'none' && Object.keys(policy.network.domains).length > 0 ? 'proxy' : networkMode(policy.network) === 'local' ? 'local' : networkMode(policy.network) === 'all' ? 'allow' : 'deny',
    required: status.required,
    ...(active ? {} : { reason: status.reason ?? 'the selected profile disables OS sandboxing' }),
  };
}
