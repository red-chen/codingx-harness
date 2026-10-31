import path from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { approvalRequestFor } from '../policy/index.js';
import type { PolicyDecision } from '../policy/types.js';
import type { ToolSchema } from '../providers/types.js';
import { abortError, CodingxError, isAbortError, ToolError } from '../util/errors.js';
import { truncateMiddle } from '../util/tokens.js';
import type { ToolContext, ToolDef, ToolResult } from './types.js';

function toInputSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const generated = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  const { $schema: _schema, definitions: _definitions, ...rest } = generated;
  return rest;
}

function policyMeta(decision: PolicyDecision, ctx: ToolContext): Record<string, unknown> {
  return {
    verdict: decision.verdict,
    ...(decision.code === undefined ? {} : { code: decision.code }),
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    ...(decision.rule === undefined ? {} : { rule: decision.rule }),
    risk: decision.risk,
    profile: ctx.policy?.profileName ?? 'none',
    approvalPolicy: ctx.policy?.approvalPolicy ?? 'none',
    action: {
      kind: decision.action.kind,
      tool: decision.action.tool,
      ...(decision.action.path === undefined ? {} : { path: decision.action.path }),
      ...(decision.action.command === undefined ? {} : { command: decision.action.command }),
      ...(decision.action.cwd === undefined ? {} : { cwd: decision.action.cwd }),
      ...(decision.action.network === undefined ? {} : { network: decision.action.network }),
      ...(decision.action.networkScope === undefined ? {} : { networkScope: decision.action.networkScope }),
      ...(decision.action.additionalPermissions === undefined ? {} : { additionalPermissions: decision.action.additionalPermissions }),
      ...(decision.action.prefixRule === undefined ? {} : { prefixRule: decision.action.prefixRule }),
    },
  };
}

function deniedMessage(tool: string, decision: PolicyDecision): string {
  const label =
    decision.code === 'POLICY_FORBIDDEN'
      ? 'Blocked by policy'
      : decision.code === 'APPROVAL_REQUIRED'
        ? 'Approval required'
        : 'Permission denied';
  const hint =
    decision.code === 'POLICY_FORBIDDEN'
      ? ' This action is on the hard deny list and cannot be approved.'
      : decision.code === 'APPROVAL_REQUIRED'
        ? ' Run interactively to approve it, widen the permission profile, or use --yolo only in a disposable environment.'
        : ' Use --add-dir, a wider permission profile, or --yolo only in a disposable environment.';
  return label + ' for tool "' + tool + '": ' + (decision.reason ?? 'the permission policy rejected this action.') + hint;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => '  - ' + (issue.path.length > 0 ? issue.path.join('.') : '<root>') + ': ' + issue.message)
    .join('\n');
}

