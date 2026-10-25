import { REASONING_EFFORTS, type ReasoningEffort } from '../providers/types.js';

export interface ModelSelection {
  model: string;
  reasoningEffort?: ReasoningEffort;
}

export type ModelCommand =
  | { type: 'show' }
  | { type: 'set'; selection: ModelSelection }
  | { type: 'error'; message: string };

const CLEAR_EFFORT_ALIASES = new Set(['default', 'off', 'none', 'auto']);
const EFFORT_LIST = REASONING_EFFORTS.join('|');

export const MODEL_COMMAND_USAGE =
  'Usage: /model [<model> [low|medium|high|xhigh|max|default]] or /model --effort <level>';

function error(message: string): ModelCommand {
  return { type: 'error', message: message + ' ' + MODEL_COMMAND_USAGE };
}

function parseEffort(token: string): { ok: true; value: ReasoningEffort | undefined } | { ok: false } {
  const normalized = token.toLowerCase();
  if (CLEAR_EFFORT_ALIASES.has(normalized)) return { ok: true, value: undefined };
  const effort = REASONING_EFFORTS.find((candidate) => candidate === normalized);
  return effort === undefined ? { ok: false } : { ok: true, value: effort };
}

/**
 * Parse /model:
 *   /model                                  show current settings
 *   /model <model>                          switch model, keep effort
 *   /model <model> <effort>                 switch model and effort
 *   /model --effort <effort>                change effort only
 *   /model --effort default                 clear the effort override
 */
export function parseModelCommand(text: string, current: ModelSelection): ModelCommand {
  const tokens = text.trim().split(/\s+/u).filter((token) => token.length > 0);
  if (tokens[0] !== '/model') return error('Not a /model command.');
  const args = tokens.slice(1);
  if (args.length === 0) return { type: 'show' };

  const effortOnly = args[0] === '--effort' || args[0] === '-e' || args[0] === 'effort';
  if (effortOnly) {
    if (args.length !== 2) return error('Expected exactly one reasoning effort.');
    const parsed = parseEffort(args[1] as string);
    if (!parsed.ok) return error('Unknown reasoning effort: ' + String(args[1]) + '. Use ' + EFFORT_LIST + ' or default.');
    return {
      type: 'set',
      selection: {
        model: current.model,
        ...(parsed.value === undefined ? {} : { reasoningEffort: parsed.value }),
      },
    };
  }

  const model = args[0] as string;
  if (model.startsWith('-')) return error('Unknown option: ' + model + '.');
  if (args.length > 2) return error('Too many arguments.');
  let reasoningEffort = current.reasoningEffort;
  if (args.length === 2) {
    const parsed = parseEffort(args[1] as string);
    if (!parsed.ok) return error('Unknown reasoning effort: ' + String(args[1]) + '. Use ' + EFFORT_LIST + ' or default.');
    reasoningEffort = parsed.value;
  }
  return {
    type: 'set',
    selection: {
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
  };
}

export function describeModelSelection(selection: ModelSelection): string {
  return 'model: ' + selection.model + '\neffort: ' + (selection.reasoningEffort ?? 'default');
}
