/**
 * math → a replacement renderer (draws a canvas-native formula instead of
 * glyphs).
 *
 * Inline math is a replacement mark: it measures as an atomic unit (the full
 * formula width) and paints the rendered formula. Layout and painting both go
 * through `@cypherkit/tex` — the formula is drawn directly onto the canvas with
 * `paintMath` (no SVG, no bitmap, no async render), so color is just the current
 * text color and it stays crisp at any DPI.
 */

import type { ActionBus } from "../../action-bus";
import { CURSOR_MOVED } from "../../actions/pointer-actions";
import { getCrossedInlineMathSpan } from "../../inline-math-spans";
import {
  getInlineMathCaretRect,
  getInlineMathDims,
  getInlineMathOffsetAtX,
  mathArmScratch,
  mathCaretStep,
  mathCaretTokenClamp,
  mathCaretVerticalStep,
  mathDeleteUnit,
  mathPendingCommandRange,
  mathTransformTypedInput,
} from "../../nodes/math";
import type { MarkCodec } from "../../serlization/codecs/mark-codec";
import type { Block } from "../../serlization/loadPage";
import type {
  CaretDeleteUnit,
  CaretScratch,
  TypedInputTransform,
} from "../../state-types";
import {
  INLINE_MATH_END,
  INLINE_MATH_START,
} from "../../serlization/tokenizer";
import {
  Mark,
  type MarkReplacement,
  type MarkReplacementEdit,
  type MarkStyle,
} from "./Mark";
import { layoutMath, paintMath } from "@cypherkit/tex";

// Math is a REPLACEMENT mark on HTML output (renders an SVG, falling back to
// `$…$` source when no renderer is supplied) — so it wins the run.
const MATH_CODEC: MarkCodec = {
  type: "math",
  toMarkdown: (t) => `$${t}$`,
  tokens: { start: INLINE_MATH_START, end: INLINE_MATH_END },
  html: {
    priority: 0,
    replace: true,
    render: (_inner, _mark, ctx) => {
      try {
        if (!ctx.renderMathSVG) throw new Error("no math renderer");
        return ctx.renderMathSVG(ctx.text, false);
      } catch {
        return `<code>$${ctx.escapeHtml(ctx.text)}$</code>`;
      }
    },
  },
};

/**
 * Source range of a COMPLETE command to keep as literal text — non-undefined
 * only while command-entry is armed at the caret inside this chip (so a finished
 * `\in` shows `\in`, not ∈, until the caret commits it). `measure`/`paint`/
 * `caretRect` all derive it from the same `edit`, so their geometry agrees.
 */
function literalRangeFor(
  text: string,
  edit: MarkReplacementEdit | undefined,
): { start: number; end: number } | undefined {
  return edit?.editing && edit.caretOffset != null
    ? (mathPendingCommandRange(text, edit.caretOffset) ?? undefined)
    : undefined;
}

const inlineMathReplacement: MarkReplacement = {
  measure(text, fontSize, edit) {
    return getInlineMathDims(text, fontSize, literalRangeFor(text, edit));
  },
  caretRect(text, fontSize, offset, edit) {
    return getInlineMathCaretRect(
      text,
      fontSize,
      offset,
      literalRangeFor(text, edit),
    );
  },
  hitTest(text, fontSize, localX, localY) {
    return getInlineMathOffsetAtX(text, fontSize, localX, localY);
  },
  paint({ ctx, text, x, y, fontSize, isRTL, hovered, dims, styles, edit }) {
    const mathStyle = styles.textFormats.inlineMath;
    const mathWidth = dims.width;
    const drawX = isRTL ? x - mathWidth : x;

    if (hovered) {
      const padding = mathStyle.padding;
      ctx.save();
      ctx.fillStyle = mathStyle.hoverBackgroundColor;
      ctx.beginPath();
      ctx.roundRect(
        drawX - padding,
        y - dims.height + dims.depthBelowBaseline - padding,
        mathWidth + padding * 2,
        dims.height + padding * 2,
        mathStyle.borderRadius,
      );
      ctx.fill();
      ctx.restore();
    }

    // Paint the formula directly. `y` is the text baseline; the engine draws the
    // layout's baseline there. Fonts load asynchronously at startup — until then
    // glyphs simply don't paint (dimensions are already exact), and the host's
    // font-load redraw fills them in. Lay out with the same `literalRange` the
    // caller measured with, so a command being typed (`\in`) is drawn as literal
    // source — at exactly the width reserved for it — instead of flashing ∈.
    const layout = layoutMath(text, {
      fontSize,
      displayMode: false,
      literalRange: literalRangeFor(text, edit),
    });
    // While the caret is inside this chip, keep a half-typed command (`\al`)
    // from flashing red until the caret moves on.
    const pendingRange =
      edit?.caretOffset != null
        ? (mathPendingCommandRange(text, edit.caretOffset) ?? undefined)
        : undefined;
    paintMath(ctx, layout, drawX, y, {
      color: styles.blocks.paragraph.color,
      pendingRange,
    });
  },
};

