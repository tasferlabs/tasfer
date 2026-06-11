/**
 * BoxNode — the generic styled void block produced by `defineNode` for custom
 * block types that declare a `render` style rather than supplying their own
 * Node subclass.
 *
 * It is an AtomicNode (no text caret): an intrinsic-height box with optional
 * background, border, left accent bar, and a label/attr readout. Custom node
 * authors who need bespoke drawing pass their own Node to `defineNode`; this
 * covers the common "a styled box with some attrs" case without canvas code.
 */

import type { Block } from "../../serlization/loadPage";
import type { BlockBounds } from "../../state-types";
import { AtomicNode } from "./AtomicNode";
import type { NodeLayoutCtx, NodePaintCtx } from "./Node";

/** Declarative paint style for a {@link BoxNode}. All fields optional. */
export interface BoxRenderStyle {
  /** Box height in px (intrinsic). Default 40. */
  height?: number;
  /** Inner padding in px applied to the label. Default 12. */
  padding?: number;
  /** Trailing flow padding below the box in px. Default 8. */
  marginBottom?: number;
  /** Fill color (any canvas color string). Default none. */
  background?: string;
  /** Border color drawn around the box. Default none. */
  borderColor?: string;
  /** Left accent bar. */
  borderLeft?: { width: number; color: string };
  /** Text color for the label. Default a muted gray. */
  color?: string;
  /**
   * Produce the label drawn inside the box from the block. Default shows the
   * block type. Return "" to draw no label.
   */
  label?: (block: Block) => string;
}

const DEFAULTS = {
  height: 40,
  padding: 12,
  marginBottom: 8,
  color: "rgba(60,60,67,0.85)",
} as const;

export class BoxNode extends AtomicNode<Block> {
  readonly type: Block["type"];
  private readonly style: BoxRenderStyle;

  constructor(type: string, style: BoxRenderStyle = {}) {
    super();
    this.type = type as Block["type"];
    this.style = style;
  }

  protected intrinsicHeight(_c: NodeLayoutCtx): number {
    const h = this.style.height ?? DEFAULTS.height;
    return h + (this.style.marginBottom ?? DEFAULTS.marginBottom);
  }

  protected draw(box: BlockBounds, c: NodePaintCtx): void {
    const s = this.style;
    const ctx = c.ctx;
    const h = s.height ?? DEFAULTS.height;
    const pad = s.padding ?? DEFAULTS.padding;
    ctx.save();

    if (s.background) {
      ctx.fillStyle = s.background;
      ctx.fillRect(box.x, box.y, box.width, h);
    }
    if (s.borderColor) {
      ctx.strokeStyle = s.borderColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width - 1, h - 1);
    }
    if (s.borderLeft) {
      ctx.fillStyle = s.borderLeft.color;
      ctx.fillRect(box.x, box.y, s.borderLeft.width, h);
    }

    const label = (s.label ?? ((b) => b.type))(c.block);
    if (label) {
      ctx.fillStyle = s.color ?? DEFAULTS.color;
      ctx.font =
        '13px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
      ctx.textBaseline = "middle";
      const left = box.x + (s.borderLeft?.width ?? 0) + pad;
      ctx.fillText(label, left, box.y + h / 2, box.width - pad * 2);
    }

    ctx.restore();
  }
}
