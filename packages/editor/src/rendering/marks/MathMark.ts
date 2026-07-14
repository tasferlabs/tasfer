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
import {
  DELETE_BACKWARD,
  DELETE_FORWARD,
  DELETE_WORD_BACKWARD,
  DELETE_WORD_FORWARD,
  SPLIT_BLOCK,
} from "../../actions/edit-actions";
import {
  EXTEND_SELECTION_DOWN,
  EXTEND_SELECTION_LEFT,
  EXTEND_SELECTION_RIGHT,
  EXTEND_SELECTION_UP,
  MOVE_CONTENT_TAB,
  MOVE_CURSOR_DOWN,
  MOVE_CURSOR_LEFT,
  MOVE_CURSOR_RIGHT,
  MOVE_CURSOR_UP,
} from "../../actions/keyboard-actions";
import { TEXT_CLICK } from "../../actions/pointer-actions";
import { INSERT_MATH_COMMAND, RESIZE_MATH_MATRIX } from "../../math/actions";
import {
  getInlineMathStructuredDocument,
  getStructuredMathMarkSource,
  mathMarkCodec,
  mathMarkContentId,
  structuredToMathDocument,
} from "../../math/data";
import {
  deleteActiveInlineMathTree,
  enterAdjacentInlineMathTreeHorizontally,
  enterInlineMathTreeAtPosition,
  exitActiveInlineMathTreeHorizontally,
  exitActiveInlineMathTreeSelectionHorizontally,
  extendActiveInlineMathTreeSelectionHorizontally,
  extendActiveInlineMathTreeSelectionVertically,
  hasActiveInlineMathTreeCaret,
  insertActiveInlineMathTreeCommand,
  moveActiveInlineMathTreeCaret,
  moveActiveInlineMathTreeCaretVertically,
  ownsInlineMathTreeDelete,
  prepareInlineMathTreeForBlockSplit,
  resizeActiveInlineMathTreeMatrix,
} from "../../math/inline-tree-state";
import {
  contentPointToMathDocumentPosition,
  contentPointToMathTreeCaret,
  mathDocumentPositionToContentPoint,
  mathSourceRangeFromContentSelection,
  mathTreeCaretToContentSelection,
} from "../../math/tree-selection";
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
import {
  layoutMathDocumentHost,
  layoutMathHost as layoutMath,
} from "../../nodes/tex-host";
import type { EditorState } from "../../state-types";
import type { CaretModel } from "../nodes/caret-model";
import {
  Mark,
  type MarkReplacement,
  type MarkReplacementEdit,
  type MarkStyle,
  type SelectionWrapTrigger,
} from "./Mark";
import {
  hitTestMathDocument,
  mathDocumentCaretFromSourceOffset,
  mathDocumentCaretStop,
  paintMath,
} from "@cypherkit/tex";

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

/**
 * Reserved geometry for an EMPTY chip — a formula whose last content was
 * deleted but whose chip survives as an editable slot. Mirrors tex's
 * `emptySlot` placeholder for an empty group (~0.4 em wide, x-height tall) so
 * an empty formula reads as the same faint editable box an empty numerator
 * does. Returning real dims here is load-bearing: a `null` measure makes the
 * line renderer fall back to the run's stale compatibility characters, which
 * then paint as ghost prose that no longer matches the canonical (empty)
 * source. `fontSize` is the already-scaled chip font size.
 */
function emptyChipDims(fontSize: number): {
  width: number;
  height: number;
  depthBelowBaseline: number;
} {
  return {
    width: 0.4 * fontSize,
    height: 0.45 * fontSize,
    depthBelowBaseline: 0,
  };
}

function sourceRangeOwnsOffset(
  range: { readonly start: number; readonly end: number },
  offset: number,
  sourceLength: number,
): boolean {
  return (
    offset >= range.start &&
    (offset < range.end ||
      (range.end === sourceLength && offset === sourceLength))
  );
}

function isWholeSourceRange(
  range: { readonly start: number; readonly end: number },
  sourceLength: number,
): boolean {
  return range.start === 0 && range.end === sourceLength;
}

