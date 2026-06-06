/**
 * LineBlockView — the `line` (horizontal divider) block ported onto the new API.
 *
 * Compare with the original renderLineBlock (~90 lines): the entire
 * selection-overlay block, bounds construction, and empty-lines plumbing are
 * inherited from AtomicBlockView. All that's left is "how tall" and "draw the
 * rule" — the genuinely line-specific 4 lines.
 */

import type { Line } from "../../serlization/loadPage";
import type { BlockBounds } from "../../state-types";
import { AtomicBlockView } from "./AtomicBlockView";
import type { BlockLayoutCtx, BlockPaintCtx } from "./BlockView";

export class LineBlockView extends AtomicBlockView<Line> {
  readonly type = "line" as const;

  protected intrinsicHeight(c: BlockLayoutCtx): number {
    return c.styles.blocks.line.height;
  }

  protected draw(box: BlockBounds, c: BlockPaintCtx): void {
    const s = c.styles.blocks.line;
    c.ctx.save();
    c.ctx.fillStyle = s.color;
    c.ctx.fillRect(box.x, box.y + s.paddingTop, box.width, s.lineHeight);
    c.ctx.restore();
  }
}
