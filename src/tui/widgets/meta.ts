import type { ReasoningEffort } from '../../providers/types.js';
import { ATTR_BOLD } from '../terminal/buffer.js';
import type { CellBuffer, Style } from '../terminal/buffer.js';
import type { Rect } from '../layout/index.js';
import { displayWidth, tildifyPath, truncateToWidth } from '../text/index.js';
import { TUI_COLORS } from '../state/types.js';

/** Bottom metadata row: model · effort · cwd · current session title. */
export interface MetaBarOptions {
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly cwd: string;
  readonly home?: string;
  readonly title?: string;
}

const MODEL: Style = { fg: TUI_COLORS.accent, attrs: ATTR_BOLD };
const MUTED: Style = { fg: TUI_COLORS.muted };
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

function fit(parts: readonly string[], width: number): string {
  const joined = parts.filter((part) => part.length > 0).join(META_SEPARATOR);
  return truncateToWidth(joined, Math.max(0, width));
}

/** Height of the metadata row; hidden on very narrow terminals. */
export function metaHeight(width: number): number {
  return width >= 40 ? 1 : 0;
}

export function metaText(options: MetaBarOptions, width: number): string {
  if (width < 40) return '';
  const model = oneLine(options.model) || 'model';
  const effort = options.reasoningEffort ? 'effort ' + options.reasoningEffort : '';
  const title = oneLine(options.title ?? '') || NEW_SESSION_TITLE;
  const cwd = options.cwd;
  if (width < 60) {
    const cwdMax = Math.max(8, Math.floor(width * 0.2));
    return fit([model, effort, shortPath(cwd, cwdMax, options.home), title], width);
  }
  const cwdMax = Math.max(12, Math.floor(width * 0.4));
  return fit([model, effort, shortPath(cwd, cwdMax, options.home), title], width);
}

export function renderMetaBar(area: Rect, frame: CellBuffer, options: MetaBarOptions): number {
  if (area.width <= 0 || area.height <= 0 || metaHeight(area.width) === 0) return 0;
  const model = truncateToWidth(oneLine(options.model) || 'model', Math.max(1, Math.floor(area.width * 0.25)));
  const effort = options.reasoningEffort
    ? truncateToWidth('effort ' + options.reasoningEffort, Math.max(8, Math.floor(area.width * 0.18)))
    : '';
  const cwdBudget = Math.max(8, Math.floor(area.width * (area.width >= 60 ? 0.4 : 0.2)));
  const cwd = shortPath(options.cwd, cwdBudget, options.home);
  const separators = ((cwd ? 1 : 0) + (effort ? 1 : 0) + 1) * displayWidth(META_SEPARATOR);
  const titleBudget = Math.max(
    1,
    area.width - displayWidth(model) - displayWidth(effort) - displayWidth(cwd) - separators,
  );
  const title = truncateToWidth(oneLine(options.title ?? '') || NEW_SESSION_TITLE, titleBudget);
  const pieces = [
    { text: model, style: MODEL },
    ...(effort ? [{ text: META_SEPARATOR + effort, style: MUTED }] : []),
    ...(cwd ? [{ text: META_SEPARATOR + cwd, style: MUTED }] : []),
    { text: META_SEPARATOR + title, style: TITLE },
  ];
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