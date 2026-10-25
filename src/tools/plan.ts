import { z } from 'zod';
import type { ToolDef } from './types.js';

const schema = z.object({
  plan: z
    .array(
      z.object({
        step: z.string().min(1).max(500).describe('One concrete step.'),
        status: z.enum(['pending', 'in_progress', 'completed']).describe('Current status of this step.'),
      }),
    )
    .min(1)
    .max(20)
    .describe('Ordered plan for the current task. Keep it current as work progresses.'),
});

function marker(status: 'pending' | 'in_progress' | 'completed'): string {
  if (status === 'completed') return '✔';
  if (status === 'in_progress') return '▶';
  return '□';
}

export const updatePlanTool: ToolDef<typeof schema> = {
  name: 'UpdatePlan',
  description:
    'Create or update the explicit task plan for a multi-step job. Pass the complete ordered plan each time, ' +
    'not a diff. Use status pending, in_progress (at most the current step) or completed. ' +
    'The plan is shown in the UI and persisted with the session. Update it as steps finish; do not use it for trivial one-step tasks.',
  schema,
  parallelSafe: false,
  approval: 'none',
  async execute(input, ctx) {
    const steps = input.plan.map((item) => ({ step: item.step.trim(), status: item.status }));
    ctx.plan?.update(steps);
    const rendered = steps.map((item) => marker(item.status) + ' ' + item.step).join('\n');
    return {
      content: 'Plan updated:\n' + rendered,
      meta: { plan: steps, steps: steps.length },
    };
  },
};
