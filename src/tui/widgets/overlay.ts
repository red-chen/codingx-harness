import { ATTR_BOLD } from '../terminal/buffer.js';
import type { CellBuffer } from '../terminal/buffer.js';
import { TUI_COLORS } from '../state/types.js';
import type { StyledTextLine } from './welcome.js';
import { drawStyledLine } from './welcome.js';
import type { Rect } from '../layout/index.js';
import { COPY_SHORTCUT } from '../hints.js';

const BORDER = { fg: TUI_COLORS.border };
const TITLE = { fg: TUI_COLORS.accent, attrs: ATTR_BOLD };
const KEY = { fg: TUI_COLORS.accent };
const TEXT = { fg: TUI_COLORS.muted };
const BG = { bg: TUI_COLORS.planBg };

const HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['Enter', 'submit'],
  ['Shift+Enter', 'newline'],
  ['Tab (empty input)', 'fill current tip'],
  ['Tab (with input)', 'complete command / queue while working'],
  ['!<command>', 'run shell locally'],
  ['/process', 'list processes; logs <id> / stop <id>'],
  ['/tips', 'select a tip to fill the input'],
  ['Esc / Ctrl+C', 'interrupt'],
  ['↑ / ↓', 'input history (200 entries per cwd)'],
  ['Ctrl+R', 'search input history; Enter accept, Esc cancel'],
  ['Ctrl+T', 'transcript'],
  ['Ctrl+O', 'tool output details'],
  ['PgUp/PgDn', 'scroll'],
  ['Ctrl+Y', 'copy all regions'],
  ['Drag', 'select text'],
  [COPY_SHORTCUT, 'copy selection'],
  ['?', 'shortcuts'],
  ['Ctrl+C twice', 'exit'],
];

/**
 * Static help modal. It is drawn last and contains only constants, so model
 * output/transcript text cannot forge or replace any option.
 */
export function renderHelpOverlay(frame: CellBuffer, width: number, height: number): void {
  if (width < 12 || height < 6) return;
  const boxWidth = Math.min(64, Math.max(12, width - 4));
  const boxHeight = Math.min(HELP_ROWS.length + 4, height - 2);
  const x = Math.floor((width - boxWidth) / 2);
  const y = Math.floor((height - boxHeight) / 2);
  const area: Rect = { x, y, width: boxWidth, height: boxHeight };

  frame.fill(BG, x, y, boxWidth, boxHeight);
  frame.setString(x, y, '╭' + '─'.repeat(Math.max(0, boxWidth - 2)) + '╮', BORDER);
  frame.setString(x, y + boxHeight - 1, '╰' + '─'.repeat(Math.max(0, boxWidth - 2)) + '╯', BORDER);
  for (let row = y + 1; row < y + boxHeight - 1; row++) {
    frame.setString(x, row, '│', BORDER);
    frame.setString(x + boxWidth - 1, row, '│', BORDER);
  }
  const title = ' Shortcuts ';
  frame.setString(x + Math.max(2, Math.floor((boxWidth - title.length) / 2)), y, title, TITLE);

  const keyWidth = Math.min(20, Math.max(10, Math.floor(boxWidth * 0.38)));
  const visibleRows = Math.min(HELP_ROWS.length, boxHeight - 3);
  for (let index = 0; index < visibleRows; index++) {
    const entry = HELP_ROWS[index];
    if (!entry) continue;
    const line: StyledTextLine = {
      segments: [
        { text: entry[0].padEnd(keyWidth, ' ').slice(0, keyWidth), style: KEY },
        { text: entry[1], style: TEXT },
      ],
    };
    drawStyledLine(frame, { x: x + 2, y: y + 1 + index, width: Math.max(0, boxWidth - 4), height: 1 }, y + 1 + index, line);
  }
  const closeY = y + boxHeight - 2;
  if (closeY > y) {
    drawStyledLine(
      frame,
      { x: x + 2, y: closeY, width: Math.max(0, boxWidth - 4), height: 1 },
      closeY,
      { segments: [{ text: 'q / Esc to close', style: TEXT }] },
    );
  }
}

export function renderPickerOverlay(frame: CellBuffer, width: number, height: number, picker: NonNullable<import('../state/types.js').TuiAppState['picker']>): void {
  const x = 2, y = 1, w = Math.max(1,width-4), h = Math.max(1,height-2);
  frame.fill(BG,x,y,w,h);
  const draw = (row: number, text: string, selected = false): void => {
    drawStyledLine(frame, { x:x+1, y:y+row, width:Math.max(1,w-2), height:1 }, y+row, { segments: [{ text, style:selected ? KEY : TEXT }] });
  };
  draw(0,picker.title,true); draw(1,'> ' + picker.query);
  const query = (picker.purpose === 'file' ? picker.query.replace(/:\d+:\d+$/, '') : picker.query).toLowerCase();
  const entries = picker.entries.filter(e => (e.label+' '+e.value).toLowerCase().includes(query));
  const count = Math.max(1,h-6), start = Math.max(0,picker.index-count+1);
  entries.slice(start,start+count).forEach((e,i) => draw(i+3,(i+start === picker.index ? '› ' : '  ') + e.label + (e.disabled ? ' [unavailable]' : ''), i+start === picker.index));
  if (h>5) draw(h-2,entries[picker.index]?.detail ?? 'No matching entries.');
  draw(h-1,'↑↓ select · Enter accept · Esc cancel');
}
