import type { Block } from "../deserializer/loadPage";
import {
  getCurrentFontFamily,
  getFontMetrics,
  measureFormattedTextUpToIndex,
  wrapFormattedText,
  type FontFamily,
} from "./fonts";
import { getBlockHeight } from "./renderer";
import { getBlockTextContent } from "./state";
import { getEditorStyles, getTextStyle } from "./styles";
import type {
  EditorState,
  EditorStyles,
  Position,
  TextStyle,
  ViewportState,
} from "./types";

export function getCursorCoordinates(
  position: Position,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles()
): { x: number; y: number; height: number } | null {
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  let currentY = styles.canvas.paddingTop;

  for (let i = 0; i < position.blockIndex; i++) {
    const block = state.document.page.blocks[i];
    const blockHeight = getBlockHeight(block, maxWidth, styles);
    currentY += blockHeight;
  }

  const block = state.document.page.blocks[position.blockIndex];
  if (!block) return null;

  const textStyle = getTextStyle(styles, block.type);
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;
  const fontMetrics = getFontMetrics(
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily
  );
  const lineHeight = fontMetrics.fontSize * textStyle.lineHeight;

  // Use formatted text wrapping
  const lines = wrapFormattedText(
    block.content,
    maxWidth,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    codePadding
  );

  let textIndex = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lineEndIndex = textIndex + line.length;

    if (position.textIndex >= textIndex && position.textIndex <= lineEndIndex) {
      // Calculate X using format-aware measurement
      // Measure from the line start to the cursor position
      const textWidth = measureFormattedTextUpToIndex(
        block.content,
        textIndex,
        position.textIndex,
        textStyle.fontSize,
        textStyle.fontWeight,
        fontFamily,
        codePadding
      );

      return {
        x: styles.canvas.paddingLeft + textWidth,
        y: currentY,
        height: lineHeight,
      };
    }

    textIndex += line.length;
    if (lineIndex < lines.length - 1) {
      textIndex += 1;
    }
    currentY += lineHeight;
  }

  return {
    x: styles.canvas.paddingLeft,
    y: currentY,
    height: lineHeight,
  };
}

export function getCursorYPosition(
  position: Position,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles()
): { top: number; bottom: number } | null {
  const coords = getCursorCoordinates(position, state, viewport, styles);
  if (!coords) return null;
  return {
    top: coords.y,
    bottom: coords.y + coords.height,
  };
}

export function scrollToMakeCursorVisible(
  position: Position,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles()
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
  styles: EditorStyles = getEditorStyles()
): Position | null {
  let currentY = styles.canvas.paddingTop - viewport.scrollY;
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  // Check if click is in the left or right padding areas
  if (
    x < styles.canvas.paddingLeft ||
    x > styles.canvas.paddingLeft + maxWidth
  ) {
    return null;
  }

  // Only consider visible blocks for performance
  const startIndex = visibility.start;
  const endIndex = visibility.end;

  // Iterate through visible blocks to find the target block
  for (let blockIndex = startIndex; blockIndex <= endIndex; blockIndex++) {
    const block = state.document.page.blocks[blockIndex];
    const blockHeight = getBlockHeight(block, maxWidth, styles);

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
  if (y >= currentY && state.document.page.blocks.length > 0) {
    const lastBlockIndex = state.document.page.blocks.length - 1;
    const lastBlock = state.document.page.blocks[lastBlockIndex];
    const content = getBlockTextContent(lastBlock);

    return {
      blockIndex: lastBlockIndex,
      textIndex: content.length,
    };
  }

  // If click is above all blocks, position at start of first block
  if (
    y < styles.canvas.paddingTop - viewport.scrollY &&
    state.document.page.blocks.length > 0
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
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;

  // Get font metrics for line height calculation
  const fontMetrics = getFontMetrics(
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily
  );
  const lineHeight = fontMetrics.fontSize * textStyle.lineHeight;

  // Wrap text to get lines using formatted text wrapping
  const lines = wrapFormattedText(
    block.content,
    maxWidth,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    codePadding
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
        fontFamily,
        block,
        codePadding
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
      fontFamily,
      block,
      codePadding
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
 * Uses character-by-character measurement for precise positioning with format awareness
 */
function getPositionWithinLine(
  x: number,
  line: string,
  lineStartIndex: number,
  paddingLeft: number,
  textStyle: TextStyle,
  fontFamily: FontFamily,
  block: Block,
  codePadding: number
): Position {
  const relativeX = x - paddingLeft;

  // If click is before the line start, position at line start
  if (relativeX <= 0) {
    return {
      blockIndex: 0, // Placeholder - will be overridden by caller
      textIndex: lineStartIndex,
    };
  }

  let bestPosition = lineStartIndex;
  let minDistance = Math.abs(relativeX);

  // Check each character position to find the closest one
  for (let i = 0; i <= line.length; i++) {
    const charIndex = lineStartIndex + i;

    // Measure from line start to this position using format-aware measurement
    const currentX = measureFormattedTextUpToIndex(
      block.content,
      lineStartIndex,
      charIndex,
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily,
      codePadding
    );

    const distance = Math.abs(relativeX - currentX);

    if (distance < minDistance) {
      minDistance = distance;
      bestPosition = charIndex;
    }
  }

  return {
    blockIndex: 0, // Placeholder - will be overridden by caller
    textIndex: bestPosition,
  };
}

/**
 * Get link information at a given position
 * Returns the link data (url, text, start, end) if the position is within a link
 */
export function getLinkAtPosition(
  position: Position,
  state: EditorState
): {
  segmentIndex: number;
  url: string;
  text: string;
  start: number;
  end: number;
} | null {
  const block = state.document.page.blocks[position.blockIndex];
  if (!block) return null;

  let currentIndex = 0;

  for (let i = 0; i < block.content.length; i++) {
    const segment = block.content[i];
    const segmentStart = currentIndex;
    const segmentEnd = currentIndex + segment.content.length;

    // Check if position is within this segment
    if (position.textIndex >= segmentStart && position.textIndex < segmentEnd) {
      // Check if this segment has a link format
      const linkFormat = segment.formats?.find(
        (f: { type: string }) => f.type === "link"
      );
      if (linkFormat) {
        return {
          url: linkFormat.url || "",
          text: segment.content,
          start: segmentStart,
          end: segmentEnd,
          segmentIndex: i,
        };
      }
    }

    currentIndex = segmentEnd;
  }

  return null;
}
