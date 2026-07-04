/**
 * MathNode — the `math` (display LaTeX equation) block.
 *
 * Unlike its former atomic self (a void block whose `latex` was an attribute,
 * edited through a DOM overlay), the math block is now **textual**: its char-run
 * text IS the LaTeX, so the caret lives *inside* the equation and editing is
 * canvas-native — identical to typing in any text block, plus everything the
 * inline-math chips gained (caret descent, empty-slot boxes, token-aware delete,
 * the `\` command menu). It extends {@link TextNode} for that whole editing /
 * cursor / hit-test stack and overrides only what differs: it renders the text
 * as a centered, display-sized equation via `@cypherkit/tex` (not wrapped text),
 * and maps the caret to LaTeX offsets through the same tex bridge.
 *
 * Rendering is synchronous and exact (metrics are a data table), so the height
 * pass and paint always agree with no async round-trip and no font-load reflow.
 *
 * The serialization methods are this node's markdown/HTML/text round-trip,
 * adapted into a BlockCodec by the schema.
 */

import {
  type ActionBus,
  type ActionHandler,
  CONTENT_DELETED,
  stateAction,
  type StateHandler,
  type StateResult,
  TEXT_INPUTTED,
} from "../action-bus";
import {
  DELETE_BACKWARD,
  SELECT_ALL,
  SPLIT_BLOCK,
} from "../actions/edit-actions";
import { SELECT_WORD_AT_POINT } from "../actions/mouse-actions";
import { POINTER_MOVE } from "../actions/pointer-actions";
import { TAP_SELECT_WORD } from "../actions/touch-actions";
import { measureCtxText } from "../fonts";
import { getInlineMathAtPosition } from "../inline-math";
import type { MarkRegistry } from "../rendering/marks";
import type { CaretModel } from "../rendering/nodes/caret-model";
import type {
  BlockRuntimeState,
  NodeLayout,
  NodeLayoutCtx,
  NodePaintCtx,
} from "../rendering/nodes/Node";
import { invalidateBlockCache } from "../rendering/renderer";
import {
  clearSelection,
  isNodeSelection,
  moveCursorLeft,
  moveCursorRight,
  moveCursorToPosition,
} from "../selection";
import { escapeHtml } from "../serlization/codecs/inline";
import type { NodeCodec } from "../serlization/codecs/types";
import type {
  Block,
  Char,
  CharRun,
  Mark,
  MarkSpan,
} from "../serlization/loadPage";
import {
  MATH_BLOCK,
  NEWLINE,
  type VisibleToken,
} from "../serlization/tokenizer";
import type {
  EditorState,
  EditorStyles,
  Operation,
  Position,
  RenderedBlock,
  RenderedLine,
  TextStyle,
} from "../state-types";
import {
  closeActiveMenu,
  isCaretScratchActive,
  isTouchDevice,
  updateMode,
} from "../state-utils";
import { findBlockIndex } from "../sync/block-lookup";
import {
  getVisibleTextFromChars,
  getVisibleTextFromRuns,
} from "../sync/char-runs";
import {
  deleteCharsInRange,
  insertCharsAtPosition,
  markCharsInRange,
  orderKeyAfter,
} from "../sync/crdt-utils";
import { applyOps, cardJoinFlags } from "../sync/reducer";
import {
  mathAbsorbNumericPunctuationAfterInput,
  mathArmScratch,
  mathCaretMove,
  mathCommandRanges,
  mathDeleteUnit,
  mathJoinAtEdgeAfterInput,
  mathMaterializeAfterInput,
  mathMergeAfterDelete,
  mathRedundantSpaceAfterInput,
  mathSeparatorAfterDelete,
  mathSplitAfterInput,
  mathTransformTypedInput,
  mathUnitAt,
} from "./math";
import { TextNode, type TextNodeLayout, type TextualBlock } from "./TextNode";
import {
  caretRect as texCaretRect,
  hitTest as texHitTest,
  layoutMath,
  type MathLayout,
  paintMath,
  selectionRects as texSelectionRects,
} from "@cypherkit/tex";

// Math block — a display LaTeX equation. Textual (its char-run text is the
// LaTeX); named `MathBlock` (not `Math`) to avoid shadowing the global `Math`.
export interface MathBlock extends BlockRuntimeState {
  type: "math";
  charRuns: CharRun[];
  /** Always empty — math carries no inline marks — but kept for the textual shape. */
  formats: MarkSpan[];
  displayMode: boolean; // always true for a block equation; kept for the codec
}

// Display-math base font size, in CSS pixels (block equations render a touch
// larger than body text).
const BLOCK_MATH_FONT_SIZE = 22;

// Wrapping geometry for a too-wide equation (see `layoutEquation`). The width
// budget is inset from the block edges so wrapped rows don't touch the rounded
// surface; continuation rows are indented and the stacked rows get a little
// extra leading so a broken equation reads as a connected, multi-line whole.
const BLOCK_MATH_PADDING_X = 16;
const BLOCK_MATH_WRAP_INDENT = 24;
const BLOCK_MATH_LINE_GAP = 8;

/** TextNodeLayout augmented with the rendered equation + its placement. */
interface MathNodeLayout extends TextNodeLayout {
  /** The laid-out equation, or null when the block is empty. */
  readonly mathLayout: MathLayout | null;
  /** Horizontal inset (px from the block's content-left) that centers the math. */
  readonly mathOffsetX: number;
  /** Vertical inset (px from the block top) to the math's top edge. */
  readonly mathTop: number;
  /** Width of the centered empty-block placeholder, used to align the caret. */
  readonly placeholderWidth: number;
}

export class MathNode extends TextNode {
  readonly type = "math" as const;
  readonly types: readonly string[] = ["math"];
  // All card blocks (code, math, quote) tile together when stacked.
  readonly joinGroup = "card";

