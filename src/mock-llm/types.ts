import { z } from 'zod';

const expectationSchema = z.object({
  isError: z.boolean().optional(),
  contains: z.string().optional(),
}).strict();

export const mockToolSchema = z.object({
  name: z.string().min(1),
  input: z.record(z.unknown()),
  // Omitted means success is required; {} accepts either success or failure.
  expect: expectationSchema.optional(),
}).strict();

export const mockStepSchema = z.object({
  text: z.string().optional(),
  tools: z.array(mockToolSchema).max(32).optional(),
  stop: z.enum(['end_turn', 'tool_use', 'max_tokens', 'refusal']).optional(),
  fault: z.enum(['stream-error', 'disconnect', 'malformed-json']).optional(),
  delayMs: z.number().int().min(0).max(300_000).optional(),
}).strict();

export const mockScenarioSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  description: z.string().min(1),
  steps: z.array(mockStepSchema).min(1).max(100),
  repeat: z.boolean().optional(),
  requireImage: z.boolean().optional(),
  httpError: z.object({
    status: z.number().int().min(400).max(599),
    type: z.string().min(1),
    message: z.string(),
    // Omit for a permanent error; otherwise fail N attempts of the same request.
    attempts: z.number().int().min(1).max(20).optional(),
  }).strict().optional(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict().superRefine((scenario, ctx) => {
  scenario.steps.forEach((step, index) => {
    if (!scenario.repeat && index < scenario.steps.length - 1 && !step.tools?.length) {
      ctx.addIssue({ code: 'custom', path: ['steps', index], message: 'A non-final step must call tools.' });
    }
  });
});

export type MockTool = z.infer<typeof mockToolSchema>;
export type MockStep = z.infer<typeof mockStepSchema>;
export type MockScenario = z.infer<typeof mockScenarioSchema>;

const blockSchema = z.object({
  type: z.string(), text: z.string().optional(), id: z.string().optional(),
  name: z.string().optional(), input: z.unknown().optional(),
  tool_use_id: z.string().optional(), content: z.unknown().optional(), is_error: z.boolean().optional(),
}).passthrough();

export const mockRequestSchema = z.object({
  model: z.string().min(1), stream: z.literal(true),
  max_tokens: z.number().int().positive(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(blockSchema)]),
  })).min(1),
  tools: z.array(z.object({ name: z.string(), input_schema: z.record(z.unknown()) }).passthrough()).optional(),
  system: z.union([z.string(), z.array(blockSchema)]).optional(),
  output_config: z.object({ effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']) }).optional(),
}).passthrough();

export type MockRequest = z.infer<typeof mockRequestSchema>;
export type MockBlock = z.infer<typeof blockSchema>;

/** Diagnostics deliberately contain no headers, prompts, tool inputs, or images. */
export interface MockRequestRecord {
  sequence: number;
  scenario: string;
  step: number;
  status: number;
  messages: number;
  images: number;
  tools: number;
  effort?: string;
  systemCache: boolean;
  toolsCache: boolean;
}

export interface MockServerOptions {
  port?: number;
  scenario?: string;
  scenarios?: MockScenario[];
  chunkBytes?: number;
  delayMs?: number;
  crlf?: boolean;
  maxBodyBytes?: number;
}

export interface MockServer {
  url: string;
  records: readonly MockRequestRecord[];
  close(): Promise<void>;
}
