/**
 * Block view registry wiring (proof-of-concept).
 *
 * Registers the built-in block views. As more blocks are ported (image, math,
 * then the text/list family via a TextBlockView base), they get added here and
 * their `block.type ===` branches in renderer.ts / selection.ts / event-utils
 * collapse into `getBlockView(type)` lookups.
 */

import { registerBlockView } from "./BlockView";
import { ImageBlockView } from "./ImageBlockView";
import { LineBlockView } from "./LineBlockView";
import { textBlockView } from "./TextBlockView";

export { AtomicBlockView } from "./AtomicBlockView";
export {
  type BlockLayout,
  type BlockLayoutCtx,
  type BlockPaintCtx,
  BlockView,
  getBlockView,
  type Point,
  registerBlockView,
} from "./BlockView";
export { ImageBlockView } from "./ImageBlockView";
export { LineBlockView } from "./LineBlockView";
export {
  getContentWithComposition,
  TEXT_BLOCK_TYPES,
  type TextBlockLayout,
  TextBlockView,
  textBlockView,
} from "./TextBlockView";

let registered = false;

/** Idempotently register the built-in block views. */
export function registerBuiltinBlockViews(): void {
  if (registered) return;
  registered = true;
  registerBlockView(new LineBlockView());
  registerBlockView(new ImageBlockView());
  registerBlockView(textBlockView);
}
