/**
 * Leaf helpers shared by the node views (`TextNode`, `ListNode`, …).
 *
 * These live here — not in `state-utils` — on purpose. `state-utils` imports the
 * node registry (`createDefaultNodeRegistry`) to build the initial state, and the
 * node views import these helpers. If the views pulled them from `state-utils`,
 * that would close a circular import (`state-utils → nodes → TextNode →
 * state-utils`) in which `class ListNode extends TextNode` can evaluate while
 * `TextNode` is still undefined ("Class extends value undefined"). Keeping these
 * two helpers in a dependency-light leaf breaks that cycle. `state-utils`
 * re-exports them, so existing importers are unaffected.
 */

import type { NodeLayout } from "./rendering/nodes/Node";
import type { Block } from "./serlization/loadPage";
import { isTextualBlock } from "./sync/block-registry";
import {
  getVisibleLengthFromRuns,
  getVisibleTextFromRuns,
} from "./sync/char-runs";

/**
 * Memoize a node's canonical layout on the block, keyed by content width. This
 * is the single source of the layout cache: every `Node.layout()` routes its
 * compute through here, so the height pass, paint, hit-testing and the caret/
 * selection passes all share ONE computation per content/width change instead
 * of each re-running the (expensive) layout. The cache is keyed on `maxWidth`
 * only — `isFirst` never affects `layout()` output (the full-bleed-first-image
 * adjustment lives in `adjustFlowHeight`, applied separately) — and is cleared
 * by `invalidateBlockCache` whenever the block's content, styles, or theme
 * change.
 */
export function memoizeNodeLayout<T extends NodeLayout>(
  block: Block,
  maxWidth: number,
  compute: () => T,
): T {
  if (block.cachedLayout && block.cachedLayout.maxWidth === maxWidth) {
    return block.cachedLayout as T;
  }
  // The computed layout carries its own `maxWidth` (set by every `layout()`),
  // which is both the layout's provenance and the single cache key — so the block
  // needs no sibling `cachedWidth`.
  const layout = compute();
  block.cachedLayout = layout;
  return layout;
}

/** Visible (non-deleted) text of a textual block; "" for non-textual blocks. */
export function getBlockTextContent(block: Block): string {
  if (!block) return "";

  if (!isTextualBlock(block)) return "";

  // Get visible text from charRuns
  return getVisibleTextFromRuns(block.charRuns);
}

/** Visible (non-deleted) text length of a textual block; 0 for non-textual blocks. */
export function getBlockTextLength(block: Block): number {
  if (!block) return 0;

  if (!isTextualBlock(block)) return 0;

  return getVisibleLengthFromRuns(block.charRuns);
}

/** Whether the device reports touch support. */
export function isTouchDevice(): boolean {
  return (
    typeof window !== "undefined" &&
    ("ontouchstart" in window || navigator.maxTouchPoints > 0)
  );
}
