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
import { cardFlowMargins } from "../node-shared";
import type {
  BlockRuntimeState,
  NodeLayout,
  NodePaintCtx,
} from "../rendering/nodes/Node";
import { invalidateBlockCache } from "../rendering/renderer";
import { clearSelection, moveCursorToPosition } from "../selection";
import type { NodeCodec } from "../serlization/codecs/types";
import type { Char, CharRun, MarkSpan } from "../serlization/loadPage";
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
  cardJoinFlags,
  findNextVisibleBlockIndex,
  findPreviousVisibleBlockIndex,
} from "../sync/reducer";
import { TextNode, type TextNodeLayout, type TextualBlock } from "./TextNode";

export interface QuoteBlock extends BlockRuntimeState {
  type: "quote";
  charRuns: CharRun[];
  formats: MarkSpan[];
}

export class QuoteNode extends TextNode {
  readonly type = "quote" as const;
  readonly types: readonly string[] = ["quote"];
  readonly joinGroup = "card";
  // Multi-line plain text pasted inside a quote continues the quote: each
  // pasted paragraph becomes another quote block in the same card run.
  readonly absorbsPastedParagraphs = true;
  readonly strings = { placeholder: "Write something worth remembering…" };

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
    // A free edge additionally carries the outer card margin (zero against any
    // adjacent card) so prose keeps clear of the card surface.
    if (block.prevType === "quote") return quote.joinedPaddingY;
    return cardFlowMargins(block, quote).top + quote.paddingY;
  }

  protected override contentPaddingBottom(
    block: TextualBlock,
    styles: EditorStyles,
  ): number {
    const quote = styles.blocks.quote;
    // Mirror of contentInsetY for the bottom edge: a quote followed by a quote
    // shrinks its trailing space so the two halves of the seam are symmetric.
    if (block.nextType === "quote") return quote.joinedPaddingY;
    return quote.paddingBottom + cardFlowMargins(block, quote).bottom;
  }

  override paint(passedLayout: NodeLayout, c: NodePaintCtx): RenderedBlock {
    const layout = passedLayout as TextNodeLayout;
    const quote = c.styles.blocks.quote;
    const blocks = c.state.document.page.blocks;
    const { joinTop, joinBottom } = cardJoinFlags(
      c.state.nodes,
      blocks,
      c.blockIndex,
    );
    // The card squares off against any adjacent card, but the accent bar only
    // runs through a seam it shares with another quote (which draws a matching
    // accent continuing the line). Against a different card type — e.g. a math
    // block — the accent stays inset so the green line doesn't dangle past the
    // quote into a neighbour that has no accent of its own.
    const prev = findPreviousVisibleBlockIndex(blocks, c.blockIndex);
    const next = findNextVisibleBlockIndex(blocks, c.blockIndex);
    const accentJoinTop = prev !== null && blocks[prev].type === "quote";
    const accentJoinBottom = next !== null && blocks[next].type === "quote";
    // The card is the padded content box; the outer flow margins around it
    // (baked into layout.height) stay unpainted breathing room.
    const margins = cardFlowMargins(c.block, quote);
    this.paintCard(
      c.ctx,
      c.origin.x,
      c.origin.y + margins.top,
      c.maxWidth,
      layout.height - margins.top - margins.bottom,
      quote,
      layout.isRTL,
      joinTop,
      joinBottom,
      accentJoinTop,
      accentJoinBottom,
    );
    return super.paint(passedLayout, c);
  }

  /**
   * Draw the card chrome. `joinTop`/`joinBottom` square off the shared edge when
   * this block abuts any adjacent card, tiling the backgrounds into one shape.
   * `accentJoinTop`/`accentJoinBottom` are the narrower quote-only coupling: the
   * accent runs through the seam (instead of insetting) only where the neighbour
   * is another quote whose accent continues the line.
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
    accentJoinTop: boolean,
    accentJoinBottom: boolean,
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
    // Inset the accent by paddingY on a free edge; on a quote-to-quote seam it
    // runs to the block boundary so it meets the neighbour's accent flush.
    const accentTop = y + (accentJoinTop ? 0 : style.paddingY);
    const accentBottom = y + height - (accentJoinBottom ? 0 : style.paddingY);
    const accentEndRadius = style.accentWidth / 2;
    ctx.roundRect(
      accentX,
      accentTop,
      style.accentWidth,
      Math.max(0, accentBottom - accentTop),
      [
        accentJoinTop ? 0 : accentEndRadius,
        accentJoinTop ? 0 : accentEndRadius,
        accentJoinBottom ? 0 : accentEndRadius,
        accentJoinBottom ? 0 : accentEndRadius,
      ],
    );
    ctx.fill();

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
          const page = applyOps(state.document.page, [op], state.schema);
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
        const page = applyOps(state.document.page, [op], state.schema);
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

  readonly codec: NodeCodec = {
    markdown: {
      tokens: [QUOTE],
      output: (block, ctx) => {
        const b = block as TextualBlock;
        return `> ${ctx.inline(b.charRuns, b.formats)}`;
      },
      input: (ctx) => {
        ctx.match(QUOTE);
        const { charRuns, formats, structuredContent } = ctx.inlineText();
        ctx.match(NEWLINE);
        return {
          id: ctx.nextBlockId(),
          type: "quote",
          charRuns,
          formats,
          ...(structuredContent ? { structuredContent } : {}),
        } as QuoteBlock;
      },
    },
    html: {
      output: (block, ctx) => {
        const b = block as TextualBlock;
        return `<blockquote>${ctx.inline(b.charRuns, b.formats)}</blockquote>`;
      },
    },
    text: {
      output: (block, ctx) => {
        const b = block as TextualBlock;
        return ctx.inline(b.charRuns, b.formats);
      },
    },
  };
}
