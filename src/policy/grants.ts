import { parseShellCommand } from './shell-parse.js';
import type { PolicyAction } from './types.js';

/**
 * In-memory session grants created by the approval panel. Grants never leave
 * the current CLI process: /clear drops them, resume starts with none, and
 * every grant is also written to the rollout as an audit event by TuiSession.
 */
export class SessionGrants {
  private readonly exact = new Set<string>();
  private readonly prefixes: Array<{ tokens: string[]; cwd: string }> = [];

  constructor(private readonly cwd: string) {}

  private key(action: PolicyAction): string {
    if (action.kind === 'file.read' || action.kind === 'file.write' || action.kind === 'file.delete') {
      return action.kind + ':' + (action.path ?? '');
    }
    if (action.kind === 'exec') {
      return 'exec:' + (action.cwd ?? this.cwd) + ':' + (action.command ?? '');
    }
    if (action.kind === 'network') {
      return 'network:' + (action.detail ?? action.path ?? '');
    }
    return 'tool:' + action.tool;
  }

  permits(action: PolicyAction): boolean {
    if (this.exact.has(this.key(action))) return true;
    if (action.kind !== 'exec' || action.command === undefined) return false;
    const parsed = parseShellCommand(action.command, action.cwd ?? this.cwd);
    if (parsed.hasUnsafeConstruct || parsed.segments.length !== 1) return false;
    const segment = parsed.segments[0];
    if (segment === undefined || segment.redirects.length > 0) return false;
    const tokens = [segment.program, ...segment.args];
    return this.prefixes.some(
      (grant) =>
        grant.cwd === (action.cwd ?? this.cwd) &&
        grant.tokens.length <= tokens.length &&
        grant.tokens.every((token, index) => tokens[index] === token),
    );
  }

  /**
   * Record an approval. Returns true when a grant was stored. Prefix grants
   * only apply to a single, parseable command with no redirections.
   */
  grant(action: PolicyAction, scope: 'session' | 'prefix'): boolean {
    if (scope === 'session') {
      this.exact.add(this.key(action));
      return true;
    }
    const tokens = approvalPrefixFor(action, this.cwd);
    if (tokens === undefined) return false;
    this.prefixes.push({ tokens, cwd: action.cwd ?? this.cwd });
    return true;
  }

  clear(): void {
    this.exact.clear();
    this.prefixes.length = 0;
  }

  get size(): number {
    return this.exact.size + this.prefixes.length;
  }
}

/** Token prefix offered by the approval panel; undefined for non-exec actions. */
export function approvalPrefixFor(action: PolicyAction, fallbackCwd: string): string[] | undefined {
  if (action.kind !== 'exec' || action.command === undefined) return undefined;
  const parsed = parseShellCommand(action.command, action.cwd ?? fallbackCwd);
  if (parsed.hasUnsafeConstruct || parsed.segments.length !== 1) return undefined;
  const segment = parsed.segments[0];
  if (segment === undefined || segment.redirects.length > 0) return undefined;
  return [segment.program, ...segment.args];
}
