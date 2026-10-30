import { ATTR_BOLD, CellBuffer } from './terminal/buffer.js';
import { length, min, rect, splitVertical } from './layout/index.js';
import type { Rect } from './layout/index.js';
import { TUI_COLORS, type TuiAppState } from './state/types.js';
import { composerCursorPosition, composerHeight, queuePreviewHeight, renderComposer, renderQueuePreview } from './widgets/composer.js';
import { metaHeight, renderMetaBar } from './widgets/meta.js';
import { renderStatusRow } from './widgets/status.js';
import { renderTranscript } from './widgets/transcript.js';
import { renderHelpOverlay } from './widgets/overlay.js';
import { TRANSCRIPT_COPY_HINT } from './hints.js';
import { renderAskPanel } from './widgets/ask.js';
import { renderApprovalPanel } from './widgets/approval.js';
import { renderSlashMenu } from './widgets/slash-menu.js';
import { slashMenuHeight, slashMatches } from './state/slash.js';

/**
 * Frame composition for the TUI assembly. Pure drawing only: it receives an
 * immutable TuiAppState, measures the fixed bottom pane, splits the viewport
 * with the kernel layout helpers and paints into a fresh CellBuffer.
 */

export interface FrameLayout {
  readonly width: number;
  readonly height: number;
  readonly transcript: Rect;
  readonly statusGapTop: Rect;
  readonly status: Rect;
  readonly statusGapBottom: Rect;
  readonly queue: Rect;
  readonly slash: Rect;
  readonly composer: Rect;
  readonly meta: Rect;
}

export interface ComposeFrameOptions {
  readonly width?: number;
  readonly height?: number;
  /** Clock injection for the status elapsed time. */
  readonly now?: number;
}

function dimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/**
 * Split the viewport into a flexible transcript plus a fixed bottom pane.
 * Tighter heights sacrifice the queue preview and metadata before the composer.
 */
export function computeFrameLayout(state: TuiAppState, width: number, height: number): FrameLayout {
  const w = dimension(width, 0);
  const h = dimension(height, 0);
  const screen = rect(0, 0, w, h);

  const desiredStatus = h > 0 ? 1 : 0;
  const desiredComposer = composerHeight(state.composer, w);
  const desiredQueue = queuePreviewHeight(state.queue);
  const desiredSlash = state.mode === 'main' ? slashMenuHeight(state.composer.text, state.slashDismissed) : 0;
  const desiredMeta = metaHeight(w);
  const desiredStatusGap = h >= 8 ? 1 : 0;

  let available = h;
  const statusHeight = Math.min(desiredStatus, available);
  available -= statusHeight;
  const composerApplied = Math.min(desiredComposer, available);
  available -= composerApplied;
  const metaApplied = Math.min(desiredMeta, available);
  available -= metaApplied;
  const gapTopApplied = Math.min(desiredStatusGap, available);
  available -= gapTopApplied;
  const gapBottomApplied = Math.min(desiredQueue > 0 ? 0 : desiredStatusGap, available);
  available -= gapBottomApplied;
  const queueApplied = Math.min(desiredQueue, available);
  available -= queueApplied;
  const slashApplied = Math.min(desiredSlash, available);
  available -= slashApplied;
  const bottomHeight =
    gapTopApplied + statusHeight + gapBottomApplied + queueApplied + slashApplied + composerApplied + metaApplied;

  const [transcriptArea, bottomArea] = splitVertical(screen, [min(0), length(bottomHeight)]);
  const bottom = bottomArea ?? rect(0, h, w, 0);
  const [gapTopArea, statusArea, gapBottomArea, queueArea, slashArea, composerArea, metaArea] = splitVertical(bottom, [
    length(gapTopApplied),
    length(statusHeight),
    length(gapBottomApplied),
    length(queueApplied),
    length(slashApplied),
    length(composerApplied),
    length(metaApplied),
  ]);

  return {
    width: w,
    height: h,
    transcript: transcriptArea ?? rect(0, 0, w, 0),
    statusGapTop: gapTopArea ?? rect(0, 0, w, 0),
    status: statusArea ?? rect(0, 0, w, 0),
    statusGapBottom: gapBottomArea ?? rect(0, 0, w, 0),
    queue: queueArea ?? rect(0, 0, w, 0),
    slash: slashArea ?? rect(0, 0, w, 0),
    composer: composerArea ?? rect(0, 0, w, 0),
    meta: metaArea ?? rect(0, 0, w, 0),
  };
}

