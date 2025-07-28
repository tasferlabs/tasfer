import type { Block } from "../deserializer/loadPage";
import {
  getCurrentFontFamily,
  getFontMetrics,
  measureText,
  wrapText,
  type FontFamily,
} from "./fonts";
import { getBlockTextContent, isCursorBlinking } from "./state";
import { applyTextStyle, defaultStyles, getTextStyle } from "./styles";
import type {
  BlockBounds,
  EditorState,
  EditorStyles,
  FontMetrics,
  RenderedBlock,
  RenderedLine,
  TextStyle,
  ViewportState,
} from "./types";

// Rendering Functions
export const renderPage = (
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = defaultStyles
) => {
  // Clear canvas
  ctx.fillStyle = styles.canvas.backgroundColor;
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  let currentY = styles.canvas.padding - viewport.scrollY;
  const renderedBlocks: RenderedBlock[] = [];
  const maxWidth = viewport.width - 2 * styles.canvas.padding;
  viewport.visibleBlocksStartIndex = viewport.visibleBlocksEndIndex =
    null as any;

  // Render each block
  for (let i = 0; i < state.page.blocks.length; i++) {
    const block = state.page.blocks[i];
    const blockHeight = calculateBlockHeight(block, maxWidth, styles);

    // Only render if block is visible
    if (isBlockVisible(currentY, blockHeight, viewport)) {
      // console.log(i);
      viewport.visibleBlocksStartIndex ??= i;
      viewport.visibleBlocksEndIndex = i;

      const renderedBlock = renderBlock(
        ctx,
        state,
        block,
        i,
        styles.canvas.padding,
        currentY,
        maxWidth,
        styles
      );
      renderedBlocks.push(renderedBlock);
    }

    currentY += blockHeight;
  }

  // console.log(viewport.visibleBlocksStartIndex, viewport.visibleBlocksEndIndex);
};

export const renderBlock = (
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  block: Block,
  blockIndex: number,
  x: number,
  y: number,
  maxWidth: number,
  styles: EditorStyles = defaultStyles
): RenderedBlock => {
  const textStyle = getTextStyle(styles, block.type);
  const content = getBlockTextContent(block);

  applyTextStyle(ctx, textStyle);

  // Calculate line wrapping using fast text measurement
  const fontFamily = getCurrentFontFamily();
  const lines = wrapText(
    content,
    maxWidth,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily
  );
  const fontMetrics = getFontMetrics(
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily
  );
  const lineHeight = fontMetrics.fontSize * textStyle.lineHeight;

  const renderedLines: RenderedLine[] = [];
  let textIndex = 0;
  let currentY = y;

  // Render each line
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lineStartIndex = textIndex;
    const lineEndIndex = textIndex + line.length;

    // Render the text
    ctx.fillText(line, x, currentY);

    // Use font metrics for consistent positioning
    const textHeight = fontMetrics.ascent + fontMetrics.descent;

    // Store rendered line
    const renderedLine: RenderedLine = {
      text: line,
      x,
      y: currentY,
      width: measureText(
        line,
        textStyle.fontSize,
        textStyle.fontWeight,
        fontFamily
      ),
      height: textHeight,
      startIndex: lineStartIndex,
      endIndex: lineEndIndex,
    };
    renderedLines.push(renderedLine);

    textIndex += line.length;
    currentY += lineHeight;
  }

  // Handle selection rendering
  if (state.selection && !state.selection.isCollapsed) {
    renderSelection(
      state,
      blockIndex,
      ctx,
      styles,
      renderedLines,
      x,
      content,
      textStyle,
      fontFamily
    );
  }

  // Handle cursor rendering
  if (
    state.cursor &&
    state.cursor.position.blockIndex === blockIndex &&
    !isCursorBlinking(state.cursor, styles)
  ) {
    renderCursor(
      x,
      y,
      fontMetrics,
      textStyle,
      renderedLines,
      state,
      content,
      fontFamily,
      ctx,
      styles
    );
  }

  // Create block bounds
  const blockBounds: BlockBounds = {
    x,
    y,
    width: maxWidth,
    height: lines.length * lineHeight,
  };

  return {
    block,
    bounds: blockBounds,
    lines: renderedLines,
  };
}; // Calculate position from mouse coordinates dynamically

function renderCursor(
  x: number,
  y: number,
  fontMetrics: FontMetrics,
  textStyle: TextStyle,
  renderedLines: RenderedLine[],
  state: EditorState,
  content: string,
  fontFamily: FontFamily,
  ctx: CanvasRenderingContext2D,
  styles: EditorStyles
) {
  if (!state.cursor) return;

  let cursorX = x;
  let cursorY = y;
  let cursorHeight = fontMetrics.fontSize * textStyle.lineHeight;

  // console.log(renderedLines);
  for (const line of renderedLines) {
    if (
      state.cursor.position.textIndex >= line.startIndex &&
      state.cursor.position.textIndex <= line.endIndex
    ) {
      cursorY = line.y;
      cursorHeight = line.height;
      cursorX += measureText(
        content.substring(line.startIndex, state.cursor.position.textIndex),
        textStyle.fontSize,
        textStyle.fontWeight,
        fontFamily
      );
    }
  }

  ctx.save();
  ctx.fillStyle = styles.cursor.color;
  ctx.fillRect(cursorX, cursorY, styles.cursor.width, cursorHeight);
  ctx.restore();
}

