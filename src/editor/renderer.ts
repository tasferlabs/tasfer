import type { Block } from "../deserializer/loadPage";
import { getBlockTextContent, isCursorBlinking } from "./state";
import { applyTextStyle, defaultStyles, getTextStyle } from "./styles";
import type {
  EditorState,
  EditorStyles,
  RenderedBlock,
  RenderedLine,
  RenderingState,
} from "./types";

// Rendering Functions
export const renderState = (
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  styles: EditorStyles = defaultStyles
): RenderedBlock[] => {
  // Clear canvas
  ctx.fillStyle = styles.canvas.backgroundColor;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  let currentY = styles.canvas.padding - state.viewport.scrollY;

  const renderingState: RenderingState = {
    currentY,
    renderedBlocks: [],
  };

  // Render each block with integrated cursor and selection
  for (let i = 0; i < state.page.blocks.length; i++) {
    const block = state.page.blocks[i];
    renderBlock(
      ctx,
      state,
      renderingState,
      block,
      i,
      styles.canvas.padding,
      currentY,
      state.viewport.width - 2 * styles.canvas.padding,
      styles
    );
  }

  return renderingState.renderedBlocks;
};

export const renderBlock = (
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  renderingState: RenderingState,
  block: Block,
  blockIndex: number,
  x: number,
  y: number,
  maxWidth: number,
  styles: EditorStyles
) => {
  const textStyle = getTextStyle(styles, block.type);
  const content = getBlockTextContent(block);

  applyTextStyle(ctx, textStyle);

  // Calculate line wrapping
  const lines = wrapText(ctx, content, maxWidth);
  const lineHeight = textStyle.fontSize * textStyle.lineHeight;

  const renderedLines: RenderedLine[] = [];
  let textIndex = 0;

  // Render each line
  for (const line of lines) {
    const lineStartIndex = textIndex;
    const lineEndIndex = textIndex + line.length;

    // Check if this line has selection
    const start = state.selection?.anchor;
    const end = state.selection?.focus;

    const hasSelection =
      !!start &&
      !!end &&
      blockIndex >= start.blockIndex &&
      blockIndex <= end.blockIndex;

    if (hasSelection) {
      // Calculate selection bounds for this line
      const selectionStart =
        blockIndex === start.blockIndex
          ? Math.max(0, start.textIndex - lineStartIndex)
          : 0;
      const selectionEnd =
        blockIndex === end.blockIndex
          ? Math.min(line.length, end.textIndex - lineStartIndex)
          : line.length;

      if (selectionStart < selectionEnd) {
        // Render selection background
        const beforeText = line.substring(0, selectionStart);
        const selectedText = line.substring(selectionStart, selectionEnd);

        const beforeWidth = ctx.measureText(beforeText).width;
        const selectedWidth = ctx.measureText(selectedText).width;

        // Save current fill style
        const originalFillStyle = ctx.fillStyle;
        const originalGlobalAlpha = ctx.globalAlpha;

        // Render selection background
        ctx.fillStyle = styles.selection.backgroundColor;
        ctx.globalAlpha = styles.selection.opacity;

        // Get text metrics for proper vertical alignment
        const textMetrics = ctx.measureText(line);
        const selectionY =
          renderingState.currentY - textMetrics.actualBoundingBoxAscent;
        const selectionHeight =
          textMetrics.actualBoundingBoxAscent +
          textMetrics.actualBoundingBoxDescent;

        ctx.fillRect(
          x + beforeWidth,
          selectionY,
          selectedWidth,
          selectionHeight
        );

        // Restore fill style
        ctx.fillStyle = originalFillStyle;
        ctx.globalAlpha = originalGlobalAlpha;
      }
    }

    // Render the text
    ctx.fillText(line, x, renderingState.currentY);

    // Check if cursor should be rendered on this line
    const shouldRenderCursor =
      state.cursor &&
      blockIndex === state.cursor.position.blockIndex &&
      state.cursor.position.textIndex >= lineStartIndex &&
      state.cursor.position.textIndex <= lineEndIndex &&
      !isCursorBlinking(state.cursor, styles);

    if (shouldRenderCursor) {
      // Calculate cursor position within this line
      const cursorPositionInLine =
        state.cursor.position.textIndex - lineStartIndex;
      const textBeforeCursor = line.substring(0, cursorPositionInLine);
      const cursorX = x + ctx.measureText(textBeforeCursor).width;

      // Get text metrics for cursor height
      const textMetrics = ctx.measureText(line);
      const cursorY =
        renderingState.currentY - textMetrics.actualBoundingBoxAscent;
      const cursorHeight =
        textMetrics.actualBoundingBoxAscent +
        textMetrics.actualBoundingBoxDescent;

      // Save current fill style
      const originalFillStyle = ctx.fillStyle;

      // Render cursor
      ctx.fillStyle = styles.cursor.color;
      ctx.fillRect(cursorX, cursorY, styles.cursor.width, cursorHeight);

      // Restore fill style
      ctx.fillStyle = originalFillStyle;
    }

    renderedLines.push({
      text: line,
      x,
      y: renderingState.currentY,
      width: ctx.measureText(line).width,
      height: lineHeight,
      startIndex: lineStartIndex,
      endIndex: lineEndIndex,
    });

    textIndex += line.length;
    renderingState.currentY += lineHeight;
  }

  const totalHeight = renderedLines.length * lineHeight;
  renderingState.currentY += textStyle.marginBottom;
  renderingState.renderedBlocks.push({
    block,
    bounds: {
      x,
      y,
      width: maxWidth,
      height: totalHeight,
    },
    lines: renderedLines,
  });
};

export const wrapText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] => {
  if (!text) return [""];

  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);

    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [""];
};
