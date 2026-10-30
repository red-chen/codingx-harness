import { TUI_COLORS, TRANSCRIPT_COLORS } from '../state/types.js';
import { ATTR_BOLD, ATTR_DIM } from '../terminal/buffer.js';
import type { CellBuffer, Style } from '../terminal/buffer.js';
import type { Rect } from '../layout/index.js';
import { displayWidth, tildifyPath, truncateToWidth } from '../text/index.js';
import type { ReasoningEffort } from '../../providers/types.js';

/** Bottom metadata row: model · cwd · current session title. */
export interface MetaBarOptions {
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly cwd: string;
  readonly home?: string;
  readonly title?: string;
}

const MODEL: Style = { fg: TUI_COLORS.accent, attrs: ATTR_BOLD };
const MUTED: Style = { attrs: ATTR_DIM };
const CWD: Style = { fg: TRANSCRIPT_COLORS.command };
const TITLE: Style = { fg: TUI_COLORS.success };

export const META_SEPARATOR = ' · ';
export const NEW_SESSION_TITLE = 'New session';

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function shortPath(cwd: string, max: number, home?: string): string {
  const clean = oneLine(tildifyPath(cwd, home));
  if (displayWidth(clean) <= max) return clean;
  const tilde = clean.startsWith('~/');
  const body = tilde ? clean.slice(2) : clean;
  let result = '';
  for (const part of body.split('/').filter(Boolean).reverse()) {
    const next = '/' + part + result;
    const candidate = (tilde ? '~' : '') + '…' + next;
    if (displayWidth(candidate) > max) break;
    result = next;
  }
  return result.length > 0 ? (tilde ? '~' : '') + '…' + result : '…';
}

function cwdBudget(width: number): number {
  return Math.max(width >= 60 ? 12 : 8, Math.floor(width * (width >= 60 ? 0.4 : 0.2)));
}

/** Height of the metadata row; hidden on very narrow terminals. */
export function metaHeight(width: number): number {
  return width >= 40 ? 1 : 0;
}

function modelLabel(options: MetaBarOptions, width: number): string {
  const effort = options.reasoningEffort ? ' (' + options.reasoningEffort + ')' : '';
  return truncateToWidth(oneLine(options.model) || 'model', Math.max(1, width - displayWidth(effort))) + effort;
}

export function metaText(options: MetaBarOptions, width: number): string {
  if (width < 40) return '';
  return metaPieces(options, width).map((piece) => piece.text).join('');
}

/** Give the model/effort the full row before budgeting optional metadata. */
function metaPieces(options: MetaBarOptions, width: number): Array<{ text: string; style: Style }> {
  const model = modelLabel(options, width);
  const pieces = [{ text: model, style: MODEL }];
  const separatorWidth = displayWidth(META_SEPARATOR);
  let remaining = width - displayWidth(model);
  if (remaining > separatorWidth) {
    const cwd = shortPath(options.cwd, Math.min(cwdBudget(width), remaining - separatorWidth), options.home);
    if (cwd) {
      pieces.push({ text: META_SEPARATOR, style: MUTED }, { text: cwd, style: CWD });
      remaining -= separatorWidth + displayWidth(cwd);
    }
  }
  if (remaining > separatorWidth) {
    const title = truncateToWidth(oneLine(options.title ?? '') || NEW_SESSION_TITLE, remaining - separatorWidth);
    pieces.push({ text: META_SEPARATOR, style: MUTED }, { text: title, style: TITLE });
  }
  return pieces;
}

export function renderMetaBar(area: Rect, frame: CellBuffer, options: MetaBarOptions): number {
  if (area.width <= 0 || area.height <= 0 || metaHeight(area.width) === 0) return 0;
  const pieces = metaPieces(options, area.width);
  let x = area.x;
  const right = area.x + area.width;
  for (const piece of pieces) {
    if (x >= right) break;
    const clipped = truncateToWidth(piece.text, right - x);
    if (clipped.length === 0) break;
    frame.setString(x, area.y, clipped, piece.style);
    x += displayWidth(clipped);
  }
  return 1;
}
