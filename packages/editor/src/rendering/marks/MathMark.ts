/**
 * math → a replacement renderer (draws a MathJax SVG instead of glyphs).
 *
 * Inline math is a replacement mark: it measures as an atomic unit (the full
 * SVG width) and paints the rendered formula — a behavior-preserving move of
 * the former `batch.isMath` branch out of `renderLine`.
 */

import type { ActionBus } from "../../action-bus";
import { CURSOR_MOVED } from "../../actions/pointer-actions";
import { getCrossedInlineMathSpan } from "../../inline-math-spans";
import { getInlineMathDims, getInlineMathImage } from "../../nodes/math";
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
  paint({
    ctx,
    text,
    x,
    y,
    fontSize,
    isRTL,
    hovered,
    dims,
    styles,
    requestRedraw,
  }) {
    const dpr = window.devicePixelRatio || 1;
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

    const image = getInlineMathImage(
      text,
      fontSize,
      dpr,
      styles.blocks.paragraph.color,
      styles.blocks.math.errorBackgroundColor,
      requestRedraw,
    );
    if (image) {
      const imgY = y - dims.height + dims.depthBelowBaseline;
      ctx.drawImage(image.bitmap, drawX, imgY, mathWidth, dims.height);
    }
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
