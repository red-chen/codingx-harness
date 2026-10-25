/**
 * Terminal-layer width helpers.
 *
 * The canonical implementation lives in ../text. This module is the stable
 * import surface for terminal code (buffer/renderer) and additionally exposes
 * short aliases used by the cell buffer.
 */
export {
  displayWidth,
  graphemeSegments,
  graphemeWidth,
  sliceByWidth,
  stripControlSequences,
  truncateToWidth,
  wrapText,
} from '../text/index.js';

export { graphemeSegments as graphemes } from '../text/index.js';
export { graphemeWidth as cellWidth } from '../text/index.js';