  /**
   * A math block is textual (its char-run text is the LaTeX), but the visible
   * equation renders through the tex bridge, not as wrapped text. The throwaway
   * text-layout/caret fallback just needs a valid TextStyle, so borrow the
   * paragraph's (there is no dedicated text style for `math`).
   */
  override textStyle(styles: EditorStyles): TextStyle {
    return styles.blocks.paragraph;
  }

  estimateHeight(c: NodeLayoutCtx): number {
    const m = c.styles.blocks.math;
    return m.minHeight + m.paddingTop + m.paddingBottom;
  }

  /**
   * Lay out the equation as display math constrained to the block's content
   * width: it line-breaks at binary operators / relations to fit, stacking onto
   * extra rows rather than overflowing the block (a single unbreakable construct
   * still overflows — there is nothing to break). One helper so `computeLayout`,
   * `paint`, and `caretRect` all lay out with identical geometry; `literalRange`
   * keeps a command still being typed (`\in`) literal, matching what paint draws.
   */
  private layoutEquation(
    latex: string,
    contentWidth: number,
    literalRange?: { start: number; end: number },
  ): MathLayout {
    return layoutMath(latex, {
      fontSize: BLOCK_MATH_FONT_SIZE,
      displayMode: true,
      maxWidth: Math.max(0, contentWidth - 2 * BLOCK_MATH_PADDING_X),
      wrapIndent: BLOCK_MATH_WRAP_INDENT,
      wrapLineGap: BLOCK_MATH_LINE_GAP,
      literalRange,
    });
  }

  // ── Layout ───────────────────────────────────────────────────────────────

  /**
   * Reuse TextNode's layout to get a valid `TextNodeLayout` (chars, textStyle,
   * fonts — everything the editing/caret stack reads), then lay the text out as
   * an equation and override the block height + record where to center it.
   */
  computeLayout(
    block: TextualBlock,
    maxWidth: number,
    styles: EditorStyles,
    content?: {
      chars: Char[];
      formats: MarkSpan[];
      compositionRange: { start: number; end: number } | null;
    },
    marks?: MarkRegistry,
  ): MathNodeLayout {
    const base = super.computeLayout(block, maxWidth, styles, content, marks);
    const latex = getVisibleTextFromChars(base.chars);
    const m = styles.blocks.math;
    const mathLayout = latex ? this.layoutEquation(latex, maxWidth) : null;
    const mh = mathLayout ? mathLayout.height + mathLayout.depth : 0;
    const contentH = Math.max(m.minHeight, mh);
    const height = contentH + m.paddingTop + m.paddingBottom;
    const mathOffsetX = mathLayout
      ? Math.max(0, (maxWidth - mathLayout.width) / 2)
      : 0;
    const mathTop = m.paddingTop + Math.max(0, (contentH - mh) / 2);
    const placeholderWidth = measureCtxText(
      styles.placeholder.math.text,
      m.placeholder.fontSize,
      m.placeholder.fontWeight,
      base.fontFamily,
      base.fonts,
    );
    // An equation is a single logical line for the caret/selection stack: its
    // internal rows (a fraction's halves, a wrapped display line) are stacked
    // math geometry navigated by the tex caret model (see `caret` / `caretRect`),
    // NOT the text-wrapped lines TextNode measures from the raw LaTeX string.
    // Those base lines are meaningless here — worse, when the LaTeX is long enough
    // to text-wrap, the generic vertical-nav fall-through (`moveCursorDown`, once
    // `caretVerticalStep` reports no math row beyond the edge) would step between
    // them and trap the caret inside the block. Collapse to one line spanning the
    // whole equation, mirroring what `paint` emits, so exhausting the math rows
    // exits the block. Empty (no `mathLayout`) still yields one line so the block
    // reports a bottom/top edge to the escape logic.
    const line: RenderedLine = {
      text: latex,
      x: mathOffsetX,
      y: mathTop,
      width: mathLayout ? mathLayout.width : 0,
      height: mh,
      startIndex: 0,
      endIndex: latex.length,
    };
    // LaTeX is always laid out left-to-right. The base layout derives direction
    // from the content (TextNode → getTextDirection), which falls back to the UI
    // default — so in an RTL locale an empty or symbol-only equation would come
    // back RTL and mirror the caret/geometry. Pin it LTR.
    return {
      ...base,
      isRTL: false,
      lines: [line],
      height,
      mathLayout,
      mathOffsetX,
      mathTop,
      placeholderWidth,
    };
  }

  // ── Paint ────────────────────────────────────────────────────────────────

