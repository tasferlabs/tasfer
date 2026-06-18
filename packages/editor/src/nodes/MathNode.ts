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

import { type ActionBus, type ActionHandler, stateAction } from "../action-bus";
import { SPLIT_BLOCK } from "../actions/edit-actions";
import { POINTER_MOVE } from "../actions/pointer-actions";
import { getInlineMathAtPosition } from "../inline-math";
import type { MarkRegistry } from "../rendering/marks";
import type {
  BlockRuntimeState,
  NodeLayout,
  NodePaintCtx,
} from "../rendering/nodes/Node";
import { clearSelection, moveCursorToPosition } from "../selection";
import { escapeHtml } from "../serlization/codecs/inline";
import type { InputCtx, OutputCtx } from "../serlization/codecs/types";
import type { Block, Char, CharRun, MarkSpan } from "../serlization/loadPage";
import {
  MATH_BLOCK,
  NEWLINE,
  type TokenType,
  type VisibleToken,
} from "../serlization/tokenizer";
import type {
  ActiveMenu,
  CaretDeleteUnit,
  CaretScratch,
  ContentMaterialization,
  EditorState,
  EditorStyles,
  Operation,
  Position,
  RenderedBlock,
  RenderedLine,
  TypedInputTransform,
} from "../state-types";
import { isCaretScratchActive, setActiveMenu } from "../state-utils";
import {
  getVisibleTextFromChars,
  getVisibleTextFromRuns,
} from "../sync/char-runs";
import {
  mathArmScratch,
  mathCaretStep,
  mathCaretTokenClamp,
  mathCaretVerticalStep,
  mathDeleteUnit,
  mathMaterializeAfterInput,
  mathPendingCommandRange,
  mathTransformTypedInput,
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

/** TextNodeLayout augmented with the rendered equation + its placement. */
interface MathNodeLayout extends TextNodeLayout {
  /** The laid-out equation, or null when the block is empty. */
  readonly mathLayout: MathLayout | null;
  /** Horizontal inset (px from the block's content-left) that centers the math. */
  readonly mathOffsetX: number;
  /** Vertical inset (px from the block top) to the math's top edge. */
  readonly mathTop: number;
}

export class MathNode extends TextNode {
  readonly type = "math" as const;
  readonly types: readonly string[] = ["math"];

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
    const mathLayout = latex
      ? layoutMath(latex, {
          fontSize: BLOCK_MATH_FONT_SIZE,
          displayMode: true,
        })
      : null;
    const mh = mathLayout ? mathLayout.height + mathLayout.depth : 0;
    const contentH = Math.max(m.minHeight, mh);
    const height = contentH + m.paddingTop + m.paddingBottom;
    const mathOffsetX = mathLayout
      ? Math.max(0, (maxWidth - mathLayout.width) / 2)
      : 0;
    const mathTop = m.paddingTop + Math.max(0, (contentH - mh) / 2);
    // LaTeX is always laid out left-to-right. The base layout derives direction
    // from the content (TextNode → getTextDirection), which falls back to the UI
    // default — so in an RTL locale an empty or symbol-only equation would come
    // back RTL and mirror the caret/geometry. Pin it LTR.
    return { ...base, isRTL: false, height, mathLayout, mathOffsetX, mathTop };
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

    // An empty equation draws nothing — no placeholder box, no call-to-action.
    // The centered caret (see `caretRect`) is the only affordance; typing grows
    // the equation outward from the center. `paintMath` is isolated in
    // save/restore so none of its canvas-state mutations leak to the next block
    // (the shared render context is not saved per block).
    ctx.save();

    // Full-block backdrop when the block is hovered OR active (caret/selection
    // inside it) — signals the whole block is the editable equation. Drawn for
    // empty blocks too, so an active empty equation still reads as selected.
    if (
      state.ui.hoveredMathBlockIndex === blockIndex ||
      this.isBlockActive(state, blockIndex)
    ) {
      ctx.fillStyle = m.hoverBackgroundColor;
      ctx.beginPath();
      ctx.roundRect(x, y, width, layout.height, m.hoverBorderRadius);
      ctx.fill();
    }

    if (layout.mathLayout) {
      const latex = getVisibleTextFromChars(layout.chars);

      // Keep a half-typed command (`\al`) in normal color until the caret moves
      // on (the source index IS the LaTeX offset for a math block). Only while
      // the collapsed caret is in this block.
      const sel = state.document.selection;
      const cursor = state.document.cursor;
      const caretIndex =
        cursor &&
        cursor.position.blockIndex === blockIndex &&
        (!sel || sel.isCollapsed)
          ? cursor.position.textIndex
          : null;
      const pendingRange =
        caretIndex !== null
          ? (mathPendingCommandRange(latex, caretIndex) ?? undefined)
          : undefined;

      // While that command is actively being typed (command-entry armed at this
      // exact caret), re-lay it out with the in-progress command kept literal —
      // so the geometry the caret reads matches what's painted (`\in`, not ∈).
      const literalRange = this.commandEntryRange(
        state,
        c.block.id,
        caretIndex,
        pendingRange,
      );
      const mathLayout = literalRange
        ? layoutMath(latex, {
            fontSize: BLOCK_MATH_FONT_SIZE,
            displayMode: true,
            literalRange,
          })
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
        const rects = texSelectionRects(mathLayout, range.from, range.to);
        ctx.globalAlpha = styles.selection.opacity;
        ctx.fillStyle = styles.selection.backgroundColor;
        for (const r of rects) {
          ctx.fillRect(drawX + r.x, baselineY + r.y, r.width, r.height);
        }
        ctx.globalAlpha = 1;
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
      // Empty block — caret in the horizontal center (the equation grows
      // outward from here, staying centered), vertically centered in the
      // content area and sized to the display font.
      return {
        x: originX + l.adjustedMaxWidth / 2,
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
    const literalRange = commandEntryActive
      ? (mathPendingCommandRange(latex, textIndex) ?? undefined)
      : undefined;
    const mathLayout = literalRange
      ? layoutMath(latex, {
          fontSize: BLOCK_MATH_FONT_SIZE,
          displayMode: true,
          literalRange,
        })
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

  /**
   * The pending-command range to render literally, or undefined — non-undefined
   * only while command-entry is armed at this exact block + caret (so a finished
   * command never re-renders literally when the caret later parks at its edge).
   */
  private commandEntryRange(
    state: EditorState,
    blockId: string,
    caretIndex: number | null,
    pendingRange: { start: number; end: number } | undefined,
  ): { start: number; end: number } | undefined {
    if (caretIndex === null || !pendingRange) return undefined;
    return isCaretScratchActive(state, blockId, caretIndex)
      ? pendingRange
      : undefined;
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
    return texHitTest(l.mathLayout, x - baseX, y - baselineY);
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  readonly markdownTokens: readonly TokenType[] = [MATH_BLOCK];

  outputMarkdown(block: TextualBlock): string {
    const b = block as MathBlock;
    const latex = getVisibleTextFromRuns(b.charRuns);
    if (!latex) return "";
    return `$$\n${latex}\n$$`;
  }

  inputMarkdown(ctx: InputCtx): Block {
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
  }

  outputHTML(block: TextualBlock, ctx: OutputCtx): string {
    const b = block as MathBlock;
    const latex = getVisibleTextFromRuns(b.charRuns);
    if (!latex) return "";
    try {
      if (!ctx.renderMathSVG) throw new Error("no math renderer");
      const svg = ctx.renderMathSVG(latex, true);
      return `<div style="text-align:center;margin:1em 0;">${svg}</div>`;
    } catch {
      return `<code>${escapeHtml(latex)}</code>`;
    }
  }

  outputText(): string {
    return "";
  }

  // ── Caret / edit seam (block equation) ──────────────────────────────────────
  // The block's char-run text IS the LaTeX, so a block text index is a LaTeX
  // offset. All delegate to the shared math model in `./math`.

  caretStep(
    block: TextualBlock,
    index: number,
    dir: "left" | "right",
  ): number | null {
    return mathCaretStep(block, index, dir);
  }

  caretVerticalStep(
    block: TextualBlock,
    index: number,
    dir: "up" | "down",
  ): number | null {
    return mathCaretVerticalStep(block, index, dir);
  }

  caretTokenClamp(
    block: TextualBlock,
    target: number,
    dir: "left" | "right",
  ): number | null {
    return mathCaretTokenClamp(block, target, dir);
  }

  deleteUnit(
    block: TextualBlock,
    index: number,
    dir: "backward" | "forward",
  ): CaretDeleteUnit | null {
    return mathDeleteUnit(block, index, dir);
  }

  transformTypedInput(
    block: TextualBlock,
    index: number,
    input: string,
  ): TypedInputTransform | null {
    return mathTransformTypedInput(block, index, input);
  }

  materializeAfterInput(
    block: TextualBlock,
    index: number,
  ): ContentMaterialization | null {
    return mathMaterializeAfterInput(block, index);
  }

  armCaretScratch(block: TextualBlock, index: number): CaretScratch | null {
    return mathArmScratch(block, index);
  }

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
    bus.registerState(
      POINTER_MOVE,
      (state, { textPosition, blockUnderPoint, canvasX, viewport }) => {
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
        const newParagraph: Block = {
          id: newParagraphId,
          afterId: block.id,
          type: "paragraph",
          charRuns: [],
          formats: [],
        };
        const blocks = [
          ...page.blocks.slice(0, blockIndex + 1),
          newParagraph,
          ...page.blocks.slice(blockIndex + 1),
        ];
        const ops: Operation[] = [
          {
            op: "block_insert",
            id: state.CRDTbinding.nextId(),
            clock: state.CRDTbinding.getClock(),
            pageId: state.CRDTbinding.pageId,
            afterBlockId: block.id,
            blockId: newParagraphId,
            blockType: "paragraph",
          },
        ];
        let next: EditorState = {
          ...state,
          document: { ...state.document, page: { ...page, blocks } },
        };
        next = clearSelection(next);
        next = moveCursorToPosition(next, blockIndex + 1, 0);
        return { state: next, ops, handled: true };
      }) as unknown as ActionHandler<void>,
      0,
    );
  }
}

// ─── Math actions ────────────────────────────────────────────────────────────
//
// The math-specific click/hover actions live with the node they act on. The
// handler in `mouseEvents.ts` resolves the hit (clicked chip range, hovered
// block index) and dispatches these via `state.actionBus.dispatchState(...)`.
// All are pure — they touch overlay/hover UI state and emit no ops.

/** An inline-math chip's highlight range (engine-owned hover state). */
interface InlineMathHover {
  blockIndex: number;
  startIndex: number;
  endIndex: number;
}

/**
 * Open the inline-math edit popover for a clicked chip and highlight that chip
 * while the popover is open. The handler resolves the overlay menu (host `math`
 * mark's key + the chip's range as `data`) and the matching hover range. Pure,
 * no ops.
 */
export const OPEN_INLINE_MATH_OVERLAY = stateAction<{
  overlay: Extract<ActiveMenu, { type: "overlay" }>;
  hover: InlineMathHover;
}>("open-inline-math-overlay", (state, { overlay, hover }) => {
  const withOverlay = setActiveMenu(state, overlay);
  return {
    state: {
      ...withOverlay,
      ui: { ...withOverlay.ui, inlineMathHover: hover },
    },
    ops: [],
  };
});

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