export class MathMark extends Mark {
  readonly type = "math";
  readonly togglable = false; // needs LaTeX — applied via the math action
  readonly replacement = inlineMathReplacement;
  readonly codec = MATH_CODEC;
  style(): MarkStyle {
    return {};
  }

  // ── Caret / edit seam (inline chip) ─────────────────────────────────────────
  // A chip's visible chars ARE its LaTeX, so a chip-local offset is
  // `blockIndex − span.startIndex`. The shared math model in `nodes/math` finds
  // the chip the index sits in and answers per-chip; a block equation is the
  // MathNode's concern, so these decline it (the seam consults the node first
  // anyway — this is just belt-and-braces).

  caretStep(block: Block, index: number, dir: "left" | "right"): number | null {
    return block.type === "math" ? null : mathCaretStep(block, index, dir);
  }

  caretVerticalStep(
    block: Block,
    index: number,
    dir: "up" | "down",
  ): number | null {
    return block.type === "math"
      ? null
      : mathCaretVerticalStep(block, index, dir);
  }

  caretTokenClamp(
    block: Block,
    target: number,
    dir: "left" | "right",
  ): number | null {
    return block.type === "math"
      ? null
      : mathCaretTokenClamp(block, target, dir);
  }

  deleteUnit(
    block: Block,
    index: number,
    dir: "backward" | "forward",
  ): CaretDeleteUnit | null {
    return block.type === "math" ? null : mathDeleteUnit(block, index, dir);
  }

  transformTypedInput(
    block: Block,
    index: number,
    input: string,
  ): TypedInputTransform | null {
    return block.type === "math"
      ? null
      : mathTransformTypedInput(block, index, input);
  }

  armCaretScratch(block: Block, index: number): CaretScratch | null {
    return block.type === "math" ? null : mathArmScratch(block, index);
  }

  /**
   * Observe `CURSOR_MOVED` (priority 0) — when an arrow key steps the caret
   * across an inline-math chip, open the inline-math editor popover and highlight
   * the crossed chip. The host owns the overlay (this mark owns its key via
   * {@link editOverlayKey}); `ui.inlineMathHover` is engine-owned. Observe-only.
   */
  registerActions(bus: ActionBus): void {
    bus.registerState(
      CURSOR_MOVED,
      (
        state,
        { block, blockIndex, oldIndex, newIndex, viewport, resolveCoords },
      ) => {
        const span = getCrossedInlineMathSpan(block, oldIndex, newIndex);
        if (!span) return { state, ops: [] };

        const coords = resolveCoords({ blockIndex, textIndex: newIndex });
        if (!coords) return { state, ops: [] };

        const key = state.marks.get("math")?.editOverlayKey;
        if (!key) return { state, ops: [] };

        // Open the inline-math editor overlay + highlight the crossed chip
        // (engine-owned hover state). Both are plain `ui` spreads, inlined to
        // keep this mark free of the `state-utils` import chain.
        return {
          state: {
            ...state,
            ui: {
              ...state.ui,
              activeMenu: {
                type: "overlay",
                key,
                blockId: block.id,
                x: coords.x,
                y: coords.y - viewport.scrollY,
                data: {
                  startIndex: span.startIndex,
                  endIndex: span.endIndex,
                  latex: span.latex,
                },
              },
              inlineMathHover: {
                blockIndex,
                startIndex: span.startIndex,
                endIndex: span.endIndex,
              },
            },
          },
          ops: [],
        };
      },
      0,
    );
  }
}
