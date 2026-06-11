/**
 * LineNode — the `line` (horizontal divider) block ported onto the new API.
 *
 * Compare with the original renderLineBlock (~90 lines): the entire
 * selection-overlay block, bounds construction, and empty-lines plumbing are
 * inherited from AtomicNode. All that's left is "how tall" and "draw the
 * rule" — the genuinely line-specific 4 lines.
 */

import type { BlockBounds } from "../../state-types";
import { AtomicNode } from "./AtomicNode";
import type { BlockRuntimeState, NodeLayoutCtx, NodePaintCtx } from "./Node";

// Line block - horizontal divider/separator
export interface Line extends BlockRuntimeState {
  type: "line";
}

export class LineNode extends AtomicNode<Line> {
  readonly type = "line" as const;

  protected intrinsicHeight(c: NodeLayoutCtx): number {
    return c.styles.blocks.line.height;
  }

  protected draw(box: BlockBounds, c: NodePaintCtx): void {
    const s = c.styles.blocks.line;
    c.ctx.save();
    c.ctx.fillStyle = s.color;
    c.ctx.fillRect(box.x, box.y + s.paddingTop, box.width, s.lineHeight);
    c.ctx.restore();
  }
}