const inlineMathReplacement: MarkReplacement = {
  source: (compatibilityText, { mark, attachments }) =>
    getStructuredMathMarkSource(mark, attachments) ?? compatibilityText,
  contentCaretRect(text, fontSize, point, context) {
    const document = getInlineMathStructuredDocument(
      context.mark,
      context.attachments,
    );
    const position = document
      ? contentPointToMathDocumentPosition(document, point)
      : null;
    if (!document || !position) return null;
    const math = structuredToMathDocument(document);
    if (!math) return null;
    const layout = layoutMathDocumentHost(math, {
      fontSize: fontSize * INLINE_MATH_SCALE,
      displayMode: false,
    });
    const stop = mathDocumentCaretStop(layout, position);
    if (!stop) return null;
    const source =
      getStructuredMathMarkSource(context.mark, context.attachments) ?? text;
    const range = context.sourceRange ?? { start: 0, end: source.length };
    if (!sourceRangeOwnsOffset(range, stop.sourceOffset, source.length)) {
      return null;
    }
    if (isWholeSourceRange(range, source.length)) {
      return { x: stop.x, top: stop.top, bottom: stop.bottom };
    }
    return getInlineMathCaretRect(
      text,
      fontSize * INLINE_MATH_SCALE,
      stop.sourceOffset - range.start,
    );
  },
  contentSelectionRects(text, fontSize, selection, context) {
    const document = getInlineMathStructuredDocument(
      context.mark,
      context.attachments,
    );
    const math = document ? structuredToMathDocument(document) : undefined;
    if (!document || !math) return null;
    const layout = layoutMathDocumentHost(math, {
      fontSize: fontSize * INLINE_MATH_SCALE,
      displayMode: false,
    });
    const range = mathSourceRangeFromContentSelection(
      document,
      selection,
      layout,
    );
    if (!range) return null;
    const source =
      getStructuredMathMarkSource(context.mark, context.attachments) ?? text;
    const fragment = context.sourceRange ?? { start: 0, end: source.length };
    const from = Math.max(range.from, fragment.start);
    const to = Math.min(range.to, fragment.end);
    if (to <= from) return null;
    return getInlineMathSelectionRects(
      text,
      fontSize * INLINE_MATH_SCALE,
      from - fragment.start,
      to - fragment.start,
    );
  },
  contentSelectionFromPoint(text, fontSize, localX, localY, context) {
    const contentId = mathMarkContentId(context.mark);
    const document = getInlineMathStructuredDocument(
      context.mark,
      context.attachments,
    );
    const math = document ? structuredToMathDocument(document) : undefined;
    if (!contentId || !document || !math) return null;
    const layout = layoutMathDocumentHost(math, {
      fontSize: fontSize * INLINE_MATH_SCALE,
      displayMode: false,
    });
    const source =
      getStructuredMathMarkSource(context.mark, context.attachments) ?? text;
    const range = context.sourceRange ?? { start: 0, end: source.length };
    const previousPosition = context.previousPoint
      ? contentPointToMathDocumentPosition(document, context.previousPoint)
      : null;
    const previousStop = previousPosition
      ? mathDocumentCaretStop(layout, previousPosition)
      : null;
    const previousFragmentOffset =
      previousStop &&
      sourceRangeOwnsOffset(range, previousStop.sourceOffset, source.length)
        ? previousStop.sourceOffset - range.start
        : null;
    const stop = isWholeSourceRange(range, source.length)
      ? hitTestMathDocument(layout, localX, localY, {
          placeholderTargetSize: context.pointerType === "touch" ? 44 : 24,
          ...(context.drag ? { drag: true } : {}),
          ...(context.drag && previousPosition
            ? { dragPrevPosition: previousPosition }
            : {}),
        })
      : mathDocumentCaretFromSourceOffset(
          layout,
          Math.min(
            range.end,
            range.start +
              getInlineMathOffsetAtX(
                text,
                fontSize * INLINE_MATH_SCALE,
                localX,
                localY,
                context.drag,
                previousFragmentOffset,
              ),
          ),
        );
    if (!stop) return null;
    const positions = [...stop.positions].sort((left, right) =>
      left.kind === right.kind ? 0 : left.kind === "field" ? -1 : 1,
    );
    for (const position of positions) {
      const point = mathDocumentPositionToContentPoint(
        context.blockId,
        contentId,
        document,
        position,
      );
      if (!point) continue;
      const caret = contentPointToMathTreeCaret(document, point);
      if (!caret) continue;
      const selection = mathTreeCaretToContentSelection(
        context.blockId,
        contentId,
        document,
        caret,
      );
      if (selection) return selection;
    }
    return null;
  },
  measure(text, fontSize, edit) {
    if (text.length === 0) return emptyChipDims(fontSize * INLINE_MATH_SCALE);
    return getInlineMathDims(
      text,
      fontSize * INLINE_MATH_SCALE,
      commandRangesFor(text, edit).literalRange,
    );
  },
  caretRect(text, fontSize, offset, edit) {
    if (text.length === 0) {
      const dims = emptyChipDims(fontSize * INLINE_MATH_SCALE);
      return { x: 0, top: -dims.height, bottom: 0 };
    }
    return getInlineMathCaretRect(
      text,
      fontSize * INLINE_MATH_SCALE,
      offset,
      commandRangesFor(text, edit).literalRange,
    );
  },
  hitTest(text, fontSize, localX, localY, drag, prevOffset) {
    if (text.length === 0) return 0;
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

    if (text.length === 0) {
      // The faint translucent slot tex paints for an empty group — the empty
      // chip is exactly that: an editable slot awaiting content.
      ctx.save();
      ctx.globalAlpha *= 0.12;
      ctx.fillStyle = styles.blocks.paragraph.color;
      ctx.fillRect(drawX, y - dims.height, dims.width, dims.height);
      ctx.restore();
      return;
    }

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
  constructor() {
    super();
  }

  readonly type = "math";
  // Togglable over a selection: a chip's visible chars ARE its LaTeX, so
  // wrapping the selection just marks it as math (no extra input, unlike a
  // link's url). With no selection it arms a pending math format — the next
  // typed text forms the chip — since a zero-width chip can't exist.
  readonly togglable = true;
  readonly replacement = inlineMathReplacement;
  readonly codec = mathMarkCodec;
  // Typing `$` over a selection wraps it as an inline chip (the selected chars
  // become the LaTeX source); `$` again over a full chip selection unwraps it.
  readonly selectionWrap: readonly SelectionWrapTrigger[] = [{ char: "$" }];
  style(): MarkStyle {
    return {};
  }

  registerActions(bus: ActionBus): void {
    bus.registerState(
      TEXT_CLICK,
      (state, { position, modifiers }) =>
        // A Shift+click with an active selection/caret is an EXTENSION gesture:
        // leave it unclaimed so the generic caret placement extends the flat
        // range across the chip (snapping covers it whole) instead of dropping
        // the caret into the chip's tree.
        modifiers.shift &&
        (state.document.selection ||
          state.document.cursor ||
          state.document.contentSelection)
          ? undefined
          : enterInlineMathTreeAtPosition(
              state,
              position.blockIndex,
              position.textIndex,
            ),
      90,
    );
    const remove =
      (direction: "backward" | "forward") => (state: EditorState) => {
        const edited = deleteActiveInlineMathTree(state, direction);
        if (edited) return edited;
        return ownsInlineMathTreeDelete(state, direction)
          ? { state, ops: [], handled: true as const }
          : undefined;
      };
    bus.registerState(DELETE_BACKWARD, remove("backward"), 110);
    bus.registerState(DELETE_WORD_BACKWARD, remove("backward"), 110);
    bus.registerState(DELETE_FORWARD, remove("forward"), 110);
    bus.registerState(DELETE_WORD_FORWARD, remove("forward"), 110);
    // Enter cannot reach the generic block split while a structured mark owns
    // the caret (nested selection deliberately clears the flat cursor).
    // Mid-formula the chip is first divided into two attached chips with the
    // flat caret on their seam; at an edge the caret just exits. Either way
    // the normal SPLIT_BLOCK handlers/default continue with the threaded
    // state and split the block at that caret.
    bus.registerState(
      SPLIT_BLOCK,
      (state) => prepareInlineMathTreeForBlockSplit(state),
      110,
    );

    const move =
      (motion: "arrow-left" | "arrow-right") => (state: EditorState) => {
        const direction = motion === "arrow-left" ? "left" : "right";
        const moved = moveActiveInlineMathTreeCaret(state, motion);
        if (moved) return moved;
        return hasActiveInlineMathTreeCaret(state)
          ? exitActiveInlineMathTreeHorizontally(state, direction)
          : enterAdjacentInlineMathTreeHorizontally(state, direction);
      };
    bus.registerState(MOVE_CURSOR_LEFT, move("arrow-left"), 110);
    bus.registerState(MOVE_CURSOR_RIGHT, move("arrow-right"), 110);
    bus.registerState(
      MOVE_CONTENT_TAB,
      (state, { backward }) => {
        const moved = moveActiveInlineMathTreeCaret(
          state,
          backward ? "shift-tab" : "tab",
        );
        if (moved) return moved;
        return hasActiveInlineMathTreeCaret(state)
          ? { state, ops: [], handled: true as const }
          : undefined;
      },
      110,
    );
    const moveVertical = (direction: "up" | "down") => (state: EditorState) => {
      const moved = moveActiveInlineMathTreeCaretVertically(state, direction);
      if (moved) return moved;
      return hasActiveInlineMathTreeCaret(state)
        ? { state, ops: [], handled: true as const }
        : undefined;
    };
    bus.registerState(MOVE_CURSOR_UP, moveVertical("up"), 110);
    bus.registerState(MOVE_CURSOR_DOWN, moveVertical("down"), 110);
    const extendVertical =
      (direction: "up" | "down") => (state: EditorState) => {
        const moved = extendActiveInlineMathTreeSelectionVertically(
          state,
          direction,
        );
        if (moved) return moved;
        return hasActiveInlineMathTreeCaret(state)
          ? { state, ops: [], handled: true as const }
          : undefined;
      };
    bus.registerState(EXTEND_SELECTION_UP, extendVertical("up"), 110);
    bus.registerState(EXTEND_SELECTION_DOWN, extendVertical("down"), 110);
    const extendHorizontal =
      (direction: "left" | "right") => (state: EditorState) => {
        const moved = extendActiveInlineMathTreeSelectionHorizontally(
          state,
          direction,
        );
        if (moved) return moved;
        // At the formula edge the nested selection can't grow further: hand
        // the gesture to the flat model (chip covered whole) so Shift+Arrow
        // keeps selecting into the host text.
        const exited = exitActiveInlineMathTreeSelectionHorizontally(
          state,
          direction,
        );
        if (exited) return exited;
        return hasActiveInlineMathTreeCaret(state)
          ? { state, ops: [], handled: true as const }
          : undefined;
      };
    bus.registerState(EXTEND_SELECTION_LEFT, extendHorizontal("left"), 110);
    bus.registerState(EXTEND_SELECTION_RIGHT, extendHorizontal("right"), 110);
    bus.registerState(
      INSERT_MATH_COMMAND,
      (state, { text, caretOffset }) =>
        insertActiveInlineMathTreeCommand(state, text, caretOffset) ??
        (hasActiveInlineMathTreeCaret(state)
          ? { state, ops: [], handled: true as const }
          : undefined),
      110,
    );
    bus.registerState(
      RESIZE_MATH_MATRIX,
      (state, { rows, cols }) =>
        resizeActiveInlineMathTreeMatrix(state, rows, cols) ??
        (hasActiveInlineMathTreeCaret(state)
          ? { state, ops: [], handled: true as const }
          : undefined),
      110,
    );
  }

  // ── Caret model (inline chip) ───────────────────────────────────────────────
  // A chip's visible chars ARE its LaTeX, so a chip-local offset is
  // `blockIndex − span.startIndex`. The chip isn't an opaque atom — the caret
  // descends into it — so it overrides `move`/`deleteUnit` (the shared math model
  // in `nodes/math` finds the chip the index sits in and answers per-chip) rather
  // than declaring `atomicSpans`. A block equation is the MathNode's concern;
  // this mark model is invoked only for a resolved inline run. The post-edit
  // *effect* (materialize a construct / arm scratch) is owned by MathNode's
  // TEXT_INPUTTED observer, which covers inline chips too — so there is none here.
  readonly caret: CaretModel = {
    move: (block, index, motion) => mathCaretMove(block, index, motion),
    deleteUnit: (block, index, dir) => mathDeleteUnit(block, index, dir),
    transformInput: (block, index, input) =>
      mathTransformTypedInput(block, index, input),
    selectionRange: (block, anchor, focus, focusEdge) =>
      mathSelectionRange(block, anchor, focus, focusEdge),
  };
}
