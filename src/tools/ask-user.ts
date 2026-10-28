import { z } from 'zod';
import type { AskQuestion, ToolDef } from './types.js';

function isSingleLine(value: string): boolean {
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\r\n\t]/u.test(value);
}

const singleLine = { message: 'Use a single line without control characters.' } as const;

const optionSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine(isSingleLine, singleLine)
    .describe('Short option label shown to the user.'),
  description: z
    .string()
    .trim()
    .max(500)
    .refine(isSingleLine, singleLine)
    .optional()
    .describe('Optional one-line explanation of this choice.'),
});

const questionSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/u, 'Use letters, digits, underscores or dashes.')
    .describe('Stable identifier used to map the answer back to this question.'),
  header: z
    .string()
    .trim()
    .max(80)
    .refine(isSingleLine, singleLine)
    .optional()
    .describe('Optional short heading shown above the question.'),
  question: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .refine(isSingleLine, singleLine)
    .describe('The question to ask. Be specific; the user only sees this text and the options.'),
  options: z
    .array(optionSchema)
    .min(2)
    .max(6)
    .optional()
    .describe('2-6 fixed choices. Omit for a free-text answer.'),
  multi_select: z.boolean().optional().describe('false or omitted: single choice. true: select multiple choices with checkboxes.'),
});

const schema = z
  .object({
    questions: z
      .array(questionSchema)
      .min(1)
      .max(4)
      .describe('1-4 questions asked in one batch. Prefer one focused question.'),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.questions.forEach((question, index) => {
      if (seen.has(question.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['questions', index, 'id'],
          message: 'Question ids must be unique.',
        });
      }
      seen.add(question.id);

      const labels = new Set<string>();
      question.options?.forEach((option, optionIndex) => {
        if (labels.has(option.label)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['questions', index, 'options', optionIndex, 'label'],
            message: 'Option labels must be unique within a question.',
          });
        }
        labels.add(option.label);
      });
    });
  });

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function toQuestions(input: z.infer<typeof schema>): AskQuestion[] {
  return input.questions.map((question) => ({
    id: question.id,
    question: question.question,
    multiSelect: question.multi_select === true,
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.options === undefined
      ? {}
      : {
          options: question.options.map((option) => ({
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
        }),
  }));
}

/**
 * Ask the user a clarifying question mid-turn. The UI supplies the ask
 * handler through ToolContext; non-interactive runs get a clear is_error
 * result instead of blocking on stdin.
 */
export const askUserQuestionTool: ToolDef<typeof schema> = {
  name: 'AskUserQuestion',
  description:
    'Ask the user one or more clarifying questions and wait for the answers. Use it only when the answer changes what you ' +
    'do next and you cannot resolve the ambiguity by inspecting the repository or the conversation. Do not use it to ask ' +
    'permission, to confirm routine steps, or to hand the work back to the user. Provide 2-6 options when the choice is ' +
    'enumerable, and set multi_select when several options may apply at once. Omit options for a free-text answer. ' +
    'In non-interactive runs the tool returns an error instead of blocking; ask in your final message in that case.',
  schema,
  parallelSafe: false,
  approval: 'none',
  async execute(input, ctx) {
    if (ctx.ask === undefined) {
      return {
        content:
          'This run cannot show interactive questions. Ask the user directly in your final response, spelling out the ' +
          'options; do not call AskUserQuestion again.',
        isError: true,
      };
    }

    const questions = toQuestions(input);
    const answers = await ctx.ask(questions, ctx.signal);
    if (answers === null) {
      return {
        content:
          'The user dismissed the question without answering. Continue with your best judgement, or ask in plain text ' +
          'in your final response. Do not repeat the same question.',
        isError: true,
        meta: { dismissed: true },
      };
    }

    const byId = new Map(answers.map((answer) => [answer.id, answer]));
    const lines: string[] = ['User answers:'];
    const normalized: Array<{ id: string; selected: string[]; custom?: string }> = [];
    input.questions.forEach((question, index) => {
      const answer = byId.get(question.id);
      const selected = (answer?.selected ?? []).map(oneLine).filter((label) => label.length > 0);
      const custom = answer?.custom === undefined ? '' : oneLine(answer.custom);
      normalized.push({
        id: question.id,
        selected,
        ...(custom.length > 0 ? { custom } : {}),
      });
      lines.push(index + 1 + '. ' + oneLine(question.question));
      lines.push('   selected: ' + (selected.length > 0 ? selected.join(', ') : '(none)'));
      if (custom.length > 0) lines.push('   custom: ' + custom);
    });

    return {
      content: lines.join('\n'),
      meta: { answers: normalized },
    };
  },
};
