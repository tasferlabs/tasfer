/**
 * TextBlockView — the on-canvas behavior for every textual block (headings,
 * paragraph, and the bullet/numbered/todo list family).
 *
 * This is the heart of the "geometry on the view" design. Historically the text
 * layout (wrap + indent/marker offsets + RTL base-x + line metrics) was
 * re-derived independently in ~10 places: the render pass, the height pass, the
 * caret-coordinate pass, the click→position hit-test, and the selection-rect
 * pass — each re-calling wrapText/getTextStyle/getFontMetrics with the same
 * inputs. They agreed only because they all happened to read the same styles.
 * The moment a block lays text out differently (a custom style, a custom block)
 * those parallel derivations drift and the caret lands in the wrong place.
 *
 * The fix is a single canonical `layout()` that every pass consumes:
 *
 *   layout()       — wrap + measure once → TextBlockLayout (height + line boxes
 *                    + the indent/marker/RTL geometry needed downstream)
 *   paint()        — draw from a layout (never re-wraps)
 *   caretRect()    — caret screen rect from a layout (used by selection.ts)
 *   positionFromPoint() — click→caret index from a layout (hit-testing)
 *   selectionRects()    — highlight rectangles from a layout
 *
 * All arithmetic here was moved verbatim from renderer.ts / selection.ts so
 * behavior is preserved; the win is that there is now exactly one source of
 * truth for text geometry.
 */

import {
  batchChars,
  type FontFamily,
  getCurrentFontFamily,
  getFontMetrics,
  getFontStack,
  measureCRDTPositions,
  measureTextUpToIndex,
  type TextBatch,
  type WrappedLine,
  wrapText,
} from "../../fonts";
import { getInlineMathDims, getInlineMathImage } from "../../math";
import { getTextDirection } from "../../rtl";
import type {
  Block,
  Char,
  FormatSpan,
  TextualBlock,
} from "../../serlization/loadPage";
import { isListBlock, isTextualBlock } from "../../serlization/loadPage";
import type {
  BlockBounds,
  EditorState,
  EditorStyles,
  FontMetrics,
  Position,
  RenderedBlock,
  RenderedLine,
  SelectionState,
  TextStyle,
} from "../../state-types";
import { getBlockTextContent, isTouchDevice } from "../../state-utils";
import { getTextStyle } from "../../styles";
import { awarenessSelectionToSelection } from "../../sync/awareness";
import {
  charRunsToChars,
  getVisibleTextFromChars,
  getVisibleTextFromRuns,
  iterateVisibleChars,
} from "../../sync/char-runs";
import {
  type BlockLayout,
  type BlockLayoutCtx,
  type BlockPaintCtx,
  BlockView,
} from "./BlockView";
import i18next from "i18next";

/** The block types handled by TextBlockView. */
export const TEXT_BLOCK_TYPES = [
  "heading1",
  "heading2",
  "heading3",
  "paragraph",
  "bullet_list",
  "numbered_list",
  "todo_list",
] as const;

/**
 * The canonical text layout. Extends BlockLayout (height + line boxes) with the
 * derived geometry every text pass needs, so no pass re-derives it.
 *
 * `lines` boxes carry x/y RELATIVE to the block's content origin is intentional:
 * absolute positioning differs between the scroll-space render pass and the
 * document-space caret pass, so callers add their own origin. The line boxes do
 * carry absolute-independent fields: width, height, startIndex, endIndex.
 */
export interface TextBlockLayout extends BlockLayout {
  readonly isRTL: boolean;
  readonly textStyle: TextStyle;
  readonly fontFamily: FontFamily;
  readonly codePadding: number;
  readonly fontMetrics: FontMetrics;
  readonly lineHeight: number;
  readonly indentOffset: number;
  readonly markerWidth: number;
  /** Content width available to text (maxWidth minus list indent + marker). */
  readonly adjustedMaxWidth: number;
  /** Resolved characters used for this layout (may include composition text). */
  readonly chars: Char[];
  readonly formats: FormatSpan[];
  readonly compositionRange: { start: number; end: number } | null;
  /** Raw wrap result, retained for consumers that need consumedSpace. */
  readonly wrapped: WrappedLine[];
}

// ---------------------------------------------------------------------------
// Composition injection (shared with the renderer's cursor layer)
// ---------------------------------------------------------------------------

/**
 * Inject the active IME composition text into a block's characters for layout.
 * Returns plain content when no composition is active in this block.
 *
 * Moved verbatim from renderer.ts so both the text view (paint) and the cursor
 * layer (renderer) resolve composition content identically.
 */
