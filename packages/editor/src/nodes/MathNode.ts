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
  stateAction,
  type StateResult,
  TEXT_INPUTTED,
} from "../action-bus";
import { SPLIT_BLOCK } from "../actions/edit-actions";
import { POINTER_MOVE } from "../actions/pointer-actions";
import { getInlineMathAtPosition } from "../inline-math";
import type { MarkRegistry } from "../rendering/marks";
import type { CaretModel } from "../rendering/nodes/caret-model";
import type {
  BlockRuntimeState,
  NodeLayout,
  NodePaintCtx,
} from "../rendering/nodes/Node";
import { invalidateBlockCache } from "../rendering/renderer";
import {
  clearSelection,
  moveCursorLeft,
  moveCursorRight,
  moveCursorToPosition,
} from "../selection";
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
  EditorState,
  EditorStyles,
  Operation,
  Position,
  RenderedBlock,
  RenderedLine,
  TextStyle,
} from "../state-types";
import { closeActiveMenu, isCaretScratchActive } from "../state-utils";
import {
  getVisibleTextFromChars,
  getVisibleTextFromRuns,
} from "../sync/char-runs";
import { insertCharsAtPosition } from "../sync/crdt-utils";
import {
  mathArmScratch,
  mathCaretMove,
  mathCommandRanges,
  mathDeleteUnit,
  mathMaterializeAfterInput,
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

  /**
   * A math block is textual (its char-run text is the LaTeX), but the visible
   * equation renders through the tex bridge, not as wrapped text. The throwaway
   * text-layout/caret fallback just needs a valid TextStyle, so borrow the
   * paragraph's (there is no dedicated text style for `math`).
   */
  override textStyle(styles: EditorStyles): TextStyle {
    return styles.blocks.paragraph;
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
    const { literalRange } = mathCommandRanges(
      latex,
      textIndex,
      commandEntryActive,
    );
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
    // The clipboard prefers source: emit the `$$…$$` LaTeX so a copied equation
    // pastes as editable math into LaTeX/markdown-aware apps (and as readable
    // source elsewhere), instead of the non-editable SVG that file export wants.
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
  }

  outputText(): string {
    return "";
  }

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
  }
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

  const mat = mathMaterializeAfterInput(block, textIndex);
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
    invalidateBlockCache(page.blocks[blockIndex]);
    next = { ...next, document: { ...next.document, page } };
    caret = mat.caret;
    next = moveCursorToPosition(next, blockIndex, caret, true);
  }

  // Arm scratch against the post-materialize content at the (possibly moved) caret.
  const editedBlock = next.document.page.blocks[blockIndex];
  const scratch =
    editedBlock && !editedBlock.deleted
      ? mathArmScratch(editedBlock, caret)
      : null;
  if (scratch) {
    next = { ...next, ui: { ...next.ui, caretScratch: scratch } };
  }
  return { state: next, ops };
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
