import { ATTR_BOLD, type CellBuffer } from '../terminal/buffer.js';
import { TUI_COLORS, type TuiTipsState } from '../state/types.js';
import { truncateToWidth, wrapText } from '../text/index.js';

export interface TipsPreview {
  readonly listRows: number;
  readonly top: number;
  readonly rows: number;
  readonly lines: readonly string[];
  readonly maxOffset: number;
  readonly offset: number;
}

/** Shared geometry keeps preview paging in sync with drawing, including resize. */
export function tipsPreview(tips: TuiTipsState, width: number, height: number): TipsPreview {
  const listRows = Math.min(tips.items.length, 6, Math.max(0, Math.floor((height - 5) / 2)));
  const top = listRows + 3;
  const rows = Math.max(1, height - top - 2);
  const lines = wrapText(tips.items[tips.index] ?? '', Math.max(1, width - 4));
  const maxOffset = Math.max(0, lines.length - rows);
  return { listRows, top, rows, lines, maxOffset, offset: Math.min(tips.offset, maxOffset) };
}

/** Local UI only: no transcript cells or model messages are created. */
export function renderTipsPanel(frame: CellBuffer, width: number, height: number, tips: TuiTipsState): void {
  const bg = TUI_COLORS.planBg;
  frame.fill({ bg }, 0, 0, width, height);
  if (width < 8 || height < 6) {
    frame.setString(0, 0, truncateToWidth('Tips · Esc close', width), { bg });
    return;
  }
  const inner = Math.max(1, width - 4);
  const draw = (row: number, text: string, active = false): void => {
    frame.setString(2, row, truncateToWidth(text, inner), {
      bg, fg: active ? TUI_COLORS.accent : TUI_COLORS.muted,
      ...(active ? { attrs: ATTR_BOLD } : {}),
    });
  };
  const preview = tipsPreview(tips, width, height);
  draw(0, 'Tips · ' + (tips.index + 1) + '/' + tips.items.length, true);
  const start = Math.max(0, Math.min(tips.index - Math.floor(preview.listRows / 2), tips.items.length - preview.listRows));
  for (let row = 0; row < preview.listRows; row++) {
    const index = start + row;
    draw(row + 1, (index === tips.index ? '› ' : '  ') + (index + 1) + '. ' + tips.items[index], index === tips.index);
  }
  draw(preview.top - 1, 'Preview · ' + (preview.offset + 1) + '–' + Math.min(preview.lines.length, preview.offset + preview.rows)
    + '/' + preview.lines.length);
  preview.lines.slice(preview.offset, preview.offset + preview.rows).forEach((line, row) => draw(preview.top + row, line, true));
  draw(height - 1, '↑/↓ choose · Enter fill input · Esc cancel · PgUp/PgDn read');
}
