/**
 * QuoteNode — an editable block quote with editorial card styling.
 *
 * It reuses TextNode's geometry, marks, caret, selection, and hit-testing,
 * adding only container chrome and blockquote serialization.
 */

import { type ActionBus, type ActionHandler } from "../action-bus";
import {
  registerEmptyBlockBackspaceExit,
  SPLIT_BLOCK,
} from "../actions/edit-actions";
import type {
  BlockRuntimeState,
  NodeLayout,
  NodePaintCtx,
} from "../rendering/nodes/Node";
import { invalidateBlockCache } from "../rendering/renderer";
import { clearSelection, moveCursorToPosition } from "../selection";
import type { InputCtx, OutputCtx } from "../serlization/codecs/types";
import type { Block, Char, CharRun, MarkSpan } from "../serlization/loadPage";
import { NEWLINE, QUOTE } from "../serlization/tokenizer";
import type {
  EditorState,
  EditorStyles,
  Operation,
  QuoteBlockStyle,
  RenderedBlock,
  TextStyle,
} from "../state-types";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { orderKeyAfter } from "../sync/crdt-utils";
import {
  applyOps,
  findNextVisibleBlockIndex,
  findPreviousVisibleBlockIndex,
} from "../sync/reducer";
import { TextNode, type TextNodeLayout, type TextualBlock } from "./TextNode";

/**
 * Whether a quote at `index` visually joins the previous/next block into one
 * continuous card. Consecutive quotes are coupled: the inner corners square off
 * so the backgrounds tile seamlessly, the accent bar runs straight through the
 * seam, and only the run's first block draws the opening glyph. Tombstoned
 * blocks between two quotes are skipped (a deleted block never breaks a run).
 */
export function quoteJoinFlags(
  blocks: Block[],
  index: number,
): { joinTop: boolean; joinBottom: boolean } {
  const prev = findPreviousVisibleBlockIndex(blocks, index);
  const next = findNextVisibleBlockIndex(blocks, index);
  return {
    joinTop: prev !== null && blocks[prev].type === "quote",
    joinBottom: next !== null && blocks[next].type === "quote",
  };
}

export interface QuoteBlock extends BlockRuntimeState {
  type: "quote";
  charRuns: CharRun[];
  formats: MarkSpan[];
}

export class QuoteNode extends TextNode {
  readonly type = "quote" as const;
  readonly types: readonly string[] = ["quote"];
  readonly strings = { placeholder: "Write something worth remembering…" };
  readonly markdownTokens = [QUOTE] as const;

  override textStyle(styles: EditorStyles): TextStyle {
    return styles.blocks.quote;
  }

  protected override estimateLayoutMaxWidth(
    _block: TextualBlock,
    maxWidth: number,
    styles: EditorStyles,
  ): number {
    return maxWidth - styles.blocks.quote.paddingX;
  }

  override computeLayout(
    block: TextualBlock,
    maxWidth: number,
    styles: EditorStyles,
    content?: {
      chars: Char[];
      formats: MarkSpan[];
      compositionRange: { start: number; end: number } | null;
    },
  ): TextNodeLayout {
    return super.computeLayout(
      block,
      maxWidth - styles.blocks.quote.paddingX,
      styles,
      content,
    );
  }

  protected override leadingInset(
    _block: TextualBlock,
    styles: EditorStyles,
  ): { indentOffset: number; markerWidth: number } {
    const quote = styles.blocks.quote;
    return {
      indentOffset: quote.paddingX + quote.accentWidth + quote.accentGap,
      markerWidth: 0,
    };
  }

  protected override contentInsetY(
    block: TextualBlock,
    styles: EditorStyles,
  ): number {
    const quote = styles.blocks.quote;
    // A quote that follows another quote tightens its top inset, so the shared
    // edge reads as one card with reduced internal spacing rather than two full
    // pads stacked. `prevType` is the neighbour hint stamped by getVisibleBlocks;
    // a flip clears this block's layout cache, so the reduced inset recomputes.
    return block.prevType === "quote" ? quote.joinedPaddingY : quote.paddingY;
  }

  protected override contentPaddingBottom(
    block: TextualBlock,
    styles: EditorStyles,
  ): number {
    const quote = styles.blocks.quote;
    // Mirror of contentInsetY for the bottom edge: a quote followed by a quote
    // shrinks its trailing space so the two halves of the seam are symmetric.
    return block.nextType === "quote"
      ? quote.joinedPaddingY
      : quote.paddingBottom;
  }

  override paint(passedLayout: NodeLayout, c: NodePaintCtx): RenderedBlock {
    const layout = passedLayout as TextNodeLayout;
    const quote = c.styles.blocks.quote;
    const { joinTop, joinBottom } = quoteJoinFlags(
      c.state.document.page.blocks,
      c.blockIndex,
    );
    this.paintCard(
      c.ctx,
      c.origin.x,
      c.origin.y,
      c.maxWidth,
      layout.height,
      quote,
      layout.isRTL,
      joinTop,
      joinBottom,
    );
    return super.paint(passedLayout, c);
  }

