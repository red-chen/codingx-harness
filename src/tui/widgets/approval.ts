import type { CellBuffer, Style } from '../terminal/buffer.js';
import { ATTR_BOLD } from '../terminal/buffer.js';
import { TUI_COLORS } from '../state/types.js';
import type { TuiApprovalChoice, TuiApprovalState } from '../state/types.js';
import { approvalChoices, currentApprovalChoice } from '../state/approval.js';
import { displayWidth, truncateToWidth, wrapText } from '../text/index.js';

const PANEL_BG = TUI_COLORS.planBg;
const BG: Style = { bg: PANEL_BG };
const BORDER_STYLE: Style = { fg: TUI_COLORS.border, bg: PANEL_BG };
const TITLE_STYLE: Style = { fg: TUI_COLORS.accent, attrs: ATTR_BOLD, bg: PANEL_BG };
const TOOL_STYLE: Style = { fg: TUI_COLORS.accent, attrs: ATTR_BOLD, bg: PANEL_BG };
const ACTION_STYLE: Style = { bg: PANEL_BG };
const MUTED_STYLE: Style = { fg: TUI_COLORS.muted, bg: PANEL_BG };
const WARNING_STYLE: Style = { fg: TUI_COLORS.warning, bg: PANEL_BG };
const ACTIVE_STYLE: Style = { fg: TUI_COLORS.accent, attrs: ATTR_BOLD, bg: PANEL_BG };
const HINT_STYLE: Style = { fg: TUI_COLORS.muted, bg: PANEL_BG };

export interface ApprovalPanelLine {
  readonly text: string;
  readonly style: Style;
}

export interface ApprovalPanelModel {
  readonly lines: readonly ApprovalPanelLine[];
  readonly cursorRow?: number;
  readonly cursorColumn?: number;
}

function contentWidth(width: number): number {
  return Math.max(8, width - 4);
}

function limitedWrap(text: string, width: number, maxLines: number): string[] {
  const wrapped = wrapText(text, width);
  if (wrapped.length <= maxLines) return wrapped;
  const kept = wrapped.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? '';
  kept[maxLines - 1] = truncateToWidth(last + '…', width);
  return kept;
}

function riskLabel(risk: TuiApprovalState['request']['risk']): string {
  return 'risk ' + risk;
}

export function approvalChoiceLabel(choice: TuiApprovalChoice): string {
  switch (choice) {
    case 'once':
      return 'Allow once';
    case 'session':
      return 'Allow for this session';
    case 'prefix':
      return 'Allow this command prefix for the session';
    case 'deny':
      return 'Deny';
    case 'deny-reason':
      return 'Deny with reason…';
  }
}

export function buildApprovalPanel(state: TuiApprovalState, width: number): ApprovalPanelModel {
  const inner = contentWidth(width);
  const lines: ApprovalPanelLine[] = [];
  const request = state.request;
  let cursorRow: number | undefined;
  let cursorColumn: number | undefined;

  lines.push({ text: truncateToWidth(request.tool + ' · ' + riskLabel(request.risk), inner), style: TOOL_STYLE });
  if (request.action.command !== undefined && request.action.command.length > 0) {
    for (const line of limitedWrap('$ ' + request.action.command, inner, 5)) {
      lines.push({ text: line, style: ACTION_STYLE });
    }
  } else if (request.action.path !== undefined) {
    for (const line of limitedWrap('path: ' + request.action.path, inner, 3)) {
      lines.push({ text: line, style: ACTION_STYLE });
    }
  }
  if (request.action.cwd !== undefined && request.action.cwd.length > 0) {
    lines.push({ text: truncateToWidth('cwd: ' + request.action.cwd, inner), style: MUTED_STYLE });
  }
  if (request.action.network === true) {
    lines.push({ text: 'network access requested', style: WARNING_STYLE });
  }
  if (request.reason !== undefined && request.reason.trim().length > 0) {
    lines.push({ text: 'Why:', style: MUTED_STYLE });
    for (const line of limitedWrap(request.reason, inner, 3)) {
      lines.push({ text: line, style: MUTED_STYLE });
    }
  }
  lines.push({ text: '', style: ACTION_STYLE });

  const choices = approvalChoices(request.allowPrefix);
  const active = currentApprovalChoice(state);
  choices.forEach((choice, index) => {
    const marker = active === choice ? '(•)' : '( )';
    const prefix = state.choiceIndex === index && !state.editingReason ? '› ' : '  ';
    lines.push({
      text: truncateToWidth(prefix + marker + ' ' + approvalChoiceLabel(choice), inner),
      style: state.choiceIndex === index && !state.editingReason ? ACTIVE_STYLE : ACTION_STYLE,
    });
  });

  if (state.editingReason) {
    const head = '  Reason: ';
    const body = state.reason.length > 0 ? state.reason : 'type a reason';
    lines.push({ text: truncateToWidth(head + body, inner), style: ACTION_STYLE });
    cursorRow = lines.length - 1;
    cursorColumn = Math.min(inner - 1, displayWidth(head) + displayWidth(state.reason.slice(0, state.cursor)));
  }

  lines.push({ text: '', style: ACTION_STYLE });
  lines.push({
    text: truncateToWidth(
      state.editingReason
        ? 'Type a reason · Enter deny · Esc back'
        : 'v details · ↑/↓ choose · Enter confirm · Esc deny',
      inner,
    ),
    style: HINT_STYLE,
  });

  return {
    lines,
    ...(cursorRow === undefined || cursorColumn === undefined ? {} : { cursorRow, cursorColumn }),
  };
}

