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

import {
  getInlineMathCaretRect,
  getInlineMathDims,
  getInlineMathOffsetAtX,
  mathCaretMove,
  mathCommandRanges,
  mathDeleteUnit,
  mathTransformTypedInput,
} from "../../nodes/math";
import type { MarkCodec } from "../../serlization/codecs/mark-codec";
import {
  INLINE_MATH_END,
  INLINE_MATH_START,
} from "../../serlization/tokenizer";
import type { CaretModel } from "../nodes/caret-model";
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
      // The clipboard prefers source: emit the `$…$` LaTeX so a copied chip
      // pastes as editable inline math, instead of the SVG file export wants.
      if (ctx.preferSource) return `$${ctx.escapeHtml(ctx.text)}$`;
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
 * The `\command`-run ranges (literal + pending) for this chip, derived from the
 * caret in `edit`. The chip is "command-entry active" exactly while `edit.editing`
 * is set; `edit.caretOffset` is the chip-local caret. `measure`/`paint`/`caretRect`
 * all derive from the same `edit`, so their geometry agrees. Shared with the block
 * equation and the host overlay via {@link mathCommandRanges}.
 */
function commandRangesFor(text: string, edit: MarkReplacementEdit | undefined) {
  return mathCommandRanges(text, edit?.caretOffset ?? null, !!edit?.editing);
}

const inlineMathReplacement: MarkReplacement = {
  measure(text, fontSize, edit) {
    return getInlineMathDims(
      text,
      fontSize,
      commandRangesFor(text, edit).literalRange,
    );
  },
  caretRect(text, fontSize, offset, edit) {
    return getInlineMathCaretRect(
      text,
      fontSize,
      offset,
      commandRangesFor(text, edit).literalRange,
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
    // source — at exactly the width reserved for it — instead of flashing ∈. The
    // `pendingRange` keeps a half-typed command (`\al`) from flashing red until
    // the caret moves on.
    const { literalRange, pendingRange } = commandRangesFor(text, edit);
    const layout = layoutMath(text, {
      fontSize,
      displayMode: false,
      literalRange,
    });
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

  // ── Caret model (inline chip) ───────────────────────────────────────────────
  // A chip's visible chars ARE its LaTeX, so a chip-local offset is
  // `blockIndex − span.startIndex`. The chip isn't an opaque atom — the caret
  // descends into it — so it overrides `move`/`deleteUnit` (the shared math model
  // in `nodes/math` finds the chip the index sits in and answers per-chip) rather
  // than declaring `atomicSpans`. A block equation is the MathNode's concern, so
  // these decline it (`block.type === "math"` → null; the seam consults the node
  // first anyway — belt-and-braces). The post-edit *effect* (materialize a
  // construct / arm scratch) is owned by MathNode's TEXT_INPUTTED observer, which
  // covers inline chips too — so there is none here.
  readonly caret: CaretModel = {
    move: (block, index, motion) =>
      block.type === "math" ? null : mathCaretMove(block, index, motion),
    deleteUnit: (block, index, dir) =>
      block.type === "math" ? null : mathDeleteUnit(block, index, dir),
    transformInput: (block, index, input) =>
      block.type === "math"
        ? null
        : mathTransformTypedInput(block, index, input),
  };
}
