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
import type { TextStyle } from "./state-types";
import { isTextualBlock } from "./sync/block-registry";
import {
  getVisibleLengthFromRuns,
  getVisibleTextFromRuns,
} from "./sync/char-runs";

/**
 * Apply a block's own `style` overrides (layer 3 of the style cascade) on top of
 * a resolved per-type {@link TextStyle}. The honored keys and their expected
 * types are NOT hardcoded — they are derived from `base`, the resolved style
 * itself: a key in the open `style` bag overrides only when it is one `base`
 * carries AND its value matches that key's resolved type (so an untrusted bag —
 * from the network or a consumer — can't poison a `TextStyle` with a wrong-typed
 * value). A key `base` lacks is ignored here; a custom node that understands it
 * reads `block.style` itself. An absent, `null`, or wrong-typed value means "no
 * override". When `TextStyle` grows a field, this needs no change.
 *
 * This is the SINGLE merge point: every text-geometry pass (wrap/measure via the
 * node's `layout`, caret/selection, hit-testing) goes through it (`getTextStyle`
 * and the text nodes both call it), so the caret can never drift from the glyphs
 * a style override paints.
 */
export function mergeBlockStyle(
  base: TextStyle,
  style: Record<string, unknown> | undefined,
): TextStyle {
  if (!style) return base;
  const baseRecord = base as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...baseRecord };
  let changed = false;
  for (const key of Object.keys(baseRecord)) {
    const override = style[key];
    if (override != null && typeof override === typeof baseRecord[key]) {
      merged[key] = override;
      changed = true;
    }
  }
  return changed ? (merged as unknown as TextStyle) : base;
}

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

/**
 * Whether this is an Android browser or WebView (Capacitor / GBoard). Android's
 * soft keyboard re-derives autocapitalization from the text *before the cursor*
 * on every keystroke, so the input surface must mirror real sentence context or
 * it capitalizes every word. iOS/desktop keyboards instead track sentence state
 * from the keystroke stream and work with the bare word, so this gates the
 * sentence-context input-surface behavior to Android only.
 */
export function isAndroid(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/.test(navigator.userAgent || "");
}

/**
 * Whether this is an iOS / iPadOS browser or WKWebView (Capacitor). WebKit drives
 * autocapitalization statefully from the text before the caret, but a leading
 * space makes the surface non-empty at a sentence start, so it never sees a fresh
 * sentence and never capitalizes — so the input surface uses NO leading sentinel
 * on iOS. iOS emits a real Backspace `keydown` (unlike Android), so the sentinel
 * isn't needed for delete either. iPadOS 13+ reports a Mac UA, so fall back to
 * touch.
 */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return ua.includes("Macintosh") && navigator.maxTouchPoints > 1;
}
