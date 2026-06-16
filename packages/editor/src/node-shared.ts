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

import type { Block } from "./serlization/loadPage";
import { isTextualBlock } from "./sync/block-registry";
import {
  getVisibleLengthFromRuns,
  getVisibleTextFromRuns,
} from "./sync/char-runs";

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
