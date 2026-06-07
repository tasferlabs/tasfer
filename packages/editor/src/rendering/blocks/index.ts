/**
 * Block view registry wiring.
 *
 * A `BlockViewRegistry` is per-editor-instance (created at mount, stored on
 * `EditorState.blockViews`) — not a module global. Hosts compose the set of
 * block views they want: pass a custom `blockViews` list to `mountEditor` to
 * opt in/out of block types, or use `createDefaultBlockViewRegistry()` for the
 * built-in set.
 *
 * As blocks are ported they get added to the default set here and their
 * `block.type ===` branches in renderer.ts / selection.ts / event-utils
 * collapse into `registry.get(type)` lookups. The built-in set now covers every
 * block type (line, image, math, and the text/list family).
 */

import { BlockView, BlockViewRegistry } from "./BlockView";
import { ImageBlockView } from "./ImageBlockView";
import { LineBlockView } from "./LineBlockView";
import { listBlockView } from "./ListBlockView";
import { MathBlockView } from "./MathBlockView";
import { textBlockView } from "./TextBlockView";

export { AtomicBlockView } from "./AtomicBlockView";
export {
  type BlockLayout,
  type BlockLayoutCtx,
  type BlockPaintCtx,
  BlockView,
  BlockViewRegistry,
  type Point,
} from "./BlockView";
export { ImageBlockView } from "./ImageBlockView";
export { LineBlockView } from "./LineBlockView";
export {
  LIST_BLOCK_TYPES,
  ListBlockView,
  listBlockView,
} from "./ListBlockView";
export { MathBlockView } from "./MathBlockView";
export {
  getContentWithComposition,
  TEXT_BLOCK_TYPES,
  type TextBlockLayout,
  TextBlockView,
  textBlockView,
} from "./TextBlockView";

/**
 * Shared singleton instances of the stateless built-in views, so hosts can
 * compose a custom `blockViews` list without constructing them by hand. (Views
 * hold no per-editor state — only layout/paint logic — so sharing instances
 * across editors is safe.)
 */
export const lineBlockView = new LineBlockView();
export const imageBlockView = new ImageBlockView();
export const mathBlockView = new MathBlockView();

/**
 * The built-in block views. Constructed lazily (inside the factory) so importing
 * this module has no side effects and no module-init ordering hazards.
 *
 * `textBlockView` backs headings + paragraph; `listBlockView` (a subclass) backs
 * the bullet/numbered/todo family. They register under disjoint type keys, so a
 * host can drop list support entirely by omitting `listBlockView` from a custom
 * `blockViews` list passed to `mountEditor`.
 */
function defaultBlockViews(): BlockView[] {
  return [
    lineBlockView,
    imageBlockView,
    mathBlockView,
    textBlockView,
    listBlockView,
  ];
}

/** Build a registry from an explicit list of views (host opt-in). */
export function createBlockViewRegistry(
  views: readonly BlockView[],
): BlockViewRegistry {
  const registry = new BlockViewRegistry();
  for (const view of views) {
    registry.register(view);
  }
  return registry;
}

/** Build a registry pre-populated with the built-in block views. */
export function createDefaultBlockViewRegistry(): BlockViewRegistry {
  return createBlockViewRegistry(defaultBlockViews());
}