function renderSelection(
  state: EditorState,
  blockIndex: number,
  ctx: CanvasRenderingContext2D,
  styles: EditorStyles,
  renderedLines: RenderedLine[],
  x: number,
  content: string,
  textStyle: TextStyle,
  fontFamily: FontFamily
) {
  if (!state.selection) return;

  // Sort anchor and focus to ensure start is always before end
  let start = state.selection.isForward
    ? state.selection.anchor
    : state.selection.focus;
  let end = state.selection.isForward
    ? state.selection.focus
    : state.selection.anchor;

  if (
    (start.blockIndex === blockIndex && end.blockIndex === blockIndex) ||
    (start.blockIndex <= blockIndex && end.blockIndex >= blockIndex)
  ) {
    ctx.save();
    ctx.fillStyle = styles.selection.backgroundColor;
    ctx.globalAlpha = styles.selection.opacity;

    for (const line of renderedLines) {
      let selectionStartX = x;
      let selectionEndX = x + line.width;
      let shouldRender = false;

      // Determine selection bounds for this line
      if (start.blockIndex === blockIndex && end.blockIndex === blockIndex) {
        // Selection within same block
        if (
          start.textIndex <= line.endIndex &&
          end.textIndex >= line.startIndex
        ) {
          shouldRender = true;
          if (start.textIndex > line.startIndex) {
            const beforeSelection = content.substring(
              line.startIndex,
              start.textIndex
            );
            selectionStartX += measureText(
              beforeSelection,
              textStyle.fontSize,
              textStyle.fontWeight,
              fontFamily
            );
          }
          if (end.textIndex < line.endIndex) {
            const selectedText = content.substring(
              Math.max(line.startIndex, start.textIndex),
              Math.min(line.endIndex, end.textIndex)
            );
            selectionEndX =
              selectionStartX +
              measureText(
                selectedText,
                textStyle.fontSize,
                textStyle.fontWeight,
                fontFamily
              );
          }
        }
      } else if (start.blockIndex < blockIndex && end.blockIndex > blockIndex) {
        // Entire block is selected
        shouldRender = true;
      } else if (
        start.blockIndex === blockIndex &&
        end.blockIndex > blockIndex
      ) {
        // Selection starts in this block
        if (start.textIndex <= line.endIndex) {
          shouldRender = true;
          if (start.textIndex > line.startIndex) {
            const beforeSelection = content.substring(
              line.startIndex,
              start.textIndex
            );
            selectionStartX += measureText(
              beforeSelection,
              textStyle.fontSize,
              textStyle.fontWeight,
              fontFamily
            );
          }
        }
      } else if (
        start.blockIndex < blockIndex &&
        end.blockIndex === blockIndex
      ) {
        // Selection ends in this block
        if (end.textIndex >= line.startIndex) {
          shouldRender = true;
          if (end.textIndex < line.endIndex) {
            const selectedText = content.substring(
              line.startIndex,
              end.textIndex
            );
            selectionEndX =
              x +
              measureText(
                selectedText,
                textStyle.fontSize,
                textStyle.fontWeight,
                fontFamily
              );
          }
        }
      }

      if (shouldRender) {
        ctx.fillRect(
          selectionStartX,
          line.y,
          selectionEndX - selectionStartX,
          line.height
        );
      }
    }

    ctx.restore();
  }
}

// Calculate block height dynamically based on content and max width
export const calculateBlockHeight = (
  block: Block,
  maxWidth: number,
  styles: EditorStyles
): number => {
  const textStyle = getTextStyle(styles, block.type);
  const content = getBlockTextContent(block);
  const fontFamily = getCurrentFontFamily();

  const lines = wrapText(
    content,
    maxWidth,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily
  );

  const fontMetrics = getFontMetrics(
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily
  );

  return (
    lines.length * fontMetrics.fontSize * textStyle.lineHeight +
    textStyle.paddingBottom
  );
};

// Check if a block is visible in the viewport
const isBlockVisible = (
  blockY: number,
  blockHeight: number,
  viewport: { scrollY: number; height: number }
): boolean => {
  const blockTop = blockY;
  const blockBottom = blockY + blockHeight;
  const viewportTop = viewport.scrollY;
  const viewportBottom = viewport.scrollY + viewport.height;

  // Add some buffer for smooth scrolling
  const buffer = 100;
  return (
    blockBottom >= viewportTop - buffer && blockTop <= viewportBottom + buffer
  );
};