  paint(passedLayout: NodeLayout, c: NodePaintCtx): RenderedBlock {
    const layout = passedLayout as MathNodeLayout;
    const { ctx, origin, styles, state, blockIndex } = c;
    const m = styles.blocks.math;
    const x = origin.x;
    const y = origin.y;
    const width = c.maxWidth;

    const lines: RenderedLine[] = [];

    // `paintMath` is isolated in save/restore so none of its canvas-state
    // mutations leak to the next block (the shared render context is not saved
    // per block).
    ctx.save();

    // Keep the same full-block surface as a code block at rest so an equation
    // reads as a distinct editable block. Hover and active states use the
    // stronger math interaction color.
    // A readonly document shows no hover/active emphasis — the equation reads as
    // static, keeping its resting code-block surface. Gate on `isReadonlyBase`
    // (not `mode === "readonly"`) so a readonly editor in `select` mode, used for
    // copy, stays un-emphasized when a selection overlaps the block too.
    const emphasized =
      !state.ui.isReadonlyBase &&
      (state.ui.hoveredMathBlockIndex === blockIndex ||
        this.isBlockActive(state, blockIndex));
    ctx.fillStyle = emphasized
      ? m.hoverBackgroundColor
      : styles.blocks.code.backgroundColor;
    ctx.beginPath();
    // Adjacent math/code blocks (one shared card surface) square off the shared
    // edge so their backgrounds tile into one continuous card, not a rounded seam.
    const { joinTop, joinBottom } = cardJoinFlags(
      state.nodes,
      state.document.page.blocks,
      blockIndex,
    );
    const topRadius = joinTop ? 0 : m.hoverBorderRadius;
    const bottomRadius = joinBottom ? 0 : m.hoverBorderRadius;
    // roundRect radii order: [topLeft, topRight, bottomRight, bottomLeft].
    ctx.roundRect(x, y, width, layout.height, [
      topRadius,
      topRadius,
      bottomRadius,
      bottomRadius,
    ]);
    ctx.fill();

    if (!layout.mathLayout) {
      const selection = state.document.selection;
      const cursorInThisBlock =
        state.document.cursor?.position.blockIndex === blockIndex;
      const showPlaceholder =
        (styles.placeholder.showUnfocused || cursorInThisBlock) &&
        (!selection || selection.isCollapsed) &&
        !state.ui.composition &&
        state.ui.mode === "edit";
      if (showPlaceholder) {
        const mathPlaceholder = styles.blocks.math.placeholder;
        const textStyle: TextStyle = {
          ...this.textStyle(styles),
          fontSize: mathPlaceholder.fontSize,
          fontWeight: mathPlaceholder.fontWeight,
          // Absolute size — clear any inherited scale so a host-set block
          // placeholder fontScale can't re-scale the math ghost text.
          placeholder: undefined,
        };
        ctx.save();
        ctx.textAlign = "center";
        this.paintPlaceholder(
          ctx,
          x + width / 2,
          y + layout.height / 2 + textStyle.fontSize * 0.35,
          styles,
          textStyle,
          styles.placeholder.math.text,
          false,
          width,
        );
        ctx.restore();
      }
    } else {
      const latex = getVisibleTextFromChars(layout.chars);

      // Keep a half-typed command (`\al`) in normal color until the caret moves
      // on (the source index IS the LaTeX offset for a math block). Only while
      // the collapsed caret is in this block. While that command is actively
      // being typed (command-entry scratch armed at this exact caret), the layout
      // is re-laid out below with the in-progress command kept literal — so the
      // geometry the caret reads matches what's painted (`\in`, not ∈).
      const sel = state.document.selection;
      const cursor = state.document.cursor;
      const caretIndex =
        cursor &&
        cursor.position.blockIndex === blockIndex &&
        (!sel || sel.isCollapsed)
          ? cursor.position.textIndex
          : null;
      const commandEntryActive =
        caretIndex !== null &&
        isCaretScratchActive(state, c.block.id, caretIndex);
      const { literalRange, pendingRange } = mathCommandRanges(
        latex,
        caretIndex,
        commandEntryActive,
      );
      const mathLayout = literalRange
        ? this.layoutEquation(latex, width, literalRange)
        : layout.mathLayout;
      const mathOffsetX = literalRange
        ? Math.max(0, (width - mathLayout.width) / 2)
        : layout.mathOffsetX;

      const drawX = x + mathOffsetX;
      const drawTop = y + layout.mathTop;
      const baselineY = drawTop + mathLayout.height;

      // Selection highlight UNDER the glyphs — the "select-first" construct
      // deletion (and any range selection) draws over the rendered formula via
      // the tex selection rects (x from the math's left edge, y from baseline).
      const range = this.localSelectionRange(
        state,
        blockIndex,
        layout.chars.length,
      );
      if (range) {
        // Reuse the base selection fill so math honors the themed
        // `selection.cornerRadius` (and opacity) like text/atomic blocks.
        const rects = texSelectionRects(mathLayout, range.from, range.to).map(
          (r) => ({
            x: drawX + r.x,
            y: baselineY + r.y,
            width: r.width,
            height: r.height,
          }),
        );
        this.fillRects(
          ctx,
          rects,
          styles.selection.backgroundColor,
          styles.selection.opacity,
          styles.selection.cornerRadius,
        );
      }

      paintMath(ctx, mathLayout, drawX, baselineY, {
        color: styles.blocks.paragraph.color,
        pendingRange,
      });
      lines.push({
        text: latex,
        x: drawX,
        y: drawTop,
        width: mathLayout.width,
        height: mathLayout.height + mathLayout.depth,
        startIndex: 0,
        endIndex: latex.length,
      });
    }

    ctx.restore();

    return {
      block: c.block,
      bounds: { x, y, width, height: layout.height },
      lines,
    };
  }

  /**
   * Whether this block is "active" — it holds the caret, or a (possibly
   * multi-block) selection overlaps it. Keeps the full-block backdrop lit while
   * the equation is being edited, mirroring the hover highlight.
   */
  private isBlockActive(state: EditorState, blockIndex: number): boolean {
    const sel = state.document.selection;
    if (sel) {
      const lo = Math.min(sel.anchor.blockIndex, sel.focus.blockIndex);
      const hi = Math.max(sel.anchor.blockIndex, sel.focus.blockIndex);
      if (blockIndex >= lo && blockIndex <= hi) return true;
    }
    return state.document.cursor?.position.blockIndex === blockIndex;
  }

  /**
   * The portion of the document selection that falls within THIS block, as a
   * source range `[from, to)` into the equation's LaTeX (or null when the block
   * isn't selected). Handles cross-block selections: a block fully spanned maps
   * to `[0, len]`; an endpoint in another block clamps to this block's edge.
   */
  private localSelectionRange(
    state: EditorState,
    blockIndex: number,
    len: number,
  ): { from: number; to: number } | null {
    const sel = state.document.selection;
    if (!sel || sel.isCollapsed) return null;
    const lo = Math.min(sel.anchor.blockIndex, sel.focus.blockIndex);
    const hi = Math.max(sel.anchor.blockIndex, sel.focus.blockIndex);
    if (blockIndex < lo || blockIndex > hi) return null;
    // A node selection of this whole equation (the math/code sentinel: a
    // non-collapsed selection whose endpoints share one position — what
    // Backspace from the following block produces) highlights the entire LaTeX,
    // not a zero-width slice. Without this the block would read as a stray caret.
    if (isNodeSelection(sel) && sel.anchor.blockIndex === blockIndex) {
      return len > 0 ? { from: 0, to: len } : null;
    }
    const at = (p: Position) =>
      p.blockIndex < blockIndex
        ? 0
        : p.blockIndex > blockIndex
          ? len
          : p.textIndex;
    const a = at(sel.anchor);
    const b = at(sel.focus);
    const from = Math.max(0, Math.min(a, b));
    const to = Math.min(len, Math.max(a, b));
    return from < to ? { from, to } : null;
  }

