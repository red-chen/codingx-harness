import type {
  TuiApprovalChoice,
  TuiApprovalRequest,
  TuiApprovalState,
} from './types.js';

export const MAX_APPROVAL_REASON_CHARS = 2_000;

export function approvalChoices(allowPrefix: boolean, onceOnly = false): readonly TuiApprovalChoice[] {
  if (onceOnly) return ['once', 'deny', 'deny-reason'];
  return allowPrefix
    ? ['once', 'session', 'prefix', 'deny', 'deny-reason']
    : ['once', 'session', 'deny', 'deny-reason'];
}

export function createApprovalState(request: TuiApprovalRequest): TuiApprovalState {
  return {
    request,
    choiceIndex: 0,
    editingReason: false,
    reason: '',
    cursor: 0,
  };
}

export function currentApprovalChoice(state: TuiApprovalState): TuiApprovalChoice | undefined {
  return approvalChoices(state.request.allowPrefix, state.request.onceOnly)[state.choiceIndex];
}

export function moveApprovalChoice(state: TuiApprovalState, delta: number): TuiApprovalState {
  const count = approvalChoices(state.request.allowPrefix, state.request.onceOnly).length;
  if (count === 0 || delta === 0) return state;
  const current = Number.isFinite(state.choiceIndex) ? state.choiceIndex : 0;
  const next = ((current + Math.trunc(delta)) % count + count) % count;
  return next === state.choiceIndex ? state : { ...state, choiceIndex: next };
}

export function selectApprovalChoiceAt(state: TuiApprovalState, index: number): TuiApprovalState {
  const count = approvalChoices(state.request.allowPrefix, state.request.onceOnly).length;
  if (index < 0 || index >= count) return state;
  return { ...state, choiceIndex: index };
}

export function beginApprovalReason(state: TuiApprovalState): TuiApprovalState {
  const choices = approvalChoices(state.request.allowPrefix, state.request.onceOnly);
  const index = choices.indexOf('deny-reason');
  return {
    ...state,
    ...(index < 0 ? {} : { choiceIndex: index }),
    editingReason: true,
    cursor: state.reason.length,
  };
}

export function cancelApprovalReason(state: TuiApprovalState): TuiApprovalState {
  return { ...state, editingReason: false, cursor: state.reason.length };
}

export function insertApprovalReason(state: TuiApprovalState, text: string): TuiApprovalState {
  const singleLine = text.replace(/\r\n?/gu, '\n').replace(/\n/gu, ' ');
  const room = Math.max(0, MAX_APPROVAL_REASON_CHARS - state.reason.length);
  const inserted = singleLine.slice(0, room);
  if (inserted.length === 0) return state;
  const cursor = Math.max(0, Math.min(state.cursor, state.reason.length));
  const next = state.reason.slice(0, cursor) + inserted + state.reason.slice(cursor);
  return { ...state, reason: next, cursor: cursor + inserted.length };
}

export function deleteApprovalReasonBackward(state: TuiApprovalState): TuiApprovalState {
  if (state.cursor <= 0 || state.reason.length === 0) return state;
  const cursor = Math.min(state.cursor, state.reason.length);
  return {
    ...state,
    reason: state.reason.slice(0, cursor - 1) + state.reason.slice(cursor),
    cursor: cursor - 1,
  };
}

export function deleteApprovalReasonForward(state: TuiApprovalState): TuiApprovalState {
  if (state.cursor >= state.reason.length) return state;
  const cursor = Math.max(0, state.cursor);
  return {
    ...state,
    reason: state.reason.slice(0, cursor) + state.reason.slice(cursor + 1),
    cursor,
  };
}

export function moveApprovalReasonCursor(
  state: TuiApprovalState,
  direction: 'left' | 'right' | 'home' | 'end',
): TuiApprovalState {
  if (direction === 'home') return { ...state, cursor: 0 };
  if (direction === 'end') return { ...state, cursor: state.reason.length };
  const cursor =
    direction === 'left'
      ? Math.max(0, state.cursor - 1)
      : Math.min(state.reason.length, state.cursor + 1);
  return cursor === state.cursor ? state : { ...state, cursor };
}
