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
  mathDeleteUnit,
  mathPendingCommandRange,
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
