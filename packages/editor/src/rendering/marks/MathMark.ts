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
  getInlineMathBreakpoints,
  getInlineMathCaretRect,
  getInlineMathDims,
  getInlineMathOffsetAtX,
  getInlineMathSelectionRects,
  getInlineMathWordRange,
  mathCaretMove,
  mathCommandRanges,
  mathDeleteUnit,
  mathSelectionRange,
  mathTransformTypedInput,
  mathUnitAt,
} from "../../nodes/math";
// Host-wired layout so `\text{…}` CJK/unsupported glyphs typeset (see tex-host).
import { layoutMathHost as layoutMath } from "../../nodes/tex-host";
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
  type SelectionWrapTrigger,
} from "./Mark";
import { paintMath } from "@cypherkit/tex";

// Math is a REPLACEMENT mark on HTML output (renders an SVG, falling back to
// `$…$` source when no renderer is supplied) — so it wins the run.
const MATH_CODEC: MarkCodec = {
  type: "math",
  toMarkdown: (t) => `$${t}$`,
  // Plain-text clipboard flavor: keep the `$…$` source so a copied chip pastes
  // as readable LaTeX, not bare delimiterless characters.
  toText: (t) => `$${t}$`,
  tokens: { start: INLINE_MATH_START, end: INLINE_MATH_END },
  html: {
    priority: 0,
    replace: true,
    render: (_inner, _mark, ctx) => {
      const latex = ctx.text;
      // The clipboard prefers source: emit the `$…$` LaTeX so a copied chip
      // pastes as editable inline math, instead of the SVG file export wants.
      if (ctx.preferSource) return `$${ctx.escapeHtml(latex)}$`;
      try {
        if (!ctx.renderMathSVG) throw new Error("no math renderer");
        return ctx.renderMathSVG(latex, false);
      } catch {
        return `<code>$${ctx.escapeHtml(latex)}$</code>`;
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

/**
 * Inline chips render this much larger than the surrounding text so the formula
 * stays legible and editable directly in the line — taking the space it needs
 * despite being inline. This replaces the old magnified mirror popover: rather
 * than a separate, larger copy of the chip, the chip itself is drawn large and
 * the line grows around it.
 *
 * Applied identically across `measure`, `caretRect`, `hitTest`, and `paint`, so
 * the reserved width, expanded line height, painted glyphs, caret geometry, and
 * click hit-testing all agree on one size. It is the single tunable knob.
 */
const INLINE_MATH_SCALE = 1.4;

const inlineMathReplacement: MarkReplacement = {
  measure(text, fontSize, edit) {
    return getInlineMathDims(
      text,
      fontSize * INLINE_MATH_SCALE,
      commandRangesFor(text, edit).literalRange,
    );
  },
  caretRect(text, fontSize, offset, edit) {
    return getInlineMathCaretRect(
      text,
      fontSize * INLINE_MATH_SCALE,
      offset,
      commandRangesFor(text, edit).literalRange,
    );
  },
  hitTest(text, fontSize, localX, localY, drag, prevOffset) {
    return getInlineMathOffsetAtX(
      text,
      fontSize * INLINE_MATH_SCALE,
      localX,
      localY,
      drag,
      prevOffset,
    );
  },
  selectionRects(text, fontSize, start, end, edit) {
    // Lay out with the same `literalRange` `measure`/`paint` use so the selection
    // rects land on the glyphs actually drawn (a command being typed is literal).
    return getInlineMathSelectionRects(
      text,
      fontSize * INLINE_MATH_SCALE,
      start,
      end,
      commandRangesFor(text, edit).literalRange,
    );
  },
  wordRangeAt(text, offset) {
    // Double-tap / double-click inside a chip selects the CONSTRUCT under the
    // caret (the `\sqrt{…}`, the `\frac`, the script `x^{2}`), not the whole chip
    // — the same "take the thing you're pointing at, whole" rule the block
    // equation uses. A chip's visible chars ARE its LaTeX, so `offset` is already a
    // source offset. Returns null for an empty chip → caller keeps the whole run.
    const unit = mathUnitAt(text, offset);
    return unit ? { start: unit.start, end: unit.end } : null;
  },
  wordRangeFromPoint(text, fontSize, localX, localY, edit) {
    // Resolve the double-tap construct from the POINT, so an atomic command chip
    // (`\det`, `\sin`, `\lim`) — whose only caret stops are its two edges — is
    // still selectable: the offset path would land on a chip boundary and miss it,
    // but the point lands on the command's glyphs. Lay out with the same
    // `literalRange` `paint` uses so the box tree matches what is drawn.
    return getInlineMathWordRange(
      text,
      fontSize * INLINE_MATH_SCALE,
      localX,
      localY,
      commandRangesFor(text, edit).literalRange,
    );
  },
  breakpoints(text) {
    // Source offsets into the chip's LaTeX == visible-char offsets within the run
    // (a chip's visible chars ARE its LaTeX), independent of font size.
    return getInlineMathBreakpoints(text);
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
    const { literalRange } = commandRangesFor(text, edit);
    const layout = layoutMath(text, {
      fontSize: fontSize * INLINE_MATH_SCALE,
      displayMode: false,
      literalRange,
    });
    paintMath(ctx, layout, drawX, y, {
      color: styles.blocks.paragraph.color,
    });
  },
};

export class MathMark extends Mark {
  readonly type = "math";
  // Togglable over a selection: a chip's visible chars ARE its LaTeX, so
  // wrapping the selection just marks it as math (no extra input, unlike a
  // link's url). With no selection it arms a pending math format — the next
  // typed text forms the chip — since a zero-width chip can't exist.
  readonly togglable = true;
  readonly replacement = inlineMathReplacement;
  readonly codec = MATH_CODEC;
  // Typing `$` over a selection wraps it as an inline chip (the selected chars
  // become the LaTeX source); `$` again over a full chip selection unwraps it.
  readonly selectionWrap: readonly SelectionWrapTrigger[] = [{ char: "$" }];
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
    selectionRange: (block, anchor, focus, focusEdge) =>
      block.type === "math"
        ? null
        : mathSelectionRange(block, anchor, focus, focusEdge),
  };
}
