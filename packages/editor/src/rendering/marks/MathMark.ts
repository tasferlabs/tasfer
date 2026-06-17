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

import { layoutMath, paintMath } from "@cypherkit/tex";

import type { ActionBus } from "../../action-bus";
import { CURSOR_MOVED } from "../../actions/pointer-actions";
import { getCrossedInlineMathSpan } from "../../inline-math-spans";
import { getInlineMathDims } from "../../nodes/math";
import type { MarkCodec } from "../../serlization/codecs/mark-codec";
import {
  INLINE_MATH_END,
  INLINE_MATH_START,
} from "../../serlization/tokenizer";
import { Mark, type MarkReplacement, type MarkStyle } from "./Mark";

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

const inlineMathReplacement: MarkReplacement = {
  measure(text, fontSize) {
    return getInlineMathDims(text, fontSize);
  },
  paint({ ctx, text, x, y, fontSize, isRTL, hovered, dims, styles }) {
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
    // font-load redraw fills them in.
    const layout = layoutMath(text, { fontSize, displayMode: false });
    paintMath(ctx, layout, drawX, y, { color: styles.blocks.paragraph.color });
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