/**
 * Registry of provider-agnostic tools. Execution validates input, converts
 * business failures into is_error results, and enforces the output budget.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  constructor(definitions: Iterable<ToolDef> = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(...definitions: ToolDef[]): this {
    for (const definition of definitions) {
      if (definition.name.length === 0) throw new ToolError('Tool name must not be empty.');
      if (this.tools.has(definition.name)) throw new ToolError('Duplicate tool name: ' + definition.name + '.');
      this.tools.set(definition.name, definition);
    }
    return this;
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  require(name: string): ToolDef {
    const definition = this.tools.get(name);
    if (!definition) throw new ToolError('Unknown tool: ' + name + '.');
    return definition;
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }

  /** Stable registration order maximizes prompt-cache hits. */
  toJsonSchemas(): ToolSchema[] {
    return this.list().map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: toInputSchema(definition.schema),
    }));
  }

  async execute(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const definition = this.tools.get(name);
    if (!definition) {
      return {
        content:
          'Unknown tool "' + name + '". Available tools: ' + this.list().map((item) => item.name).join(', ') + '.',
        isError: true,
      };
    }

    const parsed = definition.schema.safeParse(input);
    if (!parsed.success) {
      return {
        content: 'Invalid input for tool "' + name + '":\n' + formatIssues(parsed.error),
        isError: true,
        meta: { tool: name },
      };
    }

    let decision: PolicyDecision | undefined;
    let executeCtx = ctx;
    if ((parsed.data as Record<string, unknown>)?.sandbox_permissions === 'require_escalated') {
      if (!ctx.policy || (ctx.escalationBudget && ctx.escalationBudget.remaining <= 0)) {
        return { content: 'Scoped escalation requires a policy runtime and is limited to 3 requests per turn.', isError: true,
          meta: { code: ctx.policy ? 'ESCALATION_LIMIT' : 'PERMISSION_DENIED' } };
      }
      if (ctx.escalationBudget) ctx.escalationBudget.remaining--;
    }
    if (ctx.policy) {
      try { decision = await ctx.policy.evaluate(name, parsed.data); }
      catch (error) {
        if (isAbortError(error) || ctx.signal.aborted) throw error;
        return { content: 'Permission evaluation failed: ' + (error instanceof Error ? error.message : String(error)), isError: true,
          meta: { code: error instanceof CodingxError ? error.code : 'PERMISSION_DENIED' } };
      }
      if (decision.verdict === 'ask') {
        if (ctx.approve === undefined) {
          decision = {
            ...decision,
            verdict: 'deny',
            code: 'APPROVAL_REQUIRED',
            reason:
              (decision.reason ?? 'This action needs approval.') +
              ' No interactive approver is available in this run.',
          };
        } else {
          try {
            const answer = await ctx.approve(approvalRequestFor(decision), ctx.signal);
            if (answer.decision === 'allow' && (decision.action.networkScope === 'local' || decision.action.additionalPermissions !== undefined) && answer.scope !== 'once') {
              decision = { ...decision, verdict: 'deny', code: 'PERMISSION_DENIED', reason: 'Permission exceptions require allow-once approval.' };
            } else if (answer.decision === 'allow') {
              decision = { ...decision, verdict: 'allow', code: undefined, rule: 'approval.' + answer.scope };
              if (decision.action.networkScope === 'local') executeCtx = { ...executeCtx, approvedNetwork: 'local' };
              if (decision.action.additionalPermissions !== undefined) {
                executeCtx = { ...executeCtx, approvedPermissions: decision.action.additionalPermissions,
                  additionalDirs: [...(ctx.additionalDirs ?? []), ...(decision.action.additionalPermissions.filesystem?.read ?? []), ...(decision.action.additionalPermissions.filesystem?.write ?? [])] };
              }
              const root = decision.action.path;
              if (root !== undefined) {
                const extra = new Set(ctx.additionalDirs ?? []);
                extra.add(path.dirname(root));
                extra.add(root);
                executeCtx = { ...executeCtx, additionalDirs: [...extra] };
              }
            } else {
              decision = {
                ...decision,
                verdict: 'deny',
                code: 'PERMISSION_DENIED',
                reason: answer.reason ?? 'The user denied this action.',
              };
            }
          } catch (error) {
            if (isAbortError(error) || ctx.signal.aborted) throw error;
            decision = {
              ...decision,
              verdict: 'deny',
              code: 'PERMISSION_DENIED',
              reason: 'Approval failed: ' + (error instanceof Error ? error.message : String(error)),
            };
          }
        }
      }
      if (decision.verdict !== 'allow') {
        return {
          content: deniedMessage(name, decision),
          isError: true,
          meta: { code: decision.code ?? 'PERMISSION_DENIED', policy: policyMeta(decision, ctx) },
        };
      }
    }

    try {
      if (ctx.signal.aborted) throw abortError('Tool "' + name + '" aborted.');
      const result = await definition.execute(parsed.data, executeCtx);
      if (ctx.signal.aborted) throw abortError('Tool "' + name + '" aborted.');
      const bounded = this.bound(result, ctx);
      return decision === undefined
        ? bounded
        : { ...bounded, meta: { ...(bounded.meta ?? {}), policy: policyMeta(decision, ctx) } };
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (ctx.signal.aborted) throw abortError('Tool "' + name + '" aborted.');
      return this.bound(
        {
          content: 'Tool "' + name + '" failed: ' + (error instanceof Error ? error.message : String(error)),
          isError: true,
          meta: { code: error instanceof CodingxError ? error.code : 'TOOL_ERROR' },
        },
        ctx,
      );
    }
  }

  private bound(result: ToolResult, ctx: ToolContext): ToolResult {
    const content = typeof result.content === 'string' && result.content.length > 0 ? result.content : '(no output)';
    if (content.length <= ctx.maxOutputChars) return { ...result, content };
    return {
      content: truncateMiddle(content, ctx.maxOutputChars, '\n[... tool output truncated ...]\n'),
      ...(result.isError ? { isError: true } : {}),
      meta: { ...(result.meta ?? {}), truncated: true },
    };
  }
}
