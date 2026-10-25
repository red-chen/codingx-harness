/**
 * Copy/selection hints shown in the TUI.
 *
 * codingx leaves mouse reporting off, so selection is owned by the terminal
 * (iTerm2, Terminal.app, Windows Terminal, ...) and copying is the terminal's
 * own shortcut rather than an OSC52 side effect.
 */
export const IS_MACOS = process.platform === 'darwin';

/** Terminal shortcut for copying the native selection. */
export const COPY_SHORTCUT = IS_MACOS ? '⌘C' : 'Ctrl+Shift+C';

/** One-line hint for the transcript overlay footer. */
export const TRANSCRIPT_COPY_HINT = 'Select text · ' + COPY_SHORTCUT + ' to copy';
