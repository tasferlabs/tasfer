import type { Block } from "../deserializer/loadPage";
import {
  createCharacterKey,
  createEmptyCharacterMap,
  isPositionInViewport,
} from "./characterMap";
import { getBlockTextContent, isCursorBlinking } from "./state";
import { applyTextStyle, defaultStyles, getTextStyle } from "./styles";
import type {
  CharacterMap,
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
): { renderedBlocks: RenderedBlock[]; characterMap: CharacterMap } => {
  // Clear canvas
  ctx.fillStyle = styles.canvas.backgroundColor;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  let currentY = styles.canvas.padding - state.viewport.scrollY;

  const renderingState: RenderingState = {
    currentY,
    renderedBlocks: [],
    characterMap: createEmptyCharacterMap(state.viewport),
  };

  // Render each block
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

  return {
    renderedBlocks: renderingState.renderedBlocks,
    characterMap: renderingState.characterMap,
  };
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
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lineStartIndex = textIndex;
    const lineEndIndex = textIndex + line.length;

    // Check if this line has selection
    // Sort anchor and focus to ensure start is always before end
    let start = state.selection?.isForward
      ? state.selection?.anchor
      : state.selection?.focus;
    let end = state.selection?.isForward
      ? state.selection?.focus
      : state.selection?.anchor;

    // Render the text
    ctx.fillText(line, x, renderingState.currentY);

    // Calculate character positions for mouse selection
    const textMetrics = ctx.measureText(line);
    const lineY = renderingState.currentY - textMetrics.actualBoundingBoxAscent;
    const lineHeight =
      textMetrics.actualBoundingBoxAscent +
      textMetrics.actualBoundingBoxDescent;

    // Calculate character positions only for visible area (with overshoot)
    for (let charIndex = 0; charIndex < line.length; charIndex++) {
      const char = line[charIndex];
      const textBeforeChar = line.substring(0, charIndex);
      const charX = x + ctx.measureText(textBeforeChar).width;
      const charWidth = ctx.measureText(char).width;

      const charPosition = {
        x: charX,
        y: lineY,
        width: charWidth,
        height: lineHeight,
        blockIndex,
        textIndex: lineStartIndex + charIndex,
        lineIndex,
      };

      // Only store character positions within viewport bounds (with overshoot)
      if (
        isPositionInViewport(
          charPosition,
          renderingState.characterMap.viewportBounds
        )
      ) {
        const key = createCharacterKey(blockIndex, lineStartIndex + charIndex);
        renderingState.characterMap.characters.set(key, charPosition);
      }
    }

    // Update block character ranges for quick lookups
    const blockStartKey = createCharacterKey(blockIndex, lineStartIndex);
    const blockEndKey = createCharacterKey(blockIndex, lineEndIndex - 1);
    const existingRange =
      renderingState.characterMap.blockCharacterRanges.get(blockIndex);

    if (!existingRange) {
      renderingState.characterMap.blockCharacterRanges.set(blockIndex, {
        start: blockStartKey,
        end: blockEndKey,
      });
    } else {
      renderingState.characterMap.blockCharacterRanges.set(blockIndex, {
        start: existingRange.start,
        end: blockEndKey,
      });
    }

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

    const hasSelection =
      !!start &&
      !!end &&
      blockIndex >= start.blockIndex &&
      blockIndex <= end.blockIndex;

    if (hasSelection) {
      // Determine selection boundaries for this line
      const isStartBlock = blockIndex === start.blockIndex;
      const isEndBlock = blockIndex === end.blockIndex;
      const isSingleBlock = isStartBlock && isEndBlock;

      let selectionStartIndex: number;
      let selectionEndIndex: number;

      if (isSingleBlock) {
        // Selection is within a single block
        const selectionStart = Math.min(start.textIndex, end.textIndex);
        const selectionEnd = Math.max(start.textIndex, end.textIndex);
        selectionStartIndex = Math.max(selectionStart - lineStartIndex, 0);
        selectionEndIndex = Math.min(
          selectionEnd - lineStartIndex,
          line.length
        );
      } else if (isStartBlock) {
        // This is the start block of a multi-block selection
        selectionStartIndex = Math.max(start.textIndex - lineStartIndex, 0);
        selectionEndIndex = line.length;
      } else if (isEndBlock) {
        // This is the end block of a multi-block selection
        selectionStartIndex = 0;
        selectionEndIndex = Math.min(
          end.textIndex - lineStartIndex,
          line.length
        );
      } else {
        // This is a middle block - select entire line
        selectionStartIndex = 0;
        selectionEndIndex = line.length;
      }

      // Only render selection if there's actually text to select on this line
      if (selectionStartIndex < selectionEndIndex && selectionEndIndex > 0) {
        // Get character positions from character map for selection boundaries
        const startCharKey = createCharacterKey(
          blockIndex,
          lineStartIndex + selectionStartIndex
        );
        const endCharKey = createCharacterKey(
          blockIndex,
          lineStartIndex + Math.max(0, selectionEndIndex - 1)
        );

        const startCharPos =
          renderingState.characterMap.characters.get(startCharKey);
        const endCharPos =
          renderingState.characterMap.characters.get(endCharKey);

        if (startCharPos) {
          let selectionStartX = startCharPos.x;
          let selectionWidth: number;
          let selectionY = startCharPos.y;
          let selectionHeight = startCharPos.height;

          if (endCharPos) {
            // Both positions found in character map
            selectionWidth = endCharPos.x + endCharPos.width - selectionStartX;
          } else {
            // End position not in map, find last available character position on this line
            let lastCharPos: any = null;
            const lineEndTextIndex = lineStartIndex + selectionEndIndex - 1;

            // Look for the last character position we can find on this line
            for (let i = lineEndTextIndex; i >= lineStartIndex; i--) {
              const charKey = createCharacterKey(blockIndex, i);
              const charPos =
                renderingState.characterMap.characters.get(charKey);
              if (charPos) {
                lastCharPos = charPos;
                break;
              }
            }

            if (lastCharPos) {
              selectionWidth =
                lastCharPos.x + lastCharPos.width - selectionStartX;
            } else {
              // Fallback to character width estimation if no characters found
              selectionWidth =
                selectionEndIndex > selectionStartIndex
                  ? (selectionEndIndex - selectionStartIndex) * 10
                  : 0;
            }
          }

          // Save current fill style
          const originalFillStyle = ctx.fillStyle;
          const originalGlobalAlpha = ctx.globalAlpha;

          // Render selection background
          ctx.fillStyle = styles.selection.backgroundColor;
          ctx.globalAlpha = styles.selection.opacity;
          ctx.fillRect(
            selectionStartX,
            selectionY,
            selectionWidth,
            selectionHeight
          );

          // Restore original styles
          ctx.fillStyle = originalFillStyle;
          ctx.globalAlpha = originalGlobalAlpha;
        }
      }
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
  return renderingState;
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
