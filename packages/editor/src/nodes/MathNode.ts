/**
 * MathNode — the `math` (block-level LaTeX equation) block ported onto
 * AtomicNode.
 *
 * Rendering goes through `@cypherkit/tex`, the canvas-native LaTeX engine: the
 * equation is laid out synchronously (metrics are a data table) and painted
 * straight onto the canvas with `paintMath`. There is no rasterization, no
 * bitmap cache, and no async render — so the height pass and paint always agree
 * on size, with no reflow once an image decodes (the old MathJax path). Fonts
 * load asynchronously at startup; until then the layout's dimensions are still
 * exact (so the block reserves the right space) and glyphs simply paint in on
 * the host's font-load redraw.
 *
 * Click-to-edit and hover tracking are node contributions registered on the
 * action bus (`registerActions`): a `TEXT_CLICK` handler opens the inline-math
 * editor when a click lands on a chip, and a `POINTER_MOVE` handler owns the
 * block + inline-math hover highlights. The event layer only resolves the
 * pointer's atomic block / caret position and dispatches those actions. The
 * shared selection-overlay machinery is inherited from AtomicNode.
 *
 * The serialization methods are this node's markdown/HTML/text round-trip,
 * adapted into a BlockCodec by the schema. HTML output renders through
 * `ctx.renderMathSVG`, injected by the HTML orchestrator.
 */

import { layoutMath, type MathLayout, paintMath } from "@cypherkit/tex";

import { type ActionBus, stateAction } from "../action-bus";
import { POINTER_MOVE, TEXT_CLICK } from "../actions/pointer-actions";
import { getInlineMathAtPosition } from "../inline-math";
import { AtomicNode } from "../rendering/nodes/AtomicNode";
import type {
  BlockRuntimeState,
  NodeLayoutCtx,
  NodePaintCtx,
} from "../rendering/nodes/Node";
import { escapeHtml } from "../serlization/codecs/inline";
import type { InputCtx, OutputCtx } from "../serlization/codecs/types";
import type { Block } from "../serlization/loadPage";
import {
  MATH_BLOCK,
  NEWLINE,
  type TokenType,
  type VisibleToken,
} from "../serlization/tokenizer";
import type { ActiveMenu, BlockBounds } from "../state-types";
import { setActiveMenu } from "../state-utils";

// Math block - rendered LaTeX equation. Named `MathBlock` (not `Math`) to avoid
// shadowing the global `Math` object, which this module uses heavily.
export interface MathBlock extends BlockRuntimeState {
  type: "math";
  latex: string;
  displayMode: boolean; // true = display/block mode, false = inline mode
}

// Display-math base font size, in CSS pixels (block equations render a touch
// larger than body text).
const BLOCK_MATH_FONT_SIZE = 22;

export class MathNode extends AtomicNode<MathBlock> {
  readonly type = "math" as const;

  /**
   * The math block's localized canvas strings, owned by the node rather than
   * the global string table. English defaults; localize per instance via
   * `theme.nodeStrings.math`. Read with `this.str`.
   */
  readonly strings = {
    clickToEdit: "Click to add equation",
    rendering: "Rendering...",
  } as const;

  // ── Rendering ──────────────────────────────────────────────────────────────

  /**
   * Lay out the equation (or null when empty). Synchronous and exact — the
   * engine reads metrics from a data table, so the height pass and paint agree
   * on size with no async round-trip and no font-load reflow.
   */
  private mathLayout(c: NodeLayoutCtx): MathLayout | null {
    const block = c.block as MathBlock;
    if (!block.latex) return null;
    return layoutMath(block.latex, {
      fontSize: BLOCK_MATH_FONT_SIZE,
      displayMode: block.displayMode,
    });
  }

  /**
   * Drawn equation height, excluding the block's own top/bottom flow padding.
   * Falls back to minHeight for an empty block.
   */
  private contentHeight(c: NodeLayoutCtx): number {
    const m = c.styles.blocks.math;
    const l = this.mathLayout(c);
    if (l) return Math.max(m.minHeight, l.height + l.depth);
    return m.minHeight;
  }

  protected intrinsicHeight(c: NodeLayoutCtx): number {
    const m = c.styles.blocks.math;
    return this.contentHeight(c) + m.paddingTop + m.paddingBottom;
  }

