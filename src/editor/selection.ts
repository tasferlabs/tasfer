import type { Block } from "../deserializer/loadPage";
import {
  getCurrentFontFamily,
  getFontMetrics,
  measureChar,
  wrapText,
  type FontFamily,
} from "./fonts";
import { calculateBlockHeight } from "./renderer";
import { getBlockTextContent } from "./state";
import { defaultStyles, getTextStyle } from "./styles";
import type {
  EditorState,
  EditorStyles,
  Position,
  TextStyle,
  ViewportState,
} from "./types";

export function getCursorYPosition(
  position: Position,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = defaultStyles
): { top: number; bottom: number } | null {
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  
  let currentY = styles.canvas.paddingTop;
  
  for (let i = 0; i < position.blockIndex; i++) {
    const block = state.page.blocks[i];
    currentY += calculateBlockHeight(block, maxWidth, styles);
  }
  
  const block = state.page.blocks[position.blockIndex];
  if (!block) return null;
  
  const textStyle = getTextStyle(styles, block.type);
  const content = getBlockTextContent(block);
  const fontFamily = getCurrentFontFamily();
  const fontMetrics = getFontMetrics(
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily
  );
  const lineHeight = fontMetrics.fontSize * textStyle.lineHeight;
  
  const lines = wrapText(
    content,
    maxWidth,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily
  );
  
  let textIndex = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lineEndIndex = textIndex + line.length;
    
    if (position.textIndex >= textIndex && position.textIndex <= lineEndIndex) {
      return {
        top: currentY,
        bottom: currentY + lineHeight,
      };
    }
    
    textIndex += line.length;
    if (lineIndex < lines.length - 1) {
      textIndex += 1;
    }
    currentY += lineHeight;
  }
  
  if (lines.length > 0) {
    return {
      top: currentY - lineHeight,
      bottom: currentY,
    };
  }
  
  return {
    top: currentY,
    bottom: currentY + lineHeight,
  };
}

export function scrollToMakeCursorVisible(
  position: Position,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = defaultStyles
): number | null {
  const cursorPos = getCursorYPosition(position, state, viewport, styles);
  if (!cursorPos) return null;
  
  const margin = 40;
  const viewportTop = viewport.scrollY;
  const viewportBottom = viewport.scrollY + viewport.height;
  
  if (cursorPos.top < viewportTop + margin) {
    return Math.max(0, cursorPos.top - margin);
  }
  
  if (cursorPos.bottom > viewportBottom - margin) {
    return cursorPos.bottom - viewport.height + margin;
  }
  
  return null;
}

export function getTextPositionFromViewport(
  x: number,
  y: number,
  state: EditorState,
  viewport: ViewportState,
  visibility: { start: number; end: number },
  styles: EditorStyles = defaultStyles
): Position | null {
  let currentY = styles.canvas.paddingTop - viewport.scrollY;
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  // Only consider visible blocks for performance
  const startIndex = visibility.start;
  const endIndex = visibility.end;

  // Iterate through visible blocks to find the target block
  for (let blockIndex = startIndex; blockIndex <= endIndex; blockIndex++) {
    const block = state.page.blocks[blockIndex];
    const blockHeight = calculateBlockHeight(block, maxWidth, styles);

    // Check if click is within this block's Y bounds
    if (y >= currentY && y < currentY + blockHeight) {
      return getPositionWithinBlock(
        x,
        y,
        blockIndex,
        block,
        currentY,
        styles.canvas.paddingLeft,
        maxWidth,
        styles
      );
    }

    currentY += blockHeight;
  }

  // If click is below all blocks, position at end of last block
  if (y >= currentY && state.page.blocks.length > 0) {
    const lastBlockIndex = state.page.blocks.length - 1;
    const lastBlock = state.page.blocks[lastBlockIndex];
    const content = getBlockTextContent(lastBlock);

    return {
      blockIndex: lastBlockIndex,
      textIndex: content.length,
    };
  }

  // If click is above all blocks, position at start of first block
  if (
    y < styles.canvas.paddingTop - viewport.scrollY &&
    state.page.blocks.length > 0
  ) {
    return {
      blockIndex: 0,
      textIndex: 0,
    };
  }

  return null;
}
/**
 * Find the exact position within a block based on click coordinates
 * Follows browser standard behavior for text cursor positioning
 */
function getPositionWithinBlock(
  x: number,
  y: number,
  blockIndex: number,
  block: Block,
  blockY: number,
  padding: number,
  maxWidth: number,
  styles: EditorStyles
): Position {
  const textStyle = getTextStyle(styles, block.type);
  const content = getBlockTextContent(block);
  const fontFamily = getCurrentFontFamily();

  // Get font metrics for line height calculation
  const fontMetrics = getFontMetrics(
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily
  );
  const lineHeight = fontMetrics.fontSize * textStyle.lineHeight;

  // Wrap text to get lines
  const lines = wrapText(
    content,
    maxWidth,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily
  );

  let textIndex = 0;
  let currentLineY = blockY;

  // Find the target line based on Y coordinate
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lineBottom = currentLineY + lineHeight;

    // Check if click is within this line's Y bounds
    if (y >= currentLineY && y < lineBottom) {
      const position = getPositionWithinLine(
        x,
        line,
        textIndex,
        padding,
        textStyle,
        fontFamily
      );
      return {
        blockIndex,
        textIndex: position.textIndex,
      };
    }

    textIndex += line.length;
    // Account for the space character consumed during text wrapping (if not last line)
    if (lineIndex < lines.length - 1) {
      textIndex += 1;
    }
    currentLineY += lineHeight;
  }

  // Click is in padding bottom area - find closest position on last line
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    const lastLineStartIndex = textIndex - lastLine.length;

    const position = getPositionWithinLine(
      x,
      lastLine,
      lastLineStartIndex,
      padding,
      textStyle,
      fontFamily
    );
    return {
      blockIndex,
      textIndex: position.textIndex,
    };
  }

  // Empty block - position at start
  return {
    blockIndex,
    textIndex: 0,
  };
}
/**
 * Find the exact character position within a line based on X coordinate
 * Uses character-by-character measurement for precise positioning
 */
function getPositionWithinLine(
  x: number,
  line: string,
  lineStartIndex: number,
  paddingLeft: number,
  textStyle: TextStyle,
  fontFamily: FontFamily
): Position {
  const relativeX = x - paddingLeft;

  // If click is before the line start, position at line start
  if (relativeX <= 0) {
    return {
      blockIndex: 0, // Placeholder - will be overridden by caller
      textIndex: lineStartIndex,
    };
  }

  let currentX = 0;
  let bestPosition = lineStartIndex;
  let minDistance = Math.abs(relativeX - currentX);

  // Check each character position to find the closest one
  for (let i = 0; i <= line.length; i++) {
    const distance = Math.abs(relativeX - currentX);

    if (distance < minDistance) {
      minDistance = distance;
      bestPosition = lineStartIndex + i;
    }

    // Move to next character position
    if (i < line.length) {
      const charWidth = measureChar(
        line[i],
        textStyle.fontSize,
        textStyle.fontWeight,
        fontFamily
      );
      currentX += charWidth;
    }
  }

  return {
    blockIndex: 0, // Placeholder - will be overridden by caller
    textIndex: bestPosition,
  };
}
