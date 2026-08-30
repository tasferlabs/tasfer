/**
 * The nested-caret geometry seam.
 *
 * Core resolves a caret rect two ways — in viewport space for painting, in
 * document space for scroll-into-view and menu anchoring — and both used to end
 * at `TextNode.caretRect`, which addresses flat block text by index. A block
 * whose text lives entirely in a structured attachment has no such index, so
 * this helper gives both callers one place to ask the owning node for the rect
 * of a {@link ContentPoint} instead (see {@link Node.contentCaretRect}).
 *
 * Nodes that do not implement the hook return nothing here, and the caller falls
 * through to its existing text-node path unchanged.
 */

import type { Block } from "../../serlization/loadPage";
import type { EditorState, EditorStyles } from "../../state-types";
import type { ContentPoint } from "../../structured-selection";
import type { NodeCaretRect, Point } from "./Node";

/**
 * Ask the block's node for the caret rect of `point`, in the coordinate space
 * `origin` is expressed in. Returns `null` when no node is registered, the node
 * declares no nested caret geometry, or the point is not one it can place.
 */
export function contentPointCaretRect(
  point: ContentPoint,
  block: Block,
  blockIndex: number,
  state: EditorState,
  maxWidth: number,
  styles: EditorStyles,
  origin: Point,
): NodeCaretRect | null {
  const node = state.nodes.get(block.type);
  if (!node?.contentCaretRect) return null;
  const layout = node.layout({
    block,
    blockIndex,
    maxWidth,
    isFirst: false,
    styles,
    marks: state.marks,
  });
  return node.contentCaretRect(layout, point, {
    state,
    block,
    blockIndex,
    maxWidth,
    isFirst: false,
    styles,
    marks: state.marks,
    origin,
  });
}

/**
 * Whether `block` currently owns the caret through its own structured content.
 *
 * The paint-side companion to {@link contentPointCaretRect}. Core's cursor paths
 * gate on `isTextualBlock`, which is right for a caret addressed by an index
 * into flat block text but wrong for a block that has none — without this the
 * engine resolves the rect and then refuses to draw it. Asking the node
 * registry keeps that gate node-agnostic: a block passes because its node
 * declares nested caret geometry, never because core recognizes its type.
 */
export function blockOwnsContentCaret(
  block: Block,
  state: EditorState,
): boolean {
  if (state.document.contentSelection?.focus.blockId !== block.id) return false;
  return nodePlacesContentCaret(block, state);
}

/**
 * Whether `block`'s node can place a caret inside its own structured content at
 * all — the same gate as {@link blockOwnsContentCaret} minus the "is it the
 * LOCAL caret" question.
 *
 * A remote peer's caret is a decoration, not the local selection, so it needs
 * the capability test on its own: a peer editing a table cell must be drawn
 * whether or not the local caret is anywhere near that block.
 */
export function nodePlacesContentCaret(
  block: Block,
  state: EditorState,
): boolean {
  return Boolean(state.nodes.get(block.type)?.contentCaretRect);
}