  // ── Caret geometry (via the tex bridge, not text lines) ────────────────────

  /** Caret rectangle for a LaTeX offset (the block text index IS the offset). */
  caretRect(
    layout: TextNodeLayout,
    textIndex: number,
    originX: number,
    blockTopY: number,
    state?: EditorState,
    blockId?: string,
  ): { x: number; y: number; height: number; exact?: boolean } {
    const commandEntryActive =
      state != null && blockId != null
        ? isCaretScratchActive(state, blockId, textIndex)
        : false;
    const l = layout as MathNodeLayout;
    if (!l.mathLayout) {
      // The placeholder remains centered, while the caret sits at its leading
      // edge like a normal empty input.
      return {
        x: originX + Math.max(0, (l.adjustedMaxWidth - l.placeholderWidth) / 2),
        y: blockTopY + l.mathTop - BLOCK_MATH_FONT_SIZE / 2,
        height: BLOCK_MATH_FONT_SIZE,
        exact: true,
      };
    }

    // While a command is actively being typed here, read the caret off a layout
    // with that command kept literal (`\in`, not ∈) — matching what paint draws
    // — so the caret tracks the source text the user is entering. Otherwise the
    // cached (resolved) layout is exact.
    const latex = getVisibleTextFromChars(l.chars);
    const { literalRange } = mathCommandRanges(
      latex,
      textIndex,
      commandEntryActive,
    );
    const mathLayout = literalRange
      ? this.layoutEquation(latex, l.adjustedMaxWidth, literalRange)
      : l.mathLayout;
    const mathOffsetX = literalRange
      ? Math.max(0, (l.adjustedMaxWidth - mathLayout.width) / 2)
      : l.mathOffsetX;

    const baseX = originX + mathOffsetX;
    const baselineY = blockTopY + l.mathTop + mathLayout.height;
    const r = texCaretRect(mathLayout, textIndex);
    if (!r) {
      return {
        x: baseX,
        y: blockTopY + l.mathTop,
        height: mathLayout.height + mathLayout.depth,
        exact: true,
      };
    }
    return {
      x: baseX + r.x,
      y: baselineY + r.top,
      height: r.bottom - r.top,
      exact: true,
    };
  }

