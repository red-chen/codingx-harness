import type { SandboxPolicy } from '../policy/types.js';

export type SandboxKind = 'seatbelt' | 'landlock' | 'windows' | 'none';

/** How a backend can constrain network access. */
export type SandboxNetworkCapability = 'deny' | 'allow' | 'proxy' | 'none';

export interface SandboxCapabilities {
  fileSystem: 'enforced' | 'none';
  network: SandboxNetworkCapability;
  unixSockets: boolean;
}

export interface SandboxStatus {
  kind: SandboxKind;
  platform: NodeJS.Platform;
  /** True after a successful capability probe. */
  available: boolean;
  /**
   * True when Shell must fail closed because this platform is expected to
   * provide a sandbox but does not. Linux is false until the Landlock backend
   * (M3.4) lands; macOS is true.
   */
  required: boolean;
  capabilities: SandboxCapabilities;
  /** Human-readable degradation/availability reason. */
  reason?: string;
  /** Static caveats surfaced at startup. */
  warnings: string[];
}

/** Fully resolved argv for one shell command. */
export interface SandboxShellInvocation {
  file: string;
  args: string[];
}

export interface SandboxBackend {
  readonly kind: SandboxKind;
  readonly capabilities: SandboxCapabilities;
  readonly status: SandboxStatus;
  /** Probe once and cache the result. */
  available(): Promise<boolean>;
  /** Build the sandboxed shell argv. Throws SANDBOX_UNAVAILABLE when unavailable. */
  wrapShell(command: string, policy: SandboxPolicy): SandboxShellInvocation;
}

export interface SandboxBackendOptions {
  platform?: NodeJS.Platform;
  /** Override /usr/bin/sandbox-exec (tests and diagnostics). */
  seatbeltPath?: string;
  /** Set false to skip executing a probe child process. */
  probe?: boolean;
  /** Probe timeout in milliseconds. */
  probeTimeoutMs?: number;
}
