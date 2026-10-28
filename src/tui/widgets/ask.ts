import type { CellBuffer, Style } from '../terminal/buffer.js';
import { ATTR_BOLD } from '../terminal/buffer.js';
import { TUI_COLORS } from '../state/types.js';
import type { TuiAskState } from '../state/types.js';
import {
  currentAskCustom,
  currentAskQuestion,
  currentAskSelection,
} from '../state/ask.js';
import { displayWidth, truncateToWidth, wrapText } from '../text/index.js';

/**
 * Bottom-anchored modal used by AskUserQuestion. It is drawn last over the
 * composer/meta area and contains only data supplied by the tool call, so
 * model output in the transcript cannot forge buttons or reorder options.
 */

const PANEL_BG = TUI_COLORS.planBg;
const BG: Style = { bg: PANEL_BG };
const BORDER_STYLE: Style = { fg: TUI_COLORS.border, bg: PANEL_BG };
const TITLE_STYLE: Style = { fg: TUI_COLORS.accent, attrs: ATTR_BOLD, bg: PANEL_BG };
const QUESTION_STYLE: Style = { attrs: ATTR_BOLD, bg: PANEL_BG };
const OPTION_STYLE: Style = { bg: PANEL_BG };
const ACTIVE_STYLE: Style = { attrs: ATTR_BOLD, bg: TUI_COLORS.userBg };
const SELECTED_STYLE: Style = { fg: TUI_COLORS.accent, attrs: ATTR_BOLD, bg: PANEL_BG };
const MUTED_STYLE: Style = { fg: TUI_COLORS.muted, bg: PANEL_BG };
const HINT_STYLE: Style = { fg: TUI_COLORS.muted, bg: PANEL_BG };

export interface AskPanelLine {
  readonly text: string;
  readonly style: Style;
}

