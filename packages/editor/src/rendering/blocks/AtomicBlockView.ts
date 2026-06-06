/**
 * AtomicBlockView — convenience base for void/embed blocks (line, image, math,
 * video, …). These have no text caret: just an intrinsic-sized box with custom
 * drawing. Subclasses override two methods:
 *
 *   intrinsicHeight(c) — how tall is this block at the given width?
 *   draw(box, c)       — paint the visual content inside `box`
 *
 * Everything else — the selection-overlay boilerplate (remote awareness +
 * local selection), bounds construction, empty line list — is handled here.
 * That overlay logic is currently copy-pasted into renderLineBlock /
 * renderImageBlock / renderMathBlock; this folds it into one place.
 */

import type { Block } from "../../serlization/loadPage";
import type { BlockBounds, RenderedBlock } from "../../state-types";
import { awarenessSelectionToSelection } from "../../sync/awareness";
import {
  type BlockLayout,
  type BlockLayoutCtx,
  type BlockPaintCtx,
  BlockView,
} from "./BlockView";

export abstract class AtomicBlockView<
  B extends Block = Block,
> extends BlockView<B> {
  /**
   * Vertical flow the block consumes, including its own trailing padding.
   * This is what the height pass returns and the document layout advances by.
   */
  protected abstract intrinsicHeight(c: BlockLayoutCtx): number;

  /** Draw the visual content into `box` (the painted rect). */
  protected abstract draw(box: BlockBounds, c: BlockPaintCtx): void;

  /**
   * Optional on-top chrome drawn AFTER the selection overlay (e.g. image resize
   * handles, which must stay visible over a selection tint). Default no-op.
   */
  protected drawChrome(_box: BlockBounds, _c: BlockPaintCtx): void {}

  /**
   * The rectangle actually painted + selected, which may differ from the flow
   * box: narrower/centered (constrained image), wider (full-bleed), or shorter
   * (height excludes trailing padding). Default: the full flow box.
   */
  protected paintBox(c: BlockPaintCtx): BlockBounds {
    return this.bounds(c, this.intrinsicHeight(c));
  }

  layout(c: BlockLayoutCtx): BlockLayout {
    return { height: this.intrinsicHeight(c), lines: [] };
  }

  paint(layout: BlockLayout, c: BlockPaintCtx): RenderedBlock {
    const box = this.paintBox(c);

    // Order matches the original visual blocks: content, then selection tint
    // on top of it, then chrome (e.g. resize handles) on top of everything.
    // Wrap content draw so it can't leak canvas state to later blocks.
    c.ctx.save();
    this.draw(box, c);
    c.ctx.restore();
    this.paintRemoteSelections(box, c);
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

  private paintRemoteSelections(box: BlockBounds, c: BlockPaintCtx): void {
    const { awareness, state, ctx, blockIndex } = c;
    if (!awareness || awareness.size === 0) return;

    for (const [, a] of awareness) {
      if (!a.selection) continue;
      const selection = awarenessSelectionToSelection(
        a.selection,
        state.document.page,
      );
      if (!selection) continue;

      if (this.coversBlock(selection, blockIndex)) {
        ctx.save();
        ctx.fillStyle = a.user.color;
        ctx.globalAlpha = 0.2;
        ctx.fillRect(box.x, box.y, box.width, box.height);
        ctx.restore();
      }
    }
  }

  private paintLocalSelection(box: BlockBounds, c: BlockPaintCtx): void {
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
