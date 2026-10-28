import type { AskAnswer, AskQuestion } from '../../tools/types.js';
import {
  createComposerState,
  deleteComposerBackward,
  deleteComposerForward,
  insertComposerText,
  moveComposerCursor,
  type CursorDirection,
} from '../widgets/composer.js';
import type { TuiAskOption, TuiAskQuestion, TuiAskState } from './types.js';

/**
 * Pure ask-overlay state transitions. The app owns key routing; these helpers
 * only map one user action to the next immutable state so they stay testable.
 */

function normalizeOptions(options: AskQuestion['options']): TuiAskOption[] {
  if (options === undefined) return [];
  return options.map((option) => ({
    label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
  }));
}

export function createAskState(questions: readonly AskQuestion[]): TuiAskState {
  const normalized: TuiAskQuestion[] = questions.map((question) => ({
    id: question.id,
    question: question.question,
    options: normalizeOptions(question.options),
    multiSelect: question.multiSelect === true,
    ...(question.header === undefined ? {} : { header: question.header }),
  }));
  const first = normalized[0];
  return {
    questions: normalized,
    index: 0,
    selections: normalized.map(() => []),
    optionIndex: 0,
    custom: normalized.map(() => ''),
    editing: first !== undefined && first.options.length === 0,
    cursor: 0,
  };
}

export function currentAskQuestion(state: TuiAskState): TuiAskQuestion | undefined {
  return state.questions[state.index];
}

export function currentAskSelection(state: TuiAskState): readonly string[] {
  return state.selections[state.index] ?? [];
}

export function currentAskCustom(state: TuiAskState): string {
  return state.custom[state.index] ?? '';
}

/** Options are followed by one "Other" row, even for free-text questions. */
export function askRowCount(question: TuiAskQuestion): number {
  return question.options.length + 1;
}

export function askIsOtherRow(state: TuiAskState): boolean {
  const question = currentAskQuestion(state);
  return question !== undefined && state.optionIndex >= question.options.length;
}

function withSelection(state: TuiAskState, selected: readonly string[]): TuiAskState {
  return {
    ...state,
    selections: state.selections.map((value, index) => (index === state.index ? [...selected] : value)),
  };
}

function withoutLabel(selected: readonly string[], label: string): string[] {
  return selected.filter((value) => value !== label);
}

function toggleLabel(state: TuiAskState, label: string, multiSelect: boolean): TuiAskState {
  const selected = currentAskSelection(state);
  if (!multiSelect) {
    return withSelection({
      ...state,
      custom: state.custom.map((value, index) => index === state.index ? '' : value),
    }, [label]);
  }
  return withSelection(
    state,
    selected.includes(label) ? withoutLabel(selected, label) : [...selected, label],
  );
}

export function moveAskCursor(state: TuiAskState, delta: number): TuiAskState {
  const question = currentAskQuestion(state);
  if (question === undefined || delta === 0) return state;
  const count = askRowCount(question);
  const current = Number.isFinite(state.optionIndex) ? state.optionIndex : 0;
  const next = ((current + Math.trunc(delta)) % count + count) % count;
  return next === state.optionIndex ? state : { ...state, optionIndex: next };
}

/** Space toggles (multi) or picks (single) the highlighted option. */
export function selectAskOption(state: TuiAskState): TuiAskState {
  const question = currentAskQuestion(state);
  if (question === undefined) return state;
  const option = question.options[state.optionIndex];
  if (option === undefined) return state;
  return toggleLabel(state, option.label, question.multiSelect);
}

/** Digit shortcuts pick an option by position without confirming. */
export function selectAskOptionAt(state: TuiAskState, optionIndex: number): TuiAskState {
  const question = currentAskQuestion(state);
  if (question === undefined) return state;
  const option = question.options[optionIndex];
  if (option === undefined) return state;
  const next = toggleLabel(state, option.label, question.multiSelect);
  return { ...next, optionIndex };
}

/** Focus the custom-answer row. */
export function beginAskCustom(state: TuiAskState): TuiAskState {
  const question = currentAskQuestion(state);
  if (question === undefined) return state;
  const custom = currentAskCustom(state);
  return {
    ...state,
    optionIndex: question.options.length,
    editing: true,
    cursor: custom.length,
  };
}

/** Leave custom editing while keeping the typed text. */
export function commitAskCustom(state: TuiAskState): TuiAskState {
  if (!state.editing) return state;
  return { ...state, editing: false, cursor: currentAskCustom(state).length };
}

function editCustom(
  state: TuiAskState,
  transform: (composer: ReturnType<typeof createComposerState>) => ReturnType<typeof createComposerState>,
): TuiAskState {
  const custom = currentAskCustom(state);
  const composer = { ...createComposerState(custom), cursor: state.cursor };
  const next = transform(composer);
  return {
    ...state,
    custom: state.custom.map((value, index) => (index === state.index ? next.text : value)),
    cursor: next.cursor,
    ...(currentAskQuestion(state)?.multiSelect === false && next.text.trim().length > 0
      ? { selections: state.selections.map((value, index) => index === state.index ? [] : value) }
      : {}),
  };
}

/** Custom answers are single-line and bounded so the panel stays renderable. */
export const MAX_ASK_CUSTOM_CHARS = 4_000;

export function insertAskCustom(state: TuiAskState, text: string): TuiAskState {
  const singleLine = text.replace(/\r\n?/gu, '\n').replace(/\n/gu, ' ');
  return editCustom(state, (composer) => {
    const room = Math.max(0, MAX_ASK_CUSTOM_CHARS - composer.text.length);
    return insertComposerText(composer, singleLine.slice(0, room));
  });
}

export function deleteAskCustomBackward(state: TuiAskState): TuiAskState {
  return editCustom(state, (composer) => deleteComposerBackward(composer));
}

export function deleteAskCustomForward(state: TuiAskState): TuiAskState {
  return editCustom(state, (composer) => deleteComposerForward(composer));
}

export function moveAskCustomCursor(state: TuiAskState, direction: CursorDirection): TuiAskState {
  if (direction === 'up' || direction === 'down') return state;
  return editCustom(state, (composer) => moveComposerCursor(composer, direction));
}

export function answersFromAsk(state: TuiAskState): AskAnswer[] {
  return state.questions.map((question, index) => {
    const custom = (state.custom[index] ?? '').trim();
    return {
      id: question.id,
      selected: [...(state.selections[index] ?? [])],
      ...(custom.length > 0 ? { custom } : {}),
    };
  });
}

export interface AskAdvanceResult {
  readonly state: TuiAskState;
  /** Present only after the last question was confirmed. */
  readonly answers?: readonly AskAnswer[];
}

export function advanceAsk(state: TuiAskState): AskAdvanceResult {
  if (state.questions.length === 0) return { state, answers: [] };
  if (state.index + 1 >= state.questions.length) {
    return { state, answers: answersFromAsk(state) };
  }
  const index = state.index + 1;
  const question = state.questions[index];
  return {
    state: {
      ...state,
      index,
      optionIndex: 0,
      editing: question !== undefined && question.options.length === 0,
      cursor: (state.custom[index] ?? '').length,
    },
  };
}

export function previousAskQuestion(state: TuiAskState): TuiAskState {
  if (state.index <= 0) return state;
  const index = state.index - 1;
  const question = state.questions[index];
  return {
    ...state,
    index,
    optionIndex: 0,
    editing: question !== undefined && question.options.length === 0,
    cursor: (state.custom[index] ?? '').length,
  };
}