export interface AskPanelModel {
  readonly lines: readonly AskPanelLine[];
  /** Cursor row index into lines / column within the content area. */
  readonly focusRow?: number;
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

export function buildAskPanel(ask: TuiAskState, width: number): AskPanelModel {
  const question = currentAskQuestion(ask);
  if (question === undefined) return { lines: [{ text: 'No questions.', style: MUTED_STYLE }] };

  const inner = contentWidth(width);
  const lines: AskPanelLine[] = [];
  let focusRow: number | undefined;
  let cursorRow: number | undefined;
  let cursorColumn: number | undefined;

  if (question.header !== undefined && question.header.length > 0) {
    lines.push({ text: truncateToWidth(question.header, inner), style: TITLE_STYLE });
  }
  for (const line of limitedWrap(question.question, inner, 3)) {
    lines.push({ text: line, style: QUESTION_STYLE });
  }
  const selected = currentAskSelection(ask);
  const mode = question.options.length === 0
    ? 'Free text'
    : question.multiSelect ? 'Multi select · ' + selected.length + ' selected' : 'Single select · Choose one';
  lines.push({ text: truncateToWidth(mode, inner), style: MUTED_STYLE });
  lines.push({ text: '', style: OPTION_STYLE });
  question.options.forEach((option, index) => {
    const marker = question.multiSelect
      ? selected.includes(option.label) ? '☑' : '☐'
      : selected.includes(option.label) ? '●' : '○';
    const active = !ask.editing && ask.optionIndex === index;
    const prefix = active ? '› ' : '  ';
    const label = index + 1 + '. ' + option.label;
    if (active) focusRow = lines.length;
    lines.push({
      text: truncateToWidth(prefix + marker + ' ' + label, inner),
      style: active ? ACTIVE_STYLE : selected.includes(option.label) ? SELECTED_STYLE : OPTION_STYLE,
    });
    if (option.description) {
      lines.push({
        text: truncateToWidth('      ' + option.description, inner),
        style: { fg: TUI_COLORS.muted, bg: active ? TUI_COLORS.userBg : PANEL_BG },
      });
    }
  });

  const custom = currentAskCustom(ask);
  if (question.options.length > 0) {
    const otherActive = ask.optionIndex >= question.options.length;
    if (otherActive) focusRow = lines.length;
    const head = (otherActive ? '› ' : '  ') + '✎ Other: ';
    const body = custom.length > 0 ? custom : 'type your own answer';
    lines.push({
      text: truncateToWidth(head + body, inner),
      style: otherActive ? ACTIVE_STYLE : OPTION_STYLE,
    });
    if (ask.editing) {
      cursorRow = lines.length - 1;
      cursorColumn = Math.min(inner - 1, displayWidth(head) + displayWidth(custom.slice(0, ask.cursor)));
    }
  } else {
    lines.push({ text: 'Your answer:', style: MUTED_STYLE });
    const head = '  › ';
    const body = custom.length > 0 ? custom : 'type your answer and press Enter';
    lines.push({
      text: truncateToWidth(head + body, inner),
      style: custom.length > 0 ? OPTION_STYLE : MUTED_STYLE,
    });
    if (ask.editing) {
      cursorRow = lines.length - 1;
      cursorColumn = Math.min(inner - 1, displayWidth(head) + displayWidth(custom.slice(0, ask.cursor)));
    }
  }

  lines.push({ text: '', style: OPTION_STYLE });
  const hint = ask.editing
    ? 'Type an answer · Enter confirm · Esc back'
    : question.multiSelect
      ? '↑/↓ move · Space/1–6 toggle · Enter submit · Esc cancel'
      : '↑/↓ move · 1–6 select · Enter confirm · Esc cancel';
  lines.push({ text: truncateToWidth(hint, inner), style: HINT_STYLE });

  return {
    lines,
    ...((cursorRow ?? focusRow) === undefined ? {} : { focusRow: cursorRow ?? focusRow }),
    ...(cursorRow === undefined || cursorColumn === undefined ? {} : { cursorRow, cursorColumn }),
  };
}

/** Total height including the top rule. */
export function askPanelHeight(ask: TuiAskState, width: number): number {
  return buildAskPanel(ask, width).lines.length + 1;
}

export interface AskPanelRender {
  readonly height: number;
  readonly cursor: { x: number; y: number } | null;
}

/** Draw the modal over the bottom of the screen and return the caret position. */
export function renderAskPanel(
  frame: CellBuffer,
  width: number,
  height: number,
  ask: TuiAskState,
): AskPanelRender {
  if (width < 12 || height < 4) return { height: 0, cursor: null };
  const model = buildAskPanel(ask, width);
  const maxHeight = Math.max(3, height - 1);
  const panelHeight = Math.min(model.lines.length + 1, maxHeight);
  const top = height - panelHeight;
  const inner = contentWidth(width);
  const contentRows = Math.max(0, panelHeight - 1);

  frame.fill(BG, 0, top, width, panelHeight);
  frame.setString(0, top, '─'.repeat(width), BORDER_STYLE);
  const counter = ask.questions.length > 1 ? ' · ' + (ask.index + 1) + '/' + ask.questions.length : '';
  const title = ' Ask user' + counter + ' ';
  frame.setString(1, top, truncateToWidth(title, Math.max(0, width - 2)), TITLE_STYLE);

  // Keep the focused choice visible when the terminal cannot fit the whole panel.
  const offset = Math.max(0, Math.min(
    (model.focusRow ?? 0) - contentRows + 2,
    model.lines.length - contentRows,
  ));
  for (let index = 0; index < Math.min(contentRows, model.lines.length - offset); index += 1) {
    const line = model.lines[index + offset];
    if (line === undefined) continue;
    frame.fill(line.style, 1, top + 1 + index, width - 2, 1);
    frame.setString(2, top + 1 + index, truncateToWidth(line.text, inner), line.style);
  }

  let cursor: { x: number; y: number } | null = null;
  if (
    ask.editing &&
    model.cursorRow !== undefined &&
    model.cursorColumn !== undefined &&
    model.cursorRow >= offset &&
    model.cursorRow - offset < contentRows &&
    model.cursorRow < model.lines.length
  ) {
    cursor = {
      x: Math.min(width - 3, 2 + Math.max(0, model.cursorColumn)),
      y: top + 1 + model.cursorRow - offset,
    };
  }

  return { height: panelHeight, cursor };
}
