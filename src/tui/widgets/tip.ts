import type { Rect } from '../layout/index.js';
import type { CellBuffer } from '../terminal/buffer.js';
import { TUI_COLORS } from '../state/types.js';
import { stripControlSequences, truncateToWidth } from '../text/index.js';

/** A single fixed row, so a long custom tip never crowds out the composer. */
export function tipText(tip: string | undefined, width: number): string {
  const clean = stripControlSequences(tip ?? '').replace(/\s+/gu, ' ').trim();
  if (!clean || width < 12) return '';
  return truncateToWidth('  └ Tip: ' + clean, width);
}

export function renderTipRow(area: Rect, frame: CellBuffer, tip: string | undefined): void {
  if (area.height <= 0) return;
  frame.setString(area.x, area.y, tipText(tip, area.width), { fg: TUI_COLORS.muted });
}
