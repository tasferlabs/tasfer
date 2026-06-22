/**
 * AtomicNode — convenience base for void/embed blocks (line, image, math,
 * video, …). These have no text caret: just an intrinsic-sized box with custom
 * drawing. Subclasses override two methods:
 *
 *   intrinsicHeight(c) — how tall is this block at the given width?
 *   draw(box, c)       — paint the visual content inside `box`
 *
 * Everything else — the selection-overlay boilerplate (range decorations +
 * local selection), bounds construction, empty line list — is handled here.
 * That overlay logic is currently copy-pasted into renderLineBlock /
 * renderImageBlock / renderMathBlock; this folds it into one place.
 */

import { memoizeNodeLayout } from "../../node-shared";
import type { Image } from "../../nodes/ImageNode";
import type { Line } from "../../nodes/LineNode";
import type { MathBlock } from "../../nodes/MathNode";
import type { Block } from "../../serlization/loadPage";
import type { BlockBounds, RenderedBlock } from "../../state-types";
import { allDecorations, rangeDecorationToSelection } from "../decorations";
import {
  Node,
  type NodeLayout,
  type NodeLayoutCtx,
  type NodePaintCtx,
  type Point,
} from "./Node";

// Visual blocks contain visual content (images, lines, math, etc.). Each concrete
// type lives next to its own view; this is just the union over them.
export type VisualBlock = Image | Line | MathBlock;

export abstract class AtomicNode<B extends Block = Block> extends Node<B> {
  /**
   * Vertical flow the block consumes, including its own trailing padding.
   * This is what the height pass returns and the document layout advances by.
   */
  protected abstract intrinsicHeight(c: NodeLayoutCtx): number;

  /** Draw the visual content into `box` (the painted rect). */
  protected abstract draw(box: BlockBounds, c: NodePaintCtx): void;

  /**
   * Optional on-top chrome drawn AFTER the selection overlay (e.g. image resize
   * handles, which must stay visible over a selection tint). Default no-op.
   */
  protected drawChrome(_box: BlockBounds, _c: NodePaintCtx): void {}

  /**
   * The rectangle actually painted + selected, which may differ from the flow
   * box: narrower/centered (constrained image), wider (full-bleed), or shorter
   * (height excludes trailing padding). Default: the full flow box.
   */
  protected paintBox(c: NodePaintCtx): BlockBounds {
    return this.bounds(c, this.intrinsicHeight(c));
  }

  /**
   * Hit-test the block's interactive box without a canvas. `origin` is the
   * block's content origin in the caller's coordinate space; `point` the
   * pointer position in the same space. Returns the interactive box when the
   * point is inside it, else null. Subclasses override when the interactive
   * box differs from the flow box (e.g. a centered/contained image).
   *
   * This is the single dispatch point the event layer uses to map a pointer
   * to an atomic block — new node types are hit-testable automatically.
   */
  hitTestBox(
    c: NodeLayoutCtx,
    origin: Point,
    point: Point,
  ): BlockBounds | null {
    const box: BlockBounds = {
      x: origin.x,
      y: origin.y,
      width: c.maxWidth,
      height: this.intrinsicHeight(c),
    };
    const inside =
      point.x >= box.x &&
      point.x < box.x + box.width &&
      point.y >= box.y &&
      point.y < box.y + box.height;
    return inside ? box : null;
  }

  layout(c: NodeLayoutCtx): NodeLayout {
    // Memoized like text blocks (see memoizeNodeLayout): keeps repeated height
    // passes / hit-tests from re-running intrinsicHeight (e.g. an image's
    // geometry lookup or a math block's LaTeX layout) every frame and move.
    return memoizeNodeLayout(c.block, c.maxWidth, () => ({
      height: this.intrinsicHeight(c),
      lines: [],
      maxWidth: c.maxWidth,
    }));
  }

  paint(layout: NodeLayout, c: NodePaintCtx): RenderedBlock {
    const box = this.paintBox(c);

    // Order matches the original visual blocks: content, then selection tint
    // on top of it, then chrome (e.g. resize handles) on top of everything.
    // Wrap content draw so it can't leak canvas state to later blocks.
    c.ctx.save();
    this.draw(box, c);
    c.ctx.restore();
    this.paintRangeDecorations(box, c);
    this.paintLocalSelection(box, c);
    this.drawChrome(box, c);

    // Bounds keep the painted rect's position/width but report the full flow
    // height, matching the document's vertical advance for this block.
    return {
      block: c.block,
      bounds: { x: box.x, y: box.y, width: box.width, height: layout.height },
      lines: [],
    };
  }

  // -- shared selection-overlay machinery (was duplicated per visual block) --

  private paintRangeDecorations(box: BlockBounds, c: NodePaintCtx): void {
    const { state, ctx, blockIndex } = c;

    for (const deco of allDecorations(state.ui.decorations)) {
      if (deco.kind !== "range") continue;
      const selection = rangeDecorationToSelection(
        deco.range,
        state.document.page,
      );
      if (!selection || selection.isCollapsed) continue;

      if (this.coversBlock(selection, blockIndex)) {
        ctx.save();
        ctx.fillStyle = deco.color;
        ctx.globalAlpha = deco.opacity ?? 0.2;
        ctx.fillRect(box.x, box.y, box.width, box.height);
        ctx.restore();
      }
    }
  }

  private paintLocalSelection(box: BlockBounds, c: NodePaintCtx): void {
    const { state, ctx, styles, blockIndex } = c;
    const selection = state.document.selection;
    if (!selection || selection.isCollapsed) return;
    if (!this.coversBlock(selection, blockIndex)) return;

    ctx.save();
    ctx.fillStyle = styles.selection.backgroundColor;
    ctx.globalAlpha = styles.selection.opacity;
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.restore();
  }

  /** Does this multi/visual-block selection include `blockIndex`? */
  private coversBlock(
    selection: {
      anchor: { blockIndex: number };
      focus: { blockIndex: number };
    },
    blockIndex: number,
  ): boolean {
    const { anchor, focus } = selection;
    const start = Math.min(anchor.blockIndex, focus.blockIndex);
    const end = Math.max(anchor.blockIndex, focus.blockIndex);
    return blockIndex >= start && blockIndex <= end;
  }
}