export function approvalPanelHeight(state: TuiApprovalState, width: number): number {
  return buildApprovalPanel(state, width).lines.length + 1;
}

export interface ApprovalPanelRender {
  readonly height: number;
  readonly cursor: { x: number; y: number } | null;
}

export function renderApprovalPanel(
  frame: CellBuffer,
  width: number,
  height: number,
  state: TuiApprovalState,
): ApprovalPanelRender {
  if (width < 12 || height < 4) return { height: 0, cursor: null };
  if (state.details) {
    const request = state.request;
    const text = [request.tool + ' · ' + riskLabel(request.risk),
      request.action.command ?? request.action.path ?? '',
      'cwd: ' + (request.action.cwd ?? ''), request.reason ?? ''].join('\n');
    const lines = wrapText(text, Math.max(1, width - 4));
    const rows = Math.max(1, height - 2);
    const offset = Math.min(state.detailsOffset ?? 0, Math.max(0, lines.length - rows));
    frame.fill(BG, 0, 0, width, height);
    frame.setString(1, 0, truncateToWidth('Approval details (read only)', width - 2), TITLE_STYLE);
    lines.slice(offset, offset + rows).forEach((line, index) => {
      frame.setString(2, index + 1, line, ACTION_STYLE);
    });
    frame.setString(1, height - 1, truncateToWidth('↑/↓ PgUp/PgDn scroll · Home top · Esc back', width - 2), HINT_STYLE);
    return { height, cursor: null };
  }
  const model = buildApprovalPanel(state, width);
  const maxHeight = Math.max(3, height - 1);
  const panelHeight = Math.min(model.lines.length + 1, maxHeight);
  const top = height - panelHeight;
  const inner = contentWidth(width);
  const contentRows = Math.max(0, panelHeight - 1);

  frame.fill(BG, 0, top, width, panelHeight);
  frame.setString(0, top, '─'.repeat(width), BORDER_STYLE);
  frame.setString(1, top, truncateToWidth(' Approval required ', Math.max(0, width - 2)), TITLE_STYLE);

  for (let index = 0; index < Math.min(contentRows, model.lines.length); index += 1) {
    const line = model.lines[index];
    if (line === undefined) continue;
    frame.setString(2, top + 1 + index, truncateToWidth(line.text, inner), line.style);
  }

  let cursor: { x: number; y: number } | null = null;
  if (
    state.editingReason &&
    model.cursorRow !== undefined &&
    model.cursorColumn !== undefined &&
    model.cursorRow < contentRows &&
    model.cursorRow < model.lines.length
  ) {
    cursor = {
      x: Math.min(width - 3, 2 + Math.max(0, model.cursorColumn)),
      y: top + 1 + model.cursorRow,
    };
  }

  return { height: panelHeight, cursor };
}
