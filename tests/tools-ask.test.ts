import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildChildEnv } from '../src/exec/index.js';
import {
  ReadFileTracker,
  ToolRegistry,
  createBuiltinTools,
  type AskQuestion,
  type ToolContext,
} from '../src/tools/index.js';
import { abortError } from '../src/util/errors.js';

let cwd: string;
let registry: ToolRegistry;
let ctx: ToolContext;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'codingx-ask-'));
  registry = new ToolRegistry(createBuiltinTools());
  ctx = {
    cwd,
    signal: new AbortController().signal,
    readTracker: new ReadFileTracker(),
    maxOutputChars: 30_000,
    shell: {
      env: buildChildEnv(['PATH', 'HOME'], { ...process.env, HOME: cwd }),
      timeoutMs: 5_000,
    },
  };
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const INPUT = {
  questions: [
    {
      id: 'approach',
      header: 'Plan',
      question: 'Which approach should I use?',
      options: [
        { label: 'Fast', description: 'Change one file.' },
        { label: 'Safe', description: 'Add tests first.' },
      ],
      multi_select: false,
    },
    {
      id: 'notes',
      question: 'Anything else I should know?',
    },
  ],
};

describe('AskUserQuestion', () => {
  it('passes normalized questions to the UI handler and formats the answers', async () => {
    let received: readonly AskQuestion[] = [];
    const result = await registry.execute(
      'AskUserQuestion',
      INPUT,
      {
        ...ctx,
        ask: async (questions) => {
          received = questions;
          return [
            { id: 'approach', selected: ['Safe'] },
            { id: 'notes', selected: [], custom: '  Keep the API stable.  ' },
          ];
        },
      },
    );

    expect(result.isError).toBeUndefined();
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({
      id: 'approach',
      header: 'Plan',
      multiSelect: false,
      options: [
        { label: 'Fast', description: 'Change one file.' },
        { label: 'Safe', description: 'Add tests first.' },
      ],
    });
    expect(received[1]).toEqual({
      id: 'notes',
      question: 'Anything else I should know?',
      multiSelect: false,
    });
    expect(result.content).toBe(
      [
        'User answers:',
        '1. Which approach should I use?',
        '   selected: Safe',
        '2. Anything else I should know?',
        '   selected: (none)',
        '   custom: Keep the API stable.',
      ].join('\n'),
    );
    expect(result.meta).toMatchObject({
      answers: [
        { id: 'approach', selected: ['Safe'] },
        { id: 'notes', selected: [], custom: 'Keep the API stable.' },
      ],
    });
  });

  it('returns a clear is_error when no interactive UI is available', async () => {
    const result = await registry.execute('AskUserQuestion', INPUT, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/cannot show interactive questions/);
    expect(result.content).toMatch(/do not call AskUserQuestion again/i);
  });

  it('reports dismissal as is_error so the model stops asking', async () => {
    const result = await registry.execute('AskUserQuestion', INPUT, {
      ...ctx,
      ask: async () => null,
    });
    expect(result.isError).toBe(true);
    expect(result.meta).toEqual({ dismissed: true });
    expect(result.content).toMatch(/dismissed the question/);
  });

  it('validates duplicate ids and option counts before calling the UI', async () => {
    let called = false;
    const failingCtx: ToolContext = {
      ...ctx,
      ask: async () => {
        called = true;
        return [];
      },
    };
    const duplicate = await registry.execute(
      'AskUserQuestion',
      {
        questions: [
          { id: 'same', question: 'One?' },
          { id: 'same', question: 'Two?' },
        ],
      },
      failingCtx,
    );
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content).toMatch(/unique/);

    const singleOption = await registry.execute(
      'AskUserQuestion',
      { questions: [{ id: 'x', question: 'Pick', options: [{ label: 'Only' }] }] },
      failingCtx,
    );
    expect(singleOption.isError).toBe(true);
    expect(singleOption.content).toMatch(/Invalid input/);

    const duplicateLabels = await registry.execute(
      'AskUserQuestion',
      {
        questions: [
          {
            id: 'x',
            question: 'Pick',
            options: [{ label: 'Same' }, { label: 'Same' }],
          },
        ],
      },
      failingCtx,
    );
    expect(duplicateLabels.isError).toBe(true);
    expect(duplicateLabels.content).toMatch(/labels must be unique/);

    const multiline = await registry.execute(
      'AskUserQuestion',
      { questions: [{ id: 'x', question: 'Line one\nLine two' }] },
      failingCtx,
    );
    expect(multiline.isError).toBe(true);
    expect(multiline.content).toMatch(/single line/);
    expect(called).toBe(false);
  });

  it('propagates aborts and converts handler failures into is_error results', async () => {
    await expect(
      registry.execute('AskUserQuestion', INPUT, {
        ...ctx,
        ask: async () => {
          throw abortError('Question cancelled.');
        },
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });

    const failed = await registry.execute('AskUserQuestion', INPUT, {
      ...ctx,
      ask: async () => {
        throw new Error('terminal closed');
      },
    });
    expect(failed.isError).toBe(true);
    expect(failed.content).toMatch(/terminal closed/);
  });
});