export interface ComposedFrame {
  readonly frame: CellBuffer;
  readonly cursor: { x: number; y: number } | null;
}

export function composeFrame(state: TuiAppState, options: ComposeFrameOptions = {}): CellBuffer {
  return composeFrameWithCursor(state, options).frame;
}

export function composeFrameWithCursor(state: TuiAppState, options: ComposeFrameOptions = {}): ComposedFrame {
  const width = dimension(options.width, state.width);
  const height = dimension(options.height, state.height);
  const now = options.now ?? Date.now();
  const layout = computeFrameLayout(state, width, height);
  const frame = new CellBuffer(width, height);

  if (state.mode === 'transcript') {
    const content = { x: 0, y: 1, width, height: Math.max(0, height - 2) };
    const bottomRow = { x: 0, y: Math.max(0, height - 1), width, height: height > 0 ? 1 : 0 };
    frame.setString(0, 0, ' Transcript · q/Esc to close · PgUp/PgDn to scroll', {
      fg: TUI_COLORS.accent,
      attrs: ATTR_BOLD,
    });
    renderTranscript(content, frame, {
      cells: state.transcript,
      active: state.activeAssistant,
      scrollOffset: state.scroll.offset,
      welcome: null,
    });
    frame.setString(0, bottomRow.y, ' ' + TRANSCRIPT_COPY_HINT + ' · Ctrl+T to return ', { fg: TUI_COLORS.muted });
    return { frame, cursor: null };
  }

  renderTranscript(layout.transcript, frame, {
    cells: state.transcript,
    active: state.activeAssistant,
    scrollOffset: state.scroll.offset,
    welcome: width >= 40
      ? {
          version: state.version,
          model: state.session.model,
          cwd: state.session.cwd,
          sessionId: state.session.sessionId,
          ...(state.session.home ? { home: state.session.home } : {}),
        }
      : null,
  });

  renderStatusRow(layout.status, frame, {
    status: state.status,
    usage: state.usage,
    contextUsedTokens: state.contextUsedTokens,
    contextWindowTokens: state.contextWindowTokens,
    totalUsage: state.totalUsage,
    turnNumber: state.turnNumber,
    currentTurnSteps: state.currentTurnSteps,
    contextPercent: state.contextPercent,
    awaitingKind: state.mode === 'approval' ? 'approval' : 'answer',
    now,
  });
  renderQueuePreview(layout.queue, frame, state.queue);
  if (state.mode === 'main' && !state.slashDismissed) {
    renderSlashMenu(layout.slash, frame, slashMatches(state.composer.text), state.slashIndex);
  }
  renderComposer(layout.composer, frame, state.composer);
  renderMetaBar(layout.meta, frame, {
    model: state.session.model,
    reasoningEffort: state.session.reasoningEffort,
    cwd: state.session.cwd,
    ...(state.session.home ? { home: state.session.home } : {}),
    ...(state.session.title ? { title: state.session.title } : {}),
  });
  if (state.mode === 'help') renderHelpOverlay(frame, width, height);
  if (state.mode === 'approval' && state.approval !== undefined) {
    const panel = renderApprovalPanel(frame, width, height, state.approval);
    return { frame, cursor: panel.cursor };
  }
  if (state.mode === 'ask' && state.ask !== undefined) {
    const panel = renderAskPanel(frame, width, height, state.ask);
    return { frame, cursor: panel.cursor };
  }
  const cursor = state.mode === 'main' ? composerCursorPosition(state.composer, layout.composer) : null;
  return { frame, cursor };
}
