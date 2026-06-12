/**
 * UnknownNode — the render fallback for a block whose type has no registered
 * node in this editor's NodeRegistry.
 *
 * This is the "preserve and degrade" half of schema extensibility: a peer can
 * send ops for a block type we don't have registered (a newer or host-specific
 * schema). The CRDT keeps the block and its data; this node makes it VISIBLE
 * as a labeled placeholder rather than silently drawing nothing — so the user
 * knows content exists that this build can't render, and the block still
 * occupies space and participates in selection.
 *
 * It is not registered under any type key; the renderer reaches for it only
 * when a lookup misses. One shared stateless instance (`unknownNode`) is safe
 * across editors, like the other built-in node singletons.
 */

import type { Block } from "../../serlization/loadPage";
import type { BlockBounds } from "../../state-types";
import { AtomicNode } from "./AtomicNode";
import type { NodeLayoutCtx, NodePaintCtx } from "./Node";

const PLACEHOLDER_HEIGHT = 44;
const PADDING_BOTTOM = 8;

export class UnknownNode extends AtomicNode<Block> {
  // Not dispatched by type — used as the registry-miss fallback. The value is
  // a sentinel that can never collide with a real block type.
  readonly type = "__unknown__" as Block["type"];

  protected intrinsicHeight(_c: NodeLayoutCtx): number {
    return PLACEHOLDER_HEIGHT;
  }

  protected draw(box: BlockBounds, c: NodePaintCtx): void {
    const ctx = c.ctx;
    const style = c.styles.unknownBlock;
    const h = box.height - PADDING_BOTTOM;
    ctx.save();

    // Muted dashed box.
    ctx.fillStyle = style.backgroundColor;
    ctx.fillRect(box.x, box.y, box.width, h);
    ctx.strokeStyle = style.borderColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width - 1, h - 1);

    // Label: the unrenderable block type.
    ctx.setLineDash([]);
    ctx.fillStyle = style.textColor;
    ctx.font = style.fontFamily;
    ctx.textBaseline = "middle";
    const label = `Unsupported block: ${c.block.type}`;
    ctx.fillText(label, box.x + 12, box.y + h / 2, box.width - 24);

    ctx.restore();
  }
}

/** Shared stateless fallback node — see the renderer's registry-miss path. */
export const unknownNode = new UnknownNode();