  /**
   * Draw the card chrome. `joinTop`/`joinBottom` couple this block with an
   * adjacent quote: the joined edge squares off (so abutting cards tile into one
   * shape), the accent extends through the seam instead of insetting, and the
   * opening glyph is drawn only on the first block of the run (`!joinTop`).
   */
  private paintCard(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    style: QuoteBlockStyle,
    isRTL: boolean,
    joinTop: boolean,
    joinBottom: boolean,
  ): void {
    const topRadius = joinTop ? 0 : style.borderRadius;
    const bottomRadius = joinBottom ? 0 : style.borderRadius;

    ctx.save();
    ctx.globalAlpha = style.backgroundOpacity;
    ctx.fillStyle = style.backgroundColor;
    ctx.beginPath();
    // roundRect radii order: [topLeft, topRight, bottomRight, bottomLeft].
    ctx.roundRect(x, y, width, height, [
      topRadius,
      topRadius,
      bottomRadius,
      bottomRadius,
    ]);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.fillStyle = style.accentColor;
    ctx.beginPath();
    const accentX = isRTL
      ? x + width - style.paddingX - style.accentWidth
      : x + style.paddingX;
    // Inset the accent by paddingY only on a free (unjoined) edge; on a seam it
    // runs to the block boundary so it meets the neighbour's accent flush.
    const accentTop = y + (joinTop ? 0 : style.paddingY);
    const accentBottom = y + height - (joinBottom ? 0 : style.paddingY);
    const accentEndRadius = style.accentWidth / 2;
    ctx.roundRect(
      accentX,
      accentTop,
      style.accentWidth,
      Math.max(0, accentBottom - accentTop),
      [
        joinTop ? 0 : accentEndRadius,
        joinTop ? 0 : accentEndRadius,
        joinBottom ? 0 : accentEndRadius,
        joinBottom ? 0 : accentEndRadius,
      ],
    );
    ctx.fill();

    // Only the first block of a consecutive run carries the opening quote glyph.
    if (!joinTop) {
      ctx.globalAlpha = style.glyphOpacity;
      ctx.font = `${style.glyphWeight} ${style.glyphSize}px Georgia, serif`;
      ctx.textBaseline = "top";
      ctx.textAlign = isRTL ? "right" : "left";
      ctx.fillText(
        isRTL ? "”" : "“",
        isRTL
          ? accentX - style.accentGap
          : accentX + style.accentWidth + style.accentGap,
        y + style.glyphOffsetY,
      );
    }
    ctx.restore();
  }

  protected override placeholderText(
    _block: TextualBlock,
    _styles: EditorStyles,
    state: EditorState,
  ): string {
    return this.str(state, "placeholder");
  }

  /**
   * Quote-specific editing affordances:
   * - Backspace at the start of an empty quote exits to a paragraph instead of
   *   merging into the previous block (shared
   *   {@link TextNode.registerEmptyBackspaceExit}).
   * - Enter policy: inside text splits into two quotes; at the end keeps the
   *   quote and starts a paragraph below; on an empty quote converts to a
   *   paragraph.
   */
  registerActions(bus: ActionBus): void {
    registerEmptyBlockBackspaceExit(bus, this.types);

    bus.register(
      SPLIT_BLOCK,
      ((state: EditorState) => {
        const cursor = state.document.cursor;
        if (!cursor) return;
        const blockIndex = cursor.position.blockIndex;
        const block = state.document.page.blocks[blockIndex];
        if (!block || block.deleted || block.type !== "quote") return;

        const textLength = getVisibleTextFromRuns(block.charRuns).length;
        if (textLength > 0 && cursor.position.textIndex < textLength) {
          return;
        }

        if (textLength === 0) {
          const op: Operation = {
            op: "block_set",
            id: state.CRDTbinding.nextId(),
            clock: state.CRDTbinding.getClock(),
            pageId: state.CRDTbinding.pageId,
            blockId: block.id,
            field: "type",
            value: "paragraph",
          };
          const page = applyOps(state.document.page, [op]);
          invalidateBlockCache(page.blocks[blockIndex]);
          const next = clearSelection(state);
          return {
            state: {
              ...next,
              document: { ...next.document, page },
            },
            ops: [op],
            handled: true,
          };
        }

        const newParagraphId = state.CRDTbinding.nextId();
        const orderKey = orderKeyAfter(state.document.page.blocks, block.id);
        const op: Operation = {
          op: "block_insert",
          id: state.CRDTbinding.nextId(),
          clock: state.CRDTbinding.getClock(),
          pageId: state.CRDTbinding.pageId,
          orderKey,
          blockId: newParagraphId,
          blockType: "paragraph",
        };
        const page = applyOps(state.document.page, [op]);
        const paragraphIndex = page.blocks.findIndex(
          (candidate) => candidate.id === newParagraphId,
        );
        let next = clearSelection(state);
        next = { ...next, document: { ...next.document, page } };
        next = moveCursorToPosition(
          next,
          paragraphIndex === -1 ? blockIndex + 1 : paragraphIndex,
          0,
        );
        return { state: next, ops: [op], handled: true };
      }) as unknown as ActionHandler<void>,
      0,
    );
  }

  outputMarkdown(block: TextualBlock, ctx: OutputCtx): string {
    return `> ${ctx.inline(block.charRuns, block.formats)}`;
  }

  inputMarkdown(ctx: InputCtx): Block {
    ctx.match(QUOTE);
    const { charRuns, formats } = ctx.inlineText();
    ctx.match(NEWLINE);
    return {
      id: ctx.nextBlockId(),
      type: "quote",
      charRuns,
      formats,
    } as QuoteBlock;
  }

  outputHTML(block: TextualBlock, ctx: OutputCtx): string {
    return `<blockquote>${ctx.inline(block.charRuns, block.formats)}</blockquote>`;
  }

  outputText(block: TextualBlock, ctx: OutputCtx): string {
    return ctx.inline(block.charRuns, block.formats);
  }
}
