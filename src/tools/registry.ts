import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolSchema } from '../providers/types.js';
import { abortError, isAbortError, ToolError } from '../util/errors.js';
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

    try {
      const result = await definition.execute(parsed.data, ctx);
      return this.bound(result, ctx);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (ctx.signal.aborted) throw abortError('Tool "' + name + '" aborted.');
      return this.bound(
        {
          content: 'Tool "' + name + '" failed: ' + (error instanceof Error ? error.message : String(error)),
          isError: true,
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