  protected draw(box: BlockBounds, c: NodePaintCtx): void {
    const block = c.block as MathBlock;
    const { ctx, state, styles, blockIndex } = c;
    const m = styles.blocks.math;
    const { x, y, width } = box;
    const contentHeight = this.contentHeight(c);
    const contentY = y + m.paddingTop;

    // Hover backdrop over the whole block — signals it is clickable.
    if (state.ui.hoveredMathBlockIndex === blockIndex && block.latex) {
      ctx.fillStyle = m.hoverBackgroundColor;
      ctx.beginPath();
      ctx.roundRect(x, y, width, box.height, m.hoverBorderRadius);
      ctx.fill();
    }

    if (block.latex) {
      // Paint the equation centered, directly onto the canvas. `y` passed to
      // paintMath is the baseline (top of the centered box + its above-baseline
      // height).
      const l = this.mathLayout(c)!;
      const w = l.width;
      const h = l.height + l.depth;
      const drawX = x + Math.max(0, (width - w) / 2);
      const drawTop = contentY + Math.max(0, (contentHeight - h) / 2);
      paintMath(ctx, l, drawX, drawTop + l.height, {
        color: styles.blocks.paragraph.color,
      });
    } else {
      // Empty math block — draw the click-to-edit placeholder.
      ctx.fillStyle = m.placeholder.backgroundColor;
      ctx.beginPath();
      ctx.roundRect(x, contentY, width, contentHeight, 6);
      ctx.fill();

      ctx.fillStyle = m.placeholder.textColor;
      ctx.font = "14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        this.str(state, "clickToEdit"),
        x + width / 2,
        contentY + contentHeight / 2,
      );
    }
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  readonly markdownTokens: readonly TokenType[] = [MATH_BLOCK];

  outputMarkdown(block: MathBlock): string {
    const b = block;
    if (!b.latex) return "";
    if (b.displayMode) {
      return `$$\n${b.latex}\n$$`;
    }
    return `$${b.latex}$`;
  }

  inputMarkdown(ctx: InputCtx): Block {
    ctx.match(MATH_BLOCK);
    const latex = (ctx.previous() as VisibleToken).content;
    ctx.match(NEWLINE);

    const math: MathBlock = {
      id: ctx.nextBlockId(),
      type: "math",
      latex,
      displayMode: true,
    };
    return math;
  }

  outputHTML(block: MathBlock, ctx: OutputCtx): string {
    const b = block;
    if (!b.latex) return "";
    try {
      if (!ctx.renderMathSVG) throw new Error("no math renderer");
      const svg = ctx.renderMathSVG(b.latex, b.displayMode);
      if (b.displayMode) {
        return `<div style="text-align:center;margin:1em 0;">${svg}</div>`;
      }
      return `<span style="display:inline-block;vertical-align:middle;">${svg}</span>`;
    } catch {
      return `<code>${escapeHtml(b.latex)}</code>`;
    }
  }

  outputText(): string {
    return "";
  }

  /**
   * Register the math node's pointer/click handlers:
   *  - `POINTER_MOVE` (observe, priority 0) — highlight the math block under the
   *    pointer (full-block backdrop), or the inline-math chip under it when over
   *    text. Owns `ui.hoveredMathBlockIndex` / `ui.inlineMathHover` via
   *    {@link SET_MATH_BLOCK_HOVER} / {@link SET_INLINE_MATH_HOVER}.
   *  - `TEXT_CLICK` (claim, priority 50) — a click on an inline-math chip opens
   *    the inline-math editor popover (the host `math` mark owns the overlay key)
   *    instead of placing the caret inside the LaTeX source.
   */
  registerActions(bus: ActionBus): void {
    bus.registerState(
      POINTER_MOVE,
      (state, { atomicBlock, textPosition, canvasX, viewport }) => {
        const mathBlockIndex =
          atomicBlock &&
          state.document.page.blocks[atomicBlock.blockIndex]?.type === "math"
            ? atomicBlock.blockIndex
            : null;
        state = state.actionBus.dispatchState(SET_MATH_BLOCK_HOVER, state, {
          blockIndex: mathBlockIndex,
        }).state;

        // Inline math chip hover — only when not over a block-math backdrop.
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

    bus.registerState(
      TEXT_CLICK,
      (state, { position, previousMenu, canvasX, canvasY, viewport }) => {
        if (state.ui.mode === "readonly") return;

        const inlineMath = getInlineMathAtPosition(
          position.blockIndex,
          position.textIndex,
          state,
          "inside",
          { x: canvasX, viewport },
        );
        // The inline-math edit overlay is host-defined; the `math` mark owns its key.
        const key = inlineMath
          ? state.marks.get("math")?.editOverlayKey
          : undefined;
        if (!inlineMath || !key) return;

        const blockId = state.document.page.blocks[position.blockIndex]?.id;
        if (!blockId) return;

        // Don't reopen if we just closed the popover for this same block. Claim
        // it (handled) anyway so the caret doesn't drop into the LaTeX source.
        if (
          previousMenu.type === "overlay" &&
          previousMenu.key === key &&
          previousMenu.blockId === blockId
        ) {
          return { state, ops: [], handled: true };
        }

        return {
          state: state.actionBus.dispatchState(
            OPEN_INLINE_MATH_OVERLAY,
            state,
            {
              overlay: {
                type: "overlay",
                key,
                blockId,
                x: canvasX,
                y: canvasY,
                data: {
                  startIndex: inlineMath.startIndex,
                  endIndex: inlineMath.endIndex,
                  latex: inlineMath.latex,
                },
              },
              hover: {
                blockIndex: position.blockIndex,
                startIndex: inlineMath.startIndex,
                endIndex: inlineMath.endIndex,
              },
            },
          ).state,
          ops: [],
          handled: true,
        };
      },
      50,
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
