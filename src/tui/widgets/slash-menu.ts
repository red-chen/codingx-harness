import type { CellBuffer } from '../terminal/buffer.js';
import { ATTR_BOLD } from '../terminal/buffer.js';
import { truncateToWidth } from '../text/index.js';
import type { Rect } from '../layout/index.js';
import { TUI_COLORS } from '../state/types.js';
import type { SlashCommand } from '../state/slash.js';

const SELECTED = { fg: TUI_COLORS.accent, attrs: ATTR_BOLD };
const NAME = { fg: TUI_COLORS.accent };
const DESC = { fg: TUI_COLORS.muted };

/** Floating slash completion menu drawn above the composer. */
export function renderSlashMenu(
  area: Rect,
  frame: CellBuffer,
  commands: readonly SlashCommand[],
  selected: number,
): number {
  if (area.width <= 0 || area.height <= 0) return 0;
  const rows = Math.min(area.height, commands.length);
  for (let index = 0; index < rows; index++) {
    const command = commands[index];
    if (!command) break;
    const y = area.y + index;
    const active = index === Math.min(selected, commands.length - 1);
    frame.setString(area.x, y, active ? '› ' : '  ', active ? SELECTED : DESC);
    const nameWidth = Math.min(12, Math.max(6, Math.floor(area.width * 0.25)));
    frame.setString(area.x + 2, y, command.name.padEnd(nameWidth, ' ').slice(0, nameWidth), active ? SELECTED : NAME);
    const descX = area.x + 2 + nameWidth;
    frame.setString(descX, y, truncateToWidth(command.description, Math.max(0, area.x + area.width - descX)), DESC);
  }
  return rows;
}
