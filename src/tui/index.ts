/**
 * Self-contained terminal kernel and TUI assembly.
 *
 * The kernel (terminal/layout/text) has no process globals on its import path.
 * The assembly layer (state/app, widgets, composeFrame) is pure as well: all IO
 * and timers belong to the eventual CLI event loop.
 */

export * from './text/index.js';
export { cellWidth, graphemes } from './terminal/width.js';
export * from './terminal/buffer.js';
export * from './terminal/renderer.js';
export * from './terminal/input.js';
export * from './terminal/session.js';
export * from './layout/index.js';

export * from './state/types.js';
export * from './state/commands.js';
export * from './state/app.js';
export * from './state/ask.js';
export * from './state/restore.js';
export * from './widgets/welcome.js';
export * from './widgets/transcript.js';
export * from './widgets/composer.js';
export * from './widgets/status.js';
export * from './widgets/ask.js';
export * from './app.js';
export * from './runtime.js';