  /** Click → LaTeX offset via the tex hit-test. */
  positionFromPoint(
    _block: TextualBlock,
    layout: TextNodeLayout,
    x: number,
    y: number,
    originX: number,
    blockTopY: number,
  ): number {
    const l = layout as MathNodeLayout;
    if (!l.mathLayout) return 0;
    const baseX = originX + l.mathOffsetX;
    const baselineY = blockTopY + l.mathTop + l.mathLayout.height;
    return texHitTest(l.mathLayout, x - baseX, y - baselineY, {
      placeholderTargetSize: isTouchDevice() ? 44 : 24,
    });
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  readonly codec: NodeCodec = {
    markdown: {
      tokens: [MATH_BLOCK],
      output: (block) => {
        const b = block as MathBlock;
        const latex = getVisibleTextFromRuns(b.charRuns);
        if (!latex) return "";
        return `$$\n${latex}\n$$`;
      },
      input: (ctx) => {
        ctx.match(MATH_BLOCK);
        const latex = (ctx.previous() as VisibleToken).content;
        ctx.match(NEWLINE);

        const math: MathBlock = {
          id: ctx.nextBlockId(),
          type: "math",
          charRuns: ctx.rawText(latex),
          formats: [],
          displayMode: true,
        };
        return math;
      },
    },
    html: {
      output: (block, ctx) => {
        const b = block as MathBlock;
        const latex = getVisibleTextFromRuns(b.charRuns);
        if (!latex) return "";
        // The clipboard prefers source: emit the `$$…$$` LaTeX so a copied
        // equation pastes as editable math into LaTeX/markdown-aware apps (and as
        // readable source elsewhere), instead of the non-editable SVG that file
        // export wants.
        if (ctx.preferSource) {
          return `<div style="text-align:center;margin:1em 0;">$$${escapeHtml(latex)}$$</div>`;
        }
        try {
          if (!ctx.renderMathSVG) throw new Error("no math renderer");
          const svg = ctx.renderMathSVG(latex, true);
          return `<div style="text-align:center;margin:1em 0;">${svg}</div>`;
        } catch {
          return `<code>${escapeHtml(latex)}</code>`;
        }
      },
    },
    text: {
      output: () => "",
    },
  };

  // ── Caret model (block equation) ────────────────────────────────────────────
  // The block's char-run text IS the LaTeX, so a block text index is a LaTeX
  // offset. The equation isn't an opaque atom — the caret descends into it — so
  // it overrides `move`/`deleteUnit` (delegating to the shared math model in
  // `./math`) rather than declaring `atomicSpans`. The post-edit *effects*
  // (materialize a construct, arm caret scratch) are the TEXT_INPUTTED observer
  // in `registerActions`, not part of the caret model.
  readonly caret: CaretModel<TextualBlock> = {
    move: (block, index, motion) => mathCaretMove(block, index, motion),
    deleteUnit: (block, index, dir) => mathDeleteUnit(block, index, dir),
    transformInput: (block, index, input) =>
      mathTransformTypedInput(block, index, input),
  };

  /**
   * Register the math node's pointer handler:
   *  - `POINTER_MOVE` (observe, priority 0) — highlight the whole math block
   *    under the pointer (full-block backdrop, `ui.hoveredMathBlockIndex` via
   *    {@link SET_MATH_BLOCK_HOVER}), and otherwise the inline-math chip under
   *    the pointer when over ordinary text (`ui.inlineMathHover` via
   *    {@link SET_INLINE_MATH_HOVER}).
   *
   * Block math is now textual, so a click lands a caret inside the equation (the
   * caret descends via {@link positionFromPoint} + the tex hit-test) rather than
   * opening a popover — the same canvas-native editing inline chips already have.
   */
  registerActions(bus: ActionBus): void {
    // Backspace at the start of a display equation demotes the same node to a
    // paragraph and preserves its LaTeX as inline math. Claim DELETE_BACKWARD
    // directly rather than the cross-block join action so this also works when
    // the equation is the first visible block.
    bus.registerState(
      DELETE_BACKWARD,
      (state) => {
        const cursor = state.document.cursor;
        if (!cursor || cursor.position.textIndex !== 0) return;
        if (state.ui.composition) return;
        if (state.document.selection && !state.document.selection.isCollapsed) {
          return;
        }

        const blockIndex = cursor.position.blockIndex;
        const block = state.document.page.blocks[blockIndex];
        if (!block || block.deleted || block.type !== "math") return;

        const paragraph: Block = {
          id: block.id,
          orderKey: block.orderKey,
          type: "paragraph",
          charRuns: block.charRuns,
          formats: [],
        };
        invalidateBlockCache(paragraph);

        const blocks = [...state.document.page.blocks];
        blocks[blockIndex] = paragraph;
        let page = { ...state.document.page, blocks };
        const ops: Operation[] = [
          {
            op: "block_set",
            id: state.CRDTbinding.nextId(),
            clock: state.CRDTbinding.getClock(),
            pageId: state.CRDTbinding.pageId,
            blockId: block.id,
            field: "type",
            value: "paragraph",
          },
        ];

        const latexLength = getVisibleTextFromRuns(block.charRuns).length;
        if (latexLength > 0) {
          const marked = markCharsInRange(
            page,
            block.id,
            0,
            latexLength,
            { type: "math" },
            true,
            state.CRDTbinding,
          );
          page = marked.newPage;
          ops.push(marked.op);
          invalidateBlockCache(page.blocks[blockIndex]);
        }

        return {
          state: {
            ...state,
            document: { ...state.document, page },
          },
          ops,
          handled: true,
        };
      },
      50,
    );

    // Scope the first Ctrl/Cmd+A to the active equation. Once that exact range
    // is already selected, leave the action unclaimed so its normal default
    // expands to the whole document on the second press.
    bus.registerState(
      SELECT_ALL,
      (state) => {
        const cursor = state.document.cursor;
        if (!cursor) return;
        const blockIndex = cursor.position.blockIndex;
        const block = state.document.page.blocks[blockIndex];
        if (!block || block.deleted || block.type !== "math") return;

        const length = getVisibleTextFromRuns(block.charRuns).length;
        const selection = state.document.selection;
        const alreadySelected =
          selection !== null &&
          selection.anchor.blockIndex === blockIndex &&
          selection.focus.blockIndex === blockIndex &&
          Math.min(selection.anchor.textIndex, selection.focus.textIndex) ===
            0 &&
          Math.max(selection.anchor.textIndex, selection.focus.textIndex) ===
            length;
        if (alreadySelected) return;

        return {
          state: selectMathRange(state, blockIndex, 0, length),
          ops: [],
          handled: true,
        };
      },
      50,
    );

    // A pointer double-click (desktop) / double-tap (touch) normally selects a
    // prose "word". LaTeX source words are the wrong abstraction here (`frac`
    // without its slash/arguments, for example), so claim BOTH gestures for block
    // equations and select the construct under the pointer, whole, instead: any
    // glyph of a fraction's numerator highlights the entire `\frac`, a script base
    // the whole `x^{2}`, while a lone top-level token (`\alpha`, a bare `a`) selects
    // itself. `mathUnitAt` resolves both sides of the hit-test boundary and prefers
    // the construct, so clicking a numerator glyph never falls back to a single
    // source character. One handler, registered for the mouse and touch actions.
    const selectMathWord: StateHandler<{ position: Position }> = (
      state,
      { position },
    ) => {
      const block = state.document.page.blocks[position.blockIndex];
      if (!block || block.deleted || block.type !== "math") return;
      const latex = getVisibleTextFromRuns(block.charRuns);
      const unit = mathUnitAt(latex, position.textIndex);
      if (!unit) return { state, ops: [], handled: true };

      return {
        state: selectMathRange(
          state,
          position.blockIndex,
          unit.start,
          unit.end,
        ),
        ops: [],
        handled: true,
      };
    };
    bus.registerState(SELECT_WORD_AT_POINT, selectMathWord, 50);
    bus.registerState(TAP_SELECT_WORD, selectMathWord, 50);

    bus.registerState(
      POINTER_MOVE,
      (state, { textPosition, blockUnderPoint, canvasX, viewport }) => {
        // Readonly documents never highlight math on hover — neither the
        // full-block backdrop nor an inline chip (which would also flip the
        // pointer cursor). This handler is the sole writer of both hover slots,
        // so simply leaving them untouched keeps them null in a readonly editor.
        if (state.ui.isReadonlyBase) return { state, ops: [] };
        // Whole-block hover: the pointer is genuinely over a (now textual) math
        // block. Gate on `blockUnderPoint` (bounds-exact), NOT `textPosition`
        // (which clamps to the last block), so hovering the empty space below a
        // trailing equation doesn't light it.
        const mathBlockIndex =
          blockUnderPoint !== null &&
          state.document.page.blocks[blockUnderPoint]?.type === "math"
            ? blockUnderPoint
            : null;
        state = state.actionBus.dispatchState(SET_MATH_BLOCK_HOVER, state, {
          blockIndex: mathBlockIndex,
        }).state;

        // Inline-math chip hover — only when not over a block equation.
        let inlineMathHover: InlineMathHover | null = null;
        if (mathBlockIndex === null && textPosition) {
          const inlineMath = getInlineMathAtPosition(
            textPosition.blockIndex,
            textPosition.textIndex,
            state,
            "inside",
            { x: canvasX, viewport },
          );
          if (inlineMath) {
            inlineMathHover = {
              blockIndex: textPosition.blockIndex,
              startIndex: inlineMath.startIndex,
              endIndex: inlineMath.endIndex,
            };
          }
        }
        return {
          state: state.actionBus.dispatchState(SET_INLINE_MATH_HOVER, state, {
            hover: inlineMathHover,
          }).state,
          ops: [],
        };
      },
      0,
    );

    // Enter in a block equation must NOT split the LaTeX at the caret (that tears
    // the formula and reads as deleting it). Instead it finalizes the equation
    // and starts a fresh paragraph below — the same exit an image/line gives on
    // Enter. Claims SPLIT_BLOCK only for math blocks; else observes and passes
    // through to the default block-split (mirrors CodeNode claiming Enter).
    bus.register(
      SPLIT_BLOCK,
      ((state: EditorState) => {
        const cursor = state.document.cursor;
        if (!cursor) return;
        const blockIndex = cursor.position.blockIndex;
        const block = state.document.page.blocks[blockIndex];
        if (!block || block.deleted || block.type !== "math") return;

        const page = state.document.page;
        const newParagraphId = state.CRDTbinding.nextId();
        const orderKey = orderKeyAfter(page.blocks, block.id);
        const ops: Operation[] = [
          {
            op: "block_insert",
            id: state.CRDTbinding.nextId(),
            clock: state.CRDTbinding.getClock(),
            pageId: state.CRDTbinding.pageId,
            orderKey,
            blockId: newParagraphId,
            blockType: "paragraph",
          },
        ];
        // Replay the op so the paragraph lands where every replica sorts it
        // (a tombstone tied on this block's orderKey shifts the position),
        // then place the caret by id instead of assuming blockIndex + 1.
        const newPage = applyOps(page, ops);
        let next: EditorState = {
          ...state,
          document: { ...state.document, page: newPage },
        };
        next = clearSelection(next);
        const paragraphIndex = findBlockIndex(newPage, newParagraphId);
        next = moveCursorToPosition(
          next,
          paragraphIndex !== -1 ? paragraphIndex : blockIndex + 1,
          0,
        );
        return { state: next, ops, handled: true };
      }) as unknown as ActionHandler<void>,
      0,
    );

    // Post-insert normalization (the *effect* half of the caret/edit seam, the
    // counterpart to the pure queries on `edit`). After a keystroke settles, fill
    // an incomplete construct it just completed (`\frac` → `\frac{}{}`, caret to
    // the numerator) and arm caret scratch for an in-progress command (`\in`
    // rendered literally until the caret moves). One observer covers BOTH a block
    // equation and an inline chip — `normalizeMathInput` resolves which (or
    // neither) from the block + caret and no-ops on non-math content — so this is
    // the single home for what used to be split between this node's and MathMark's
    // `materializeAfterInput`/`armCaretScratch`. Observes (no `handled`) so it
    // composes with any other node/mark's normalizer.
    bus.registerState(TEXT_INPUTTED, (state, { blockIndex, textIndex }) =>
      normalizeMathInput(state, blockIndex, textIndex),
    );

    // The delete-side counterpart: after the plain text separating two inline
    // chips is removed, fuse the now-adjacent chips back into one formula. The
    // split half lives in `normalizeMathInput` above (TEXT_INPUTTED); both keep
    // inline math's "a space is a chip boundary" model consistent across edits.
    // A block equation has no chip spans, so it also gets the direct fusion guard
    // below: a delete that welds a command onto a following letter (`\int_{}a` →
    // `\inta`) gets its separator space back so it never renders as raw source.
    bus.registerState(CONTENT_DELETED, (state, { blockIndex, textIndex }) => {
      const merged = mergeInlineMath(state, blockIndex);
      const separated = separateBlockMath(merged.state, blockIndex, textIndex);
      return { state: separated.state, ops: [...merged.ops, ...separated.ops] };
    });
  }
}

/** The inline-math mark — applied to fuse chips, removed over a space to split. */
const INLINE_MATH_MARK: Mark = { type: "math" };

/** Select `[from, to)` within one math block and remember its gesture boundary. */
function selectMathRange(
  state: EditorState,
  blockIndex: number,
  from: number,
  to: number,
): EditorState {
  const start: Position = { blockIndex, textIndex: from };
  const end: Position = { blockIndex, textIndex: to };
  let next = moveCursorToPosition(state, blockIndex, to);
  next = {
    ...next,
    document: {
      ...next.document,
      selection: {
        anchor: start,
        focus: end,
        isForward: true,
        isCollapsed: false,
        lastUpdate: Date.now(),
        initialBoundary: { start, end },
      },
    },
  };
  return updateMode(next, "select");
}

/**
 * Materialize an incomplete math construct, then arm caret-anchored scratch,
 * after an edit landed the caret at `(blockIndex, textIndex)` — the body of
 * MathNode's TEXT_INPUTTED observer (covering block equations AND inline chips,
 * since the shared math model resolves either from the block + caret). The
 * placeholder braces are inserted as real CRDT ops, returned in the threaded
 * `{ state, ops }` so the caller folds them into the same edit (one undo entry,
 * consistent across collaborators). A no-op — state unchanged, no ops — unless
 * the caret sits in math content with something to fill, so it's safe to run on
 * every keystroke regardless of block type.
 */
function normalizeMathInput(
  state: EditorState,
  blockIndex: number,
  textIndex: number,
): StateResult {
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return { state, ops: [] };

  let next = state;
  const ops: Operation[] = [];
  let caret = textIndex;

  // A non-space char typed at a chip's outer edge counts as inside it: re-mark
  // the chip to swallow the char so typing keeps extending the same formula
  // (`\oint`+`x` first gets a separator so it stays `\oint x`, never `\ointx`,
  // and a brace gets its escaping `\` so it joins as the literal `\{`). A
  // space at an edge leaves the chip — it never reaches here as a join. This runs
  // before materialize so a command completed at the edge (`\fra`+`c`) is joined
  // first, then its `\frac{}{}` placeholder fills in as usual. The fallback
  // covers the one-keystroke-later repair: a digit typed right after an edge
  // `.`/`,` re-marks the chip to absorb both — the punctuation the edge join
  // ejected as prose turned out to be part of a number (`$3$.` + `1` → `$3.1$`).
  const join =
    mathJoinAtEdgeAfterInput(block, caret) ??
    mathAbsorbNumericPunctuationAfterInput(block, caret);
  if (join) {
    let page = next.document.page;
    let to = join.to;
    if (join.insert) {
      const ins = insertCharsAtPosition(
        page,
        block.id,
        join.insert.at,
        join.insert.text,
        next.CRDTbinding,
      );
      page = ins.newPage;
      ops.push(ins.op);
      to += join.insert.text.length;
      caret += join.insert.text.length;
    }
    const marked = markCharsInRange(
      page,
      block.id,
      join.from,
      to,
      INLINE_MATH_MARK,
      true,
      next.CRDTbinding,
    );
    page = marked.newPage;
    ops.push(marked.op);
    invalidateBlockCache(page.blocks[blockIndex]);
    next = { ...next, document: { ...next.document, page } };
    next = moveCursorToPosition(next, blockIndex, caret, true);
  }

  const materializeBlock = next.document.page.blocks[blockIndex];
  const mat =
    materializeBlock && !materializeBlock.deleted
      ? mathMaterializeAfterInput(materializeBlock, caret)
      : null;
  if (mat && mat.inserts.length > 0) {
    let page = next.document.page;
    // Right-to-left keeps each earlier `at` valid as later inserts shift text.
    for (const ins of [...mat.inserts].sort((a, b) => b.at - a.at)) {
      if (ins.text.length === 0) continue; // empty placeholder = nothing to insert
      const { newPage, op } = insertCharsAtPosition(
        page,
        block.id,
        ins.at,
        ins.text,
        next.CRDTbinding,
      );
      page = newPage;
      ops.push(op);
    }
    // An inline chip's braces can land at its right edge, outside the math mark.
    // Re-mark the grown chip so the new slots stay part of the formula instead of
    // becoming plain text after it (a block equation returns no `markRange`).
    if (mat.markRange) {
      const { newPage, op } = markCharsInRange(
        page,
        block.id,
        mat.markRange.from,
        mat.markRange.to,
        INLINE_MATH_MARK,
        true,
        next.CRDTbinding,
      );
      page = newPage;
      ops.push(op);
    }
    invalidateBlockCache(page.blocks[blockIndex]);
    next = { ...next, document: { ...next.document, page } };
    caret = mat.caret;
    next = moveCursorToPosition(next, blockIndex, caret, true);
  }

  // A space just typed inside an inline chip breaks it in two: strip the "math"
  // mark from that one space (which splits the run's span — see the reducer's
  // format-removal path), leaving two chips with a plain space between. No-op
  // for a block equation, a non-space keystroke, or a space inside a construct.
  const editedBlock = next.document.page.blocks[blockIndex];
  const split =
    editedBlock && !editedBlock.deleted
      ? mathSplitAfterInput(editedBlock, caret)
      : null;
  if (split) {
    const { newPage, op } = markCharsInRange(
      next.document.page,
      block.id,
      split.from,
      split.to,
      INLINE_MATH_MARK,
      false,
      next.CRDTbinding,
    );
    invalidateBlockCache(newPage.blocks[blockIndex]);
    next = { ...next, document: { ...next.document, page: newPage } };
    ops.push(op);
  } else {
    // A space that didn't split a chip but landed *inside* a formula (a block
    // equation, or an inline chip's construct like `\frac{a }{b}`) is dead LaTeX
    // — math mode collapses it, so drop it instead of saving a meaningless space.
    // Kept only when it's a real command separator (`\sin x`) or a text-mode
    // space (`\text{a b}`); see mathRedundantSpaceAfterInput. The caret steps
    // back onto where the space was so the next keystroke continues in place.
    const redundant =
      editedBlock && !editedBlock.deleted
        ? mathRedundantSpaceAfterInput(editedBlock, caret)
        : null;
    if (redundant) {
      const { newPage, op } = deleteCharsInRange(
        next.document.page,
        block.id,
        redundant.from,
        redundant.to,
        next.CRDTbinding,
      );
      invalidateBlockCache(newPage.blocks[blockIndex]);
      next = { ...next, document: { ...next.document, page: newPage } };
      ops.push(op);
      caret = redundant.from;
      next = moveCursorToPosition(next, blockIndex, caret, true);
    }
  }

  // Arm scratch against the post-materialize content at the (possibly moved) caret.
  const scratchBlock = next.document.page.blocks[blockIndex];
  const scratch =
    scratchBlock && !scratchBlock.deleted
      ? mathArmScratch(scratchBlock, caret)
      : null;
  if (scratch) {
    next = { ...next, ui: { ...next.ui, caretScratch: scratch } };
  }
  return { state: next, ops };
}

/**
 * Body of MathNode's CONTENT_DELETED observer: when a deletion left inline chips
 * touching (the text between them is gone), re-apply the "math" mark across each
 * adjacent run so they merge into one formula — the inverse of the space-split in
 * {@link normalizeMathInput}. A no-op (state unchanged, no ops) unless something
 * is adjacent, so it's safe to run after every delete regardless of block type.
 */
function mergeInlineMath(state: EditorState, blockIndex: number): StateResult {
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return { state, ops: [] };

  const plans = mathMergeAfterDelete(block);
  if (!plans) return { state, ops: [] };

  const ops: Operation[] = [];
  let page = state.document.page;
  // Apply plans right-to-left so an earlier plan's positions stay valid across
  // the separator inserts a later (higher-index) plan makes.
  for (const plan of [...plans].reverse()) {
    let to = plan.to;
    // Insert each separator space right-to-left, then extend the marked range to
    // cover them: a control word fused to a following letter (`\sin`⎵`x`) gets a
    // space back so the merged chip stays valid LaTeX (`\sin x`, never `\sinx`).
    for (const at of [...plan.separatorsAt].sort((a, b) => b - a)) {
      const ins = insertCharsAtPosition(
        page,
        block.id,
        at,
        " ",
        state.CRDTbinding,
      );
      page = ins.newPage;
      ops.push(ins.op);
      to += 1;
    }
    const { newPage, op } = markCharsInRange(
      page,
      block.id,
      plan.from,
      to,
      INLINE_MATH_MARK,
      true,
      state.CRDTbinding,
    );
    page = newPage;
    ops.push(op);
  }
  invalidateBlockCache(page.blocks[blockIndex]);
  return {
    state: { ...state, document: { ...state.document, page } },
    ops,
  };
}

/**
 * Block-equation counterpart of {@link mergeInlineMath}: after a delete welds a
 * control word onto a following letter (backspacing the empty subscript in
 * `\int_{}a` leaves `\inta`, one unknown command rendered as raw red source),
 * reinsert the command-separator space so the two stay distinct atoms (`\int a`).
 * `caret` is the post-delete caret offset (the weld point). A no-op unless a weld
 * actually happened, so it's safe to run after every delete. The caret is left
 * where the delete put it — just after the command, before the reinserted space.
 */
function separateBlockMath(
  state: EditorState,
  blockIndex: number,
  caret: number,
): StateResult {
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return { state, ops: [] };

  const at = mathSeparatorAfterDelete(block, caret);
  if (at === null) return { state, ops: [] };

  const { newPage, op } = insertCharsAtPosition(
    state.document.page,
    block.id,
    at,
    " ",
    state.CRDTbinding,
  );
  invalidateBlockCache(newPage.blocks[blockIndex]);
  return {
    state: { ...state, document: { ...state.document, page: newPage } },
    ops: [op],
  };
}

// ─── Math actions ────────────────────────────────────────────────────────────
//
// The math-specific click/hover actions live with the node they act on. The
// handler in `mouseEvents.ts` resolves the hit (clicked chip range, hovered
// block index) and dispatches these via `state.actionBus.dispatchState(...)`.
// All are pure — they touch overlay/hover UI state and emit no ops.

/** An inline-math chip's highlight range (engine-owned hover state). */
export interface InlineMathHover {
  blockIndex: number;
  startIndex: number;
  endIndex: number;
}

/** Set or clear the hovered block-math index (full-block backdrop). Pure, no ops. */
export const SET_MATH_BLOCK_HOVER = stateAction<{ blockIndex: number | null }>(
  "set-math-block-hover",
  (state, { blockIndex }) => {
    if (blockIndex === state.ui.hoveredMathBlockIndex)
      return { state, ops: [] };
    return {
      state: {
        ...state,
        ui: { ...state.ui, hoveredMathBlockIndex: blockIndex },
      },
      ops: [],
    };
  },
);

/**
 * Set or clear the inline-math chip hover highlight. The handler resolves the
 * chip range under the pointer (or `null`); this installs it only when the range
 * actually changed. Pure, no ops.
 */
export const SET_INLINE_MATH_HOVER = stateAction<{
  hover: InlineMathHover | null;
}>("set-inline-math-hover", (state, { hover }) => {
  const prev = state.ui.inlineMathHover;
  const changed =
    (prev === null) !== (hover === null) ||
    (prev &&
      hover &&
      (prev.blockIndex !== hover.blockIndex ||
        prev.startIndex !== hover.startIndex ||
        prev.endIndex !== hover.endIndex));
  if (!changed) return { state, ops: [] };
  return {
    state: { ...state, ui: { ...state.ui, inlineMathHover: hover } },
    ops: [],
  };
});

/**
 * Move the caret out of the inline-math chip `[startIndex, endIndex)` in
 * `blockId`, toward `direction`, and dismiss the chip's transient UI (any open
 * menu + the edit-highlight `inlineMathHover`). A pure cursor move — no ops.
 *
 * This is the inline-math counterpart to the caret-exit a host needs when the
 * user arrows/Escapes out of the WYSIWYG popover that mirrors the chip. It lives
 * here with the math node (not as a method on the generic editor handle) and is
 * fired by the host via `editor.dispatch(EXIT_INLINE_MATH, …)`, like
 * every other node/mark behavior. The caret is placed on the exiting edge and
 * then stepped one position further with the caret-model-aware
 * {@link moveCursorLeft} / {@link moveCursorRight}, so the chip's own snap can't
 * pull it back inside.
 */
export const EXIT_INLINE_MATH = stateAction<{
  blockId: string;
  startIndex: number;
  endIndex: number;
  direction: "left" | "right";
}>(
  "exit-inline-math",
  (state, { blockId, startIndex, endIndex, direction }) => {
    const blockIndex = state.document.page.blocks.findIndex(
      (b) => b.id === blockId,
    );
    if (blockIndex === -1) return { state, ops: [] };

    let next = closeActiveMenu(state);
    // Clear the edit highlight that lit the chip while the popover was open.
    if (next.ui.inlineMathHover) {
      next = { ...next, ui: { ...next.ui, inlineMathHover: null } };
    }

    // Place the caret on the side we're exiting toward, then step out one
    // position so the chip's snap doesn't pull us back inside.
    next =
      direction === "left"
        ? moveCursorLeft(moveCursorToPosition(next, blockIndex, startIndex))
        : moveCursorRight(moveCursorToPosition(next, blockIndex, endIndex));

    return { state: next, ops: [] };
  },
);