export function getContentWithComposition(
  block: Block,
  state: EditorState,
  blockIndex: number,
): {
  chars: Char[];
  formats: FormatSpan[];
  compositionRange: { start: number; end: number } | null;
} {
  if (!isTextualBlock(block)) {
    return { chars: [], formats: [], compositionRange: null };
  }

  // Check if composition is active and cursor is in this block
  if (
    !state.ui.composition ||
    !state.ui.composition.isComposing ||
    !state.document.cursor ||
    state.document.cursor.position.blockIndex !== blockIndex
  ) {
    return {
      chars: charRunsToChars(block.charRuns),
      formats: block.formats,
      compositionRange: null,
    };
  }

  const compositionText = state.ui.composition.text;
  if (!compositionText) {
    return {
      chars: charRunsToChars(block.charRuns),
      formats: block.formats,
      compositionRange: null,
    };
  }

  const cursorTextIndex = state.document.cursor.position.textIndex;

  // Create temporary composition chars (without IDs since they're not persisted)
  const compositionChars: Char[] = Array.from(compositionText).map(
    (char, i) => ({
      id: `composition-${i}`,
      char,
      deleted: false,
    }),
  );

  // Insert composition chars at cursor position (visible index)
  const modifiedChars: Char[] = [];
  let visibleIndex = 0;
  let insertionDone = false;

  // Convert charRuns to chars and insert composition
  for (const { id, char } of iterateVisibleChars(block.charRuns)) {
    if (visibleIndex === cursorTextIndex && !insertionDone) {
      // Insert composition chars here
      modifiedChars.push(...compositionChars);
      insertionDone = true;
    }

    modifiedChars.push({ id, char, deleted: false });
    visibleIndex++;
  }

  // If cursor is at the end, append composition
  if (!insertionDone) {
    modifiedChars.push(...compositionChars);
  }

  return {
    chars: modifiedChars,
    formats: block.formats, // Keep formats as-is
    compositionRange: {
      start: cursorTextIndex,
      end: cursorTextIndex + compositionText.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Measurement / drawing helpers (moved verbatim from renderer.ts)
// ---------------------------------------------------------------------------

// Measure the width of a portion of CRDT text using batched (ligature-safe)
// measurement so cursor x stays aligned with wrap + render.
function measureLineWidth(
  chars: Char[],
  formats: FormatSpan[],
  lineStartIndex: number,
  lineEndIndex: number,
  textStyle: TextStyle,
  fontFamily: FontFamily,
  codePadding: number,
): number {
  return measureTextUpToIndex(
    chars,
    formats,
    lineStartIndex,
    lineEndIndex,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    codePadding,
  );
}

// Item number for a numbered list item (counts preceding same-indent siblings).
function calculateListItemNumber(
  state: EditorState,
  blockIndex: number,
): number {
  const currentBlock = state.document.page.blocks[blockIndex];
  if (!currentBlock || currentBlock.deleted) return 0;
  if (!isListBlock(currentBlock) || currentBlock.type !== "numbered_list") {
    return 1;
  }

  const currentIndent = currentBlock.indent;
  let number = 1;

  const visibleBlocks = state.view.visibleBlocks;
  const allBlocks = state.document.page.blocks;

  for (let i = visibleBlocks.length - 1; i >= 0; i--) {
    const visibleBlock = visibleBlocks[i];
    const visibleBlockIndex = allBlocks.findIndex(
      (b) => b.id === visibleBlock.id,
    );

    if (visibleBlockIndex >= blockIndex) continue;

    const prevBlock = visibleBlock;

    if (!isListBlock(prevBlock) || prevBlock.type !== "numbered_list") {
      break;
    }

    if ((prevBlock.indent ?? 0) > (currentIndent ?? 0)) {
      continue;
    }

    if ((prevBlock.indent ?? 0) < (currentIndent ?? 0)) {
      break;
    }

    number++;
  }

  return number;
}

// Render a list marker (bullet, number, or checkbox) on the first line.
function renderListMarker(
  ctx: CanvasRenderingContext2D,
  block: Block,
  x: number,
  y: number,
  fontMetrics: FontMetrics,
  textStyle: TextStyle,
  styles: EditorStyles,
  state: EditorState,
  blockIndex: number,
  _markerWidth: number,
) {
  if (!isListBlock(block)) return;

  const fontFamily = getCurrentFontFamily();

  if (block.type === "bullet_list") {
    ctx.save();
    ctx.fillStyle = styles.list.bullet.color;
    ctx.font = `${textStyle.fontWeight} ${styles.list.bullet.size}px ${getFontStack(fontFamily)}`;
    ctx.textBaseline = "alphabetic";

    const bulletX = x + 6;

    ctx.fillText(styles.list.bullet.character, bulletX, y + fontMetrics.ascent);
    ctx.restore();
  } else if (block.type === "numbered_list") {
    const number = calculateListItemNumber(state, blockIndex);
    const numberText = `${number}.`;

    ctx.save();
    ctx.fillStyle = styles.list.numbered.color;
    ctx.font = `${textStyle.fontWeight} ${textStyle.fontSize}px ${getFontStack(fontFamily)}`;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "right";

    ctx.fillText(numberText, x + 18, y + fontMetrics.ascent);

    ctx.textAlign = "left"; // Reset
    ctx.restore();
  } else if (block.type === "todo_list") {
    const checkboxSize = styles.list.todo.checkboxSize;
    const checkboxY = y + fontMetrics.ascent - checkboxSize + 2;

    const checkboxX = x + 2;

    ctx.save();

    ctx.strokeStyle = styles.list.todo.checkboxBorderColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(
      checkboxX,
      checkboxY,
      checkboxSize,
      checkboxSize,
      styles.list.todo.checkboxBorderRadius,
    );
    ctx.stroke();

    if (block.checked) {
      ctx.fillStyle = styles.list.todo.checkboxCheckedColor;
      ctx.fill();

      ctx.strokeStyle = styles.list.todo.checkmarkColor;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      const checkmarkPadding = 3;
      const checkX = checkboxX + checkmarkPadding;
      const checkY = checkboxY + checkmarkPadding;
      const checkWidth = checkboxSize - checkmarkPadding * 2;
      const checkHeight = checkboxSize - checkmarkPadding * 2;

      ctx.beginPath();
      ctx.moveTo(checkX, checkY + checkHeight / 2);
      ctx.lineTo(checkX + checkWidth / 3, checkY + checkHeight - 1);
      ctx.lineTo(checkX + checkWidth, checkY + 1);
      ctx.stroke();
    }

    ctx.restore();
  }
}

function renderPlaceholder(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  styles: EditorStyles,
  textStyle: TextStyle,
  blockType: TextualBlock["type"],
  state: EditorState,
  isRTL: boolean,
  maxWidth: number,
) {
  ctx.save();
  ctx.fillStyle = styles.placeholder.color;
  ctx.font = `${textStyle.fontWeight} ${textStyle.fontSize}px ${getFontStack(
    getCurrentFontFamily(),
  )}`;
  ctx.textBaseline = "alphabetic";
  ctx.direction = isRTL ? "rtl" : "ltr";

  let placeholderText = "";

  if (blockType === "bullet_list") {
    placeholderText = i18next.t("blocks.listItem", "List item");
  } else if (blockType === "numbered_list") {
    placeholderText = i18next.t("blocks.listItem", "List item");
  } else if (blockType === "todo_list") {
    placeholderText = i18next.t("blocks.todoItem", "To-do item");
  } else {
    const placeholderConfig = styles.placeholder[blockType];

    const isTouch = isTouchDevice();
    const hasPhysicalKeyboard = state.view.hasPhysicalKeyboard;
    const isTouchOnly = isTouch && !hasPhysicalKeyboard;

    if (blockType === "paragraph") {
      if (isTouchOnly) {
        placeholderText = styles.placeholder.paragraph.touchCompatiableText;
      } else {
        placeholderText = styles.placeholder.paragraph.keyboardCompatibleText;
      }
    } else if ("text" in placeholderConfig) {
      placeholderText = placeholderConfig.text;
    }
  }

  const textX = isRTL ? x + maxWidth : x;
  ctx.fillText(placeholderText, textX, y);
  ctx.restore();
}

// Underline decoration for composition (IME) text.
function renderCompositionUnderline(
  ctx: CanvasRenderingContext2D,
  chars: Char[],
  formats: FormatSpan[],
  lineStartIndex: number,
  lineEndIndex: number,
  compositionStart: number,
  compositionEnd: number,
  x: number,
  y: number,
  textStyle: TextStyle,
  fontFamily: FontFamily,
  fontMetrics: FontMetrics,
  codePadding: number,
  isRTL: boolean,
  _maxWidth: number,
) {
  const underlineStart = Math.max(lineStartIndex, compositionStart);
  const underlineEnd = Math.min(lineEndIndex, compositionEnd);

  if (underlineStart >= underlineEnd) return;

  const offsetToStart = measureLineWidth(
    chars,
    formats,
    lineStartIndex,
    underlineStart,
    textStyle,
    fontFamily,
    codePadding,
  );

  const underlineWidth = measureLineWidth(
    chars,
    formats,
    underlineStart,
    underlineEnd,
    textStyle,
    fontFamily,
    codePadding,
  );

  const underlineY = y + fontMetrics.ascent + 2;
  const underlineThickness = 1.5;

  ctx.save();
  ctx.strokeStyle = textStyle.color;
  ctx.lineWidth = underlineThickness;
  ctx.beginPath();

  if (isRTL) {
    const startX = x - offsetToStart;
    ctx.moveTo(startX, underlineY);
    ctx.lineTo(startX - underlineWidth, underlineY);
  } else {
    const startX = x + offsetToStart;
    ctx.moveTo(startX, underlineY);
    ctx.lineTo(startX + underlineWidth, underlineY);
  }

  ctx.stroke();
  ctx.restore();
}

// Render a single line with CRDT formatting (batched to preserve ligatures).
function renderLine(
  ctx: CanvasRenderingContext2D,
  chars: Char[],
  formats: FormatSpan[],
  lineStartIndex: number,
  lineEndIndex: number,
  x: number,
  y: number,
  textStyle: TextStyle,
  fontFamily: FontFamily,
  styles: EditorStyles,
  isRTL: boolean,
  requestRedraw: () => void,
  hoveredInlineMath: { startIndex: number; endIndex: number } | null = null,
) {
  ctx.direction = isRTL ? "rtl" : "ltr";

  const batches: TextBatch[] = batchChars(
    chars,
    formats,
    lineStartIndex,
    lineEndIndex,
  );

  let currentX = x;
  let batchVisibleStart = lineStartIndex;

  for (const batch of batches) {
    const effectiveFontWeight = batch.isBold ? "bold" : textStyle.fontWeight;
    const fontStyle = batch.isItalic ? "italic" : "normal";

    ctx.font = `${fontStyle} ${effectiveFontWeight} ${textStyle.fontSize}px ${getFontStack(fontFamily)}`;
    ctx.textBaseline = "alphabetic";

    const batchVisibleEnd = batchVisibleStart + batch.text.length;
    const isBatchHovered =
      batch.isMath &&
      hoveredInlineMath !== null &&
      batchVisibleStart >= hoveredInlineMath.startIndex &&
      batchVisibleEnd <= hoveredInlineMath.endIndex;

    if (batch.isMath) {
      const dpr = window.devicePixelRatio || 1;
      const dims = getInlineMathDims(batch.text, textStyle.fontSize);
      const mathStyle = styles.textFormats.inlineMath;

      if (dims) {
        const mathWidth = dims.width;
        const visualX = currentX;
        const drawX = isRTL ? visualX - mathWidth : visualX;

        if (isBatchHovered) {
          const padding = mathStyle.padding;
          ctx.save();
          ctx.fillStyle = mathStyle.hoverBackgroundColor;
          const rectX = drawX - padding;
          const rectY = y - dims.height + dims.depthBelowBaseline - padding;
          const rectWidth = mathWidth + padding * 2;
          const rectHeight = dims.height + padding * 2;
          ctx.beginPath();
          ctx.roundRect(
            rectX,
            rectY,
            rectWidth,
            rectHeight,
            mathStyle.borderRadius,
          );
          ctx.fill();
          ctx.restore();
        }

        const image = getInlineMathImage(
          batch.text,
          textStyle.fontSize,
          dpr,
          requestRedraw,
        );
        if (image) {
          const imgY = y - dims.height + dims.depthBelowBaseline;
          ctx.drawImage(image.bitmap, drawX, imgY, mathWidth, dims.height);
        }

        if (isRTL) {
          currentX -= mathWidth;
        } else {
          currentX += mathWidth;
        }
        batchVisibleStart = batchVisibleEnd;
        continue;
      }
    }

    const textWidth = ctx.measureText(batch.text).width;
    const visualX = currentX;

    if (batch.isCode || batch.isMath) {
      const chipStyle = batch.isMath
        ? styles.textFormats.inlineMath
        : styles.textFormats.code;
      const padding = chipStyle.padding;

      const drawChip = batch.isCode || isBatchHovered;
      if (drawChip) {
        ctx.save();
        ctx.fillStyle =
          batch.isMath && isBatchHovered
            ? styles.textFormats.inlineMath.hoverBackgroundColor
            : chipStyle.backgroundColor;

        let rectX: number;
        if (isRTL) {
          rectX = visualX - textWidth - padding;
        } else {
          rectX = visualX - padding;
        }

        const rectY = y - textStyle.fontSize - padding;
        const rectWidth = textWidth + padding * 2;
        const rectHeight = textStyle.fontSize * textStyle.lineHeight;

        ctx.beginPath();
        ctx.roundRect(
          rectX,
          rectY,
          rectWidth,
          rectHeight,
          chipStyle.borderRadius,
        );
        ctx.fill();
        ctx.restore();
      }

      ctx.fillStyle = chipStyle.color;
    } else if (batch.isLink) {
      ctx.fillStyle = styles.textFormats.link.color;
    } else {
      ctx.fillStyle = textStyle.color;
    }

    ctx.fillText(batch.text, visualX, y);

    if (batch.isLink) {
      const linkStyle = styles.textFormats.link;
      ctx.save();
      ctx.strokeStyle = linkStyle.color;
      ctx.lineWidth = linkStyle.underlineThickness;
      ctx.beginPath();

      if (isRTL) {
        ctx.moveTo(visualX - textWidth, y + textStyle.fontSize * 0.1);
        ctx.lineTo(visualX, y + textStyle.fontSize * 0.1);
      } else {
        ctx.moveTo(visualX, y + textStyle.fontSize * 0.1);
        ctx.lineTo(visualX + textWidth, y + textStyle.fontSize * 0.1);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (batch.isStrikethrough) {
      ctx.save();
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = Math.max(1, textStyle.fontSize / 16);
      ctx.beginPath();

      if (isRTL) {
        ctx.moveTo(visualX - textWidth, y - textStyle.fontSize * 0.3);
        ctx.lineTo(visualX, y - textStyle.fontSize * 0.3);
      } else {
        ctx.moveTo(visualX, y - textStyle.fontSize * 0.3);
        ctx.lineTo(visualX + textWidth, y - textStyle.fontSize * 0.3);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (isRTL) {
      currentX -= textWidth;
    } else {
      currentX += textWidth;
    }
    batchVisibleStart = batchVisibleEnd;
  }

  ctx.direction = "ltr";
}

// ---------------------------------------------------------------------------
// Selection rectangles (moved verbatim from renderer.renderSelectionCore)
// ---------------------------------------------------------------------------

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Compute the highlight rectangles for a selection within one text block.
 * Ported verbatim from renderSelectionCore — returns rects instead of drawing,
 * so both the painter and the hit-test (isPointWithinSelectionRects) share it.
 */
function computeSelectionRects(
  layout: TextBlockLayout,
  baseX: number,
  blockTopY: number,
  maxWidth: number,
  selection: { anchor: Position; focus: Position; isForward: boolean },
  blockIndex: number,
): Rect[] {
  const start = selection.isForward ? selection.anchor : selection.focus;
  const end = selection.isForward ? selection.focus : selection.anchor;

  const {
    isRTL,
    textStyle,
    fontFamily,
    codePadding,
    lineHeight,
    chars,
    formats,
  } = layout;

  const rects: Rect[] = [];

  if (
    !(
      (start.blockIndex === blockIndex && end.blockIndex === blockIndex) ||
      (start.blockIndex <= blockIndex && end.blockIndex >= blockIndex)
    )
  ) {
    return rects;
  }

  const contentLength = getVisibleTextFromChars(chars).length;

  // Empty block: a small caret-width highlight.
  if (contentLength === 0 && layout.lines.length === 1) {
    const emptyBlockHeight = textStyle.fontSize * textStyle.lineHeight;
    const minSelectionWidth = textStyle.fontSize * 0.5;
    rects.push({
      x: baseX,
      y: blockTopY,
      width: minSelectionWidth,
      height: emptyBlockHeight,
    });
    return rects;
  }

  layout.lines.forEach((line, lineIndex) => {
    const lineY = blockTopY + lineIndex * lineHeight;
    let selectionStartX = baseX;
    let selectionEndX = baseX + line.width;
    let shouldRender = false;

    if (start.blockIndex === blockIndex && end.blockIndex === blockIndex) {
      if (
        start.textIndex <= line.endIndex &&
        end.textIndex >= line.startIndex
      ) {
        shouldRender = true;

        if (isRTL) {
          const selStartTextIndex = Math.max(line.startIndex, start.textIndex);
          const selEndTextIndex = Math.min(line.endIndex, end.textIndex);

          const widthToSelStart = measureLineWidth(
            chars,
            formats,
            line.startIndex,
            selStartTextIndex,
            textStyle,
            fontFamily,
            codePadding,
          );
          const widthToSelEnd = measureLineWidth(
            chars,
            formats,
            line.startIndex,
            selEndTextIndex,
            textStyle,
            fontFamily,
            codePadding,
          );

          selectionEndX = baseX + maxWidth - widthToSelStart;
          selectionStartX = baseX + maxWidth - widthToSelEnd;
        } else {
          if (start.textIndex > line.startIndex) {
            selectionStartX += measureLineWidth(
              chars,
              formats,
              line.startIndex,
              start.textIndex,
              textStyle,
              fontFamily,
              codePadding,
            );
          }
          if (end.textIndex < line.endIndex) {
            const selectedWidth = measureLineWidth(
              chars,
              formats,
              Math.max(line.startIndex, start.textIndex),
              Math.min(line.endIndex, end.textIndex),
              textStyle,
              fontFamily,
              codePadding,
            );
            selectionEndX = selectionStartX + selectedWidth;
          }
        }
      }
    } else if (start.blockIndex < blockIndex && end.blockIndex > blockIndex) {
      shouldRender = true;
      if (isRTL) {
        const lineStartX = baseX + maxWidth - line.width;
        selectionStartX = lineStartX;
        selectionEndX = lineStartX + line.width;
      }
    } else if (start.blockIndex === blockIndex && end.blockIndex > blockIndex) {
      if (start.textIndex <= line.endIndex) {
        shouldRender = true;

        if (isRTL) {
          const selStartTextIndex = Math.max(line.startIndex, start.textIndex);
          const widthToSelStart = measureLineWidth(
            chars,
            formats,
            line.startIndex,
            selStartTextIndex,
            textStyle,
            fontFamily,
            codePadding,
          );

          selectionEndX = baseX + maxWidth - widthToSelStart;
          selectionStartX = baseX + maxWidth - line.width;
        } else {
          if (start.textIndex > line.startIndex) {
            selectionStartX += measureLineWidth(
              chars,
              formats,
              line.startIndex,
              start.textIndex,
              textStyle,
              fontFamily,
              codePadding,
            );
          }
        }
      }
    } else if (start.blockIndex < blockIndex && end.blockIndex === blockIndex) {
      if (end.textIndex >= line.startIndex) {
        shouldRender = true;

        if (isRTL) {
          const selEndTextIndex = Math.min(line.endIndex, end.textIndex);
          const widthToSelEnd = measureLineWidth(
            chars,
            formats,
            line.startIndex,
            selEndTextIndex,
            textStyle,
            fontFamily,
            codePadding,
          );

          selectionEndX = baseX + maxWidth;
          selectionStartX = baseX + maxWidth - widthToSelEnd;
        } else {
          if (end.textIndex < line.endIndex) {
            selectionEndX =
              baseX +
              measureLineWidth(
                chars,
                formats,
                line.startIndex,
                end.textIndex,
                textStyle,
                fontFamily,
                codePadding,
              );
          }
        }
      }
    }

    if (shouldRender) {
      rects.push({
        x: selectionStartX,
        y: lineY,
        width: selectionEndX - selectionStartX,
        height: lineHeight,
      });
    }
  });

  return rects;
}

// ---------------------------------------------------------------------------
// TextBlockView
// ---------------------------------------------------------------------------

export class TextBlockView extends BlockView<TextualBlock> {
  // Representative type; the view is registered under every TEXT_BLOCK_TYPES key.
  readonly type = "paragraph" as const;
  readonly types = TEXT_BLOCK_TYPES;

  /**
   * The canonical text layout. Plain block content (no composition) — that is
   * what the height/caret/hit-test/selection passes use.
   */
  layout(c: BlockLayoutCtx): TextBlockLayout {
    return this.computeLayout(c.block as TextualBlock, c.maxWidth, c.styles);
  }

  /**
   * Shared layout computation. `content` overrides the characters (used by the
   * paint pass to fold in IME composition). RTL is always derived from the
   * persisted runs, matching the previous render/caret/hit-test behavior.
   */
  computeLayout(
    block: TextualBlock,
    maxWidth: number,
    styles: EditorStyles,
    content?: {
      chars: Char[];
      formats: FormatSpan[];
      compositionRange: { start: number; end: number } | null;
    },
  ): TextBlockLayout {
    const textStyle = getTextStyle(styles, block.type);
    const fontFamily = getCurrentFontFamily();
    const codePadding = styles.textFormats.code.padding;

    const isRTL =
      getTextDirection(getVisibleTextFromRuns(block.charRuns)) === "rtl";

    let indentOffset = 0;
    let markerWidth = 0;
    let adjustedMaxWidth = maxWidth;
    if (isListBlock(block)) {
      const indent = block.indent || 0;
      indentOffset = indent * styles.list.indent.size;
      markerWidth = styles.list.numbered.minWidth + styles.list.marker.textGap;
      adjustedMaxWidth = maxWidth - indentOffset - markerWidth;
    }

    const chars = content?.chars ?? charRunsToChars(block.charRuns);
    const formats = content?.formats ?? block.formats;
    const compositionRange = content?.compositionRange ?? null;

    const wrapped = wrapText(
      chars,
      formats,
      adjustedMaxWidth,
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily,
      codePadding,
      compositionRange,
    );

    const fontMetrics = getFontMetrics(
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily,
    );
    const lineHeight = fontMetrics.fontSize * textStyle.lineHeight;
    const textHeight = fontMetrics.ascent + fontMetrics.descent;

    // Build line boxes with the exact startIndex/endIndex accounting (including
    // consumed wrap spaces) used by every downstream pass. x/y are relative.
    // Line boxes carry x/y relative to the block content origin; absolute
    // positioning is added by each consumer (it differs between the scroll-space
    // paint pass and the document-space caret pass), so x stays 0 here.
    const lines: RenderedLine[] = [];
    let textIndex = 0;
    for (let i = 0; i < wrapped.length; i++) {
      const wl = wrapped[i];
      const lineStartIndex = textIndex;
      const lineEndIndex = textIndex + wl.text.length;
      const width = measureLineWidth(
        chars,
        formats,
        lineStartIndex,
        lineEndIndex,
        textStyle,
        fontFamily,
        codePadding,
      );
      lines.push({
        text: wl.text,
        x: 0,
        y: i * lineHeight,
        width,
        height: textHeight,
        startIndex: lineStartIndex,
        endIndex: lineEndIndex,
      });
      textIndex += wl.text.length;
      if (wl.consumedSpace) textIndex += 1;
    }

    const height = wrapped.length * lineHeight + textStyle.paddingBottom;

    return {
      height,
      lines,
      isRTL,
      textStyle,
      fontFamily,
      codePadding,
      fontMetrics,
      lineHeight,
      indentOffset,
      markerWidth,
      adjustedMaxWidth,
      chars,
      formats,
      compositionRange,
      wrapped,
    };
  }

  /** Base text x (left edge of the text area) given the block's left origin. */
  private baseX(layout: TextBlockLayout, originX: number): number {
    if (layout.indentOffset === 0 && layout.markerWidth === 0) return originX;
    return layout.isRTL
      ? originX + layout.indentOffset
      : originX + layout.indentOffset + layout.markerWidth;
  }

  /**
   * Caret screen rectangle for a text index. `originX` is the block's left edge
   * (canvas paddingLeft), `blockTopY` the block's top in the caller's space.
   * Ported verbatim from getCursorDocumentCoords.
   */
  caretRect(
    layout: TextBlockLayout,
    textIndex: number,
    originX: number,
    blockTopY: number,
  ): { x: number; y: number; height: number } {
    const {
      isRTL,
      textStyle,
      fontFamily,
      codePadding,
      lineHeight,
      chars,
      formats,
      adjustedMaxWidth,
    } = layout;
    const baseX = this.baseX(layout, originX);

    let currentY = blockTopY;
    for (const line of layout.lines) {
      if (textIndex >= line.startIndex && textIndex <= line.endIndex) {
        const widthFromStart = measureTextUpToIndex(
          chars,
          formats,
          line.startIndex,
          textIndex,
          textStyle.fontSize,
          textStyle.fontWeight,
          fontFamily,
          codePadding,
        );
        return {
          x: isRTL
            ? baseX + adjustedMaxWidth - widthFromStart
            : baseX + widthFromStart,
          y: currentY,
          height: lineHeight,
        };
      }
      currentY += lineHeight;
    }

    // Empty block or caret at the very end.
    return {
      x: isRTL ? baseX + adjustedMaxWidth : baseX,
      y: currentY,
      height: lineHeight,
    };
  }

  /**
   * Click → caret text index within the block. `x`/`y` are absolute in the
   * caller's coordinate space; `blockTopY` the block's top; `originX` the left
   * edge (canvas paddingLeft). Ported from getPositionWithinBlock + Line.
   */
  positionFromPoint(
    block: TextualBlock,
    layout: TextBlockLayout,
    x: number,
    y: number,
    originX: number,
    blockTopY: number,
  ): number {
    const { lineHeight } = layout;
    const baseX = this.baseX(layout, originX);

    let currentLineY = blockTopY;
    for (const line of layout.lines) {
      const lineBottom = currentLineY + lineHeight;
      if (y >= currentLineY && y < lineBottom) {
        return this.positionWithinLine(block, layout, x, line, baseX);
      }
      currentLineY += lineHeight;
    }

    // Below the last line (padding area): use the last line.
    if (layout.lines.length > 0) {
      const last = layout.lines[layout.lines.length - 1];
      return this.positionWithinLine(block, layout, x, last, baseX);
    }

    return 0;
  }

  // Ported verbatim from getPositionWithinLine (incl. inline-math snapping).
  private positionWithinLine(
    block: TextualBlock,
    layout: TextBlockLayout,
    x: number,
    line: RenderedLine,
    baseX: number,
  ): number {
    const { isRTL, textStyle, fontFamily, chars, formats, adjustedMaxWidth } =
      layout;
    const lineStartIndex = line.startIndex;
    const lineEndIndex = line.endIndex;
    const lineText = line.text;
    const relativeX = x - baseX;

    const positionWidths = measureCRDTPositions(
      chars,
      formats,
      lineStartIndex,
      lineEndIndex,
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily,
    );

    const lineWidth = positionWidths[positionWidths.length - 1];

    if (isRTL) {
      const maxWidth = adjustedMaxWidth;
      const lineVisualStart = maxWidth - lineWidth;
      const lineVisualEnd = maxWidth;

      if (relativeX < lineVisualStart) {
        return lineEndIndex;
      }
      if (relativeX > lineVisualEnd) {
        return lineStartIndex;
      }

      let bestPosition = lineStartIndex;
      let minDistance = Infinity;

      for (let i = 0; i <= lineText.length; i++) {
        const widthFromStart = positionWidths[i];
        const charVisualX = maxWidth - widthFromStart;
        const distance = Math.abs(relativeX - charVisualX);

        if (distance < minDistance) {
          minDistance = distance;
          bestPosition = lineStartIndex + i;
        }
      }

      return bestPosition;
    } else {
      if (relativeX <= 0) {
        return lineStartIndex;
      }

      let bestPosition = lineStartIndex;
      let minDistance = Math.abs(relativeX);

      for (let i = 0; i <= lineText.length; i++) {
        const currentX = positionWidths[i];
        const distance = Math.abs(relativeX - currentX);

        if (distance < minDistance) {
          minDistance = distance;
          bestPosition = lineStartIndex + i;
        }
      }

      // Inline-math chips are atomic: snap out of the middle of a span.
      {
        const visIdxOfId = new Map<string, number>();
        let v = 0;
        for (const { id } of iterateVisibleChars(block.charRuns)) {
          visIdxOfId.set(id, v);
          v++;
        }
        for (const f of block.formats) {
          if (f.format.type !== "math") continue;
          const s = visIdxOfId.get(f.startCharId);
          const e = visIdxOfId.get(f.endCharId);
          if (s === undefined || e === undefined) continue;
          if (bestPosition > s && bestPosition < e + 1) {
            const spanStartLocal = s - lineStartIndex;
            const spanEndLocal = e + 1 - lineStartIndex;
            if (
              spanStartLocal >= 0 &&
              spanEndLocal <= lineText.length &&
              spanStartLocal < positionWidths.length &&
              spanEndLocal < positionWidths.length
            ) {
              const spanStartX = positionWidths[spanStartLocal];
              const spanEndX = positionWidths[spanEndLocal];
              if (relativeX < spanStartX) {
                bestPosition = s;
              } else if (relativeX > spanEndX) {
                bestPosition = e + 1;
              }
            }
            break;
          }
        }
      }

      return bestPosition;
    }
  }

  /**
   * Selection highlight rectangles for this block. `originX` is the block left
   * edge, `blockTopY` the block top in the caller's space.
   */
  selectionRects(
    layout: TextBlockLayout,
    selection: { anchor: Position; focus: Position; isForward: boolean },
    blockIndex: number,
    originX: number,
    blockTopY: number,
  ): Rect[] {
    return computeSelectionRects(
      layout,
      this.baseX(layout, originX),
      blockTopY,
      layout.adjustedMaxWidth,
      selection,
      blockIndex,
    );
  }

  /**
   * Full text render. Ported from renderBlock's text path. Draws markers, lines
   * (with composition underline), search highlights, remote + local selection
   * overlays, and the placeholder. Returns absolute line boxes.
   */
  paint(passedLayout: BlockLayout, c: BlockPaintCtx): RenderedBlock {
    const block = c.block as TextualBlock;
    const { ctx, state, styles, blockIndex, maxWidth } = c;
    const x = c.origin.x;
    const y = c.origin.y;
    const remoteAwareness = c.awareness;

    // Resolve composition content. When no IME composition is active in this
    // block, the registry-provided layout (plain content) is exactly what we
    // need — reuse it to avoid a second wrap. Only re-layout when composition
    // text must be folded in.
    const content = getContentWithComposition(block, state, blockIndex);
    const layout =
      content.compositionRange === null
        ? (passedLayout as TextBlockLayout)
        : this.computeLayout(block, maxWidth, styles, content);
    const {
      isRTL,
      textStyle,
      fontFamily,
      fontMetrics,
      lineHeight,
      codePadding,
      indentOffset,
      markerWidth,
      adjustedMaxWidth,
      chars: renderChars,
      formats: renderFormats,
      compositionRange,
    } = layout;

    // Marker / text-area x positions.
    let adjustedX = x;
    let markerX = x;
    if (isListBlock(block)) {
      if (isRTL) {
        adjustedX = x;
        markerX = x + adjustedMaxWidth;
      } else {
        markerX = x + indentOffset;
        adjustedX = x + indentOffset + markerWidth;
      }
    }

    const renderedLines: RenderedLine[] = [];
    const fullContent = getBlockTextContent(block);

    const activeInlineMathEdit =
      state.ui.activeMenu.type === "inlineMathEdit" &&
      state.ui.activeMenu.blockIndex === blockIndex
        ? {
            startIndex: state.ui.activeMenu.startIndex,
            endIndex: state.ui.activeMenu.endIndex,
          }
        : null;
    const hoveredInlineMath =
      activeInlineMathEdit ??
      (state.ui.inlineMathHover &&
      state.ui.inlineMathHover.blockIndex === blockIndex
        ? {
            startIndex: state.ui.inlineMathHover.startIndex,
            endIndex: state.ui.inlineMathHover.endIndex,
          }
        : null);

    for (let lineIndex = 0; lineIndex < layout.lines.length; lineIndex++) {
      const lyt = layout.lines[lineIndex];
      const lineStartIndex = lyt.startIndex;
      const lineEndIndex = lyt.endIndex;
      const currentY = y + lineIndex * lineHeight;
      const renderX = isRTL ? adjustedX + adjustedMaxWidth : adjustedX;

      if (lineIndex === 0 && isListBlock(block)) {
        renderListMarker(
          ctx,
          block,
          markerX,
          currentY,
          fontMetrics,
          textStyle,
          styles,
          state,
          blockIndex,
          markerWidth,
        );
      }

      renderLine(
        ctx,
        renderChars,
        renderFormats,
        lineStartIndex,
        lineEndIndex,
        renderX,
        currentY + fontMetrics.ascent,
        textStyle,
        fontFamily,
        styles,
        isRTL,
        c.requestRedraw,
        hoveredInlineMath,
      );

      if (compositionRange) {
        const lineContainsComposition =
          lineStartIndex < compositionRange.end &&
          lineEndIndex > compositionRange.start;
        if (lineContainsComposition) {
          renderCompositionUnderline(
            ctx,
            renderChars,
            renderFormats,
            lineStartIndex,
            lineEndIndex,
            compositionRange.start,
            compositionRange.end,
            renderX,
            currentY,
            textStyle,
            fontFamily,
            fontMetrics,
            codePadding,
            isRTL,
            maxWidth,
          );
        }
      }

      renderedLines.push({
        text: lyt.text,
        x: adjustedX,
        y: currentY,
        width: lyt.width,
        height: lyt.height,
        startIndex: lineStartIndex,
        endIndex: lineEndIndex,
      });
    }

    // Search highlights (behind selections).
    const { highlights, activeIndex } = state.ui.search;
    if (highlights.length > 0) {
      const blockHighlights = highlights.filter(
        (h) => h.blockIndex === blockIndex,
      );
      for (const h of blockHighlights) {
        const isActive = highlights.indexOf(h) === activeIndex;
        const rects = this.selectionRects(
          layout,
          {
            anchor: { blockIndex, textIndex: h.startIndex },
            focus: { blockIndex, textIndex: h.endIndex },
            isForward: true,
          },
          blockIndex,
          x,
          y,
        );
        this.fillRects(
          ctx,
          rects,
          isActive ? "#f97316" : "#facc15",
          isActive ? 0.5 : 0.35,
        );
      }
    }

    // Remote selections (behind local selection).
    if (remoteAwareness && remoteAwareness.size > 0) {
      for (const [, awareness] of remoteAwareness) {
        if (!awareness.selection) continue;
        const sel: SelectionState | null = awarenessSelectionToSelection(
          awareness.selection,
          state.document.page,
        );
        if (!sel || sel.isCollapsed) continue;
        const rects = this.selectionRects(layout, sel, blockIndex, x, y);
        this.fillRects(ctx, rects, awareness.user.color, 0.2);
      }
    }

    // Local selection.
    if (state.document.selection && !state.document.selection.isCollapsed) {
      const rects = this.selectionRects(
        layout,
        state.document.selection,
        blockIndex,
        x,
        y,
      );
      this.fillRects(
        ctx,
        rects,
        styles.selection.backgroundColor,
        styles.selection.opacity,
      );
    }

    // Placeholder (when empty + cursor here + not composing/selecting).
    const hasActiveSelection =
      state.document.selection && !state.document.selection.isCollapsed;
    if (
      state.document.cursor &&
      state.document.cursor.position.blockIndex === blockIndex &&
      fullContent.length === 0 &&
      !state.ui.composition &&
      !hasActiveSelection &&
      state.ui.mode === "edit"
    ) {
      renderPlaceholder(
        ctx,
        adjustedX,
        y + fontMetrics.ascent,
        styles,
        textStyle,
        block.type,
        state,
        isRTL,
        adjustedMaxWidth,
      );
    }

    const bounds: BlockBounds = {
      x: adjustedX,
      y,
      width: adjustedMaxWidth,
      height: layout.wrapped.length * lineHeight,
    };

    return { block, bounds, lines: renderedLines };
  }

  private fillRects(
    ctx: CanvasRenderingContext2D,
    rects: Rect[],
    fillStyle: string,
    opacity: number,
  ): void {
    if (rects.length === 0) return;
    ctx.save();
    ctx.fillStyle = fillStyle;
    ctx.globalAlpha = opacity;
    for (const r of rects) {
      ctx.fillRect(r.x, r.y, r.width, r.height);
    }
    ctx.restore();
  }

  /** Map a click to a caret position (BlockView contract; unused for text — the
   * renderer/selection call positionFromPoint directly with the y coordinate). */
  hitTest(): Position {
    return { blockIndex: 0, textIndex: 0 };
  }
}

/** Singleton text view, shared by the renderer and selection geometry. */
export const textBlockView = new TextBlockView();
