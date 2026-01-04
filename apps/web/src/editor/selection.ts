import type { Block, Text } from "../deserializer/loadPage";
import { isTextBlock } from "../deserializer/loadPage";
import {
  getCurrentFontFamily,
  getFontMetrics,
  measureFormattedTextUpToIndex,
  wrapFormattedTextDetailed,
  type FontFamily,
} from "./fonts";
import { getBlockHeight } from "./renderer";
import { getBlockTextContent } from "./state";
import { getEditorStyles, getTextStyle } from "./styles";
import { getFormattedTextDirection } from "./rtl";
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

  // Image cover blocks don't have cursors - they shouldn't be used with this function
  if (block.type === "imageCover") return null;

  const textStyle = getTextStyle(styles, block.type);
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;
  if (!isTextBlock(block)) {
    return null;
  }

  const fontMetrics = getFontMetrics(
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily
  );
  const lineHeight = fontMetrics.fontSize * textStyle.lineHeight;

  // Detect if this is an RTL block
  const isRTL = getFormattedTextDirection(block.content) === "rtl";

  // Use formatted text wrapping
  const lines = wrapFormattedTextDetailed(
    block.content,
    maxWidth,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    codePadding
  );

  let textIndex = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const wrappedLine = lines[lineIndex];
    const line = wrappedLine.text;
    const lineEndIndex = textIndex + line.length;

    if (position.textIndex >= textIndex && position.textIndex <= lineEndIndex) {
      if (isRTL) {
        // For RTL text rendered with canvas direction="rtl":
        // - Cursor at logical index 0 (lineStartIndex) appears at the RIGHT (maxWidth)
        // - Cursor at logical index N appears at the LEFT
        // Measure from line start to cursor position
        const widthFromStart = measureFormattedTextUpToIndex(
          block.content,
          textIndex,
          position.textIndex,
          textStyle.fontSize,
          textStyle.fontWeight,
          fontFamily,
          codePadding
        );
        
        return {
          x: styles.canvas.paddingLeft + maxWidth - widthFromStart,
          y: currentY,
          height: lineHeight,
        };
      } else {
        // LTR: Calculate X using format-aware measurement
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
    }

    textIndex += line.length;
    if (wrappedLine.consumedSpace) {
      textIndex += 1;
    }
    currentY += lineHeight;
  }

  // For empty blocks or cursor at the very end
  if (isRTL) {
    return {
      x: styles.canvas.paddingLeft + maxWidth,
      y: currentY,
      height: lineHeight,
    };
  }

  return {
    x: styles.canvas.paddingLeft,
    y: currentY,
    height: lineHeight,
  };
}

/**
 * Get cursor coordinates accounting for composition text
 * When composing, this returns the position at the END of the composition text
 * which may be on a different line if the text wrapped
 */
export function getCursorCoordinatesWithComposition(
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles()
): { x: number; y: number; height: number } | null {
  if (!state.document.cursor) return null;

  const position = state.document.cursor.position;
  const block = state.document.page.blocks[position.blockIndex];
  if (!block) return null;

  // Image cover blocks don't have cursors
  if (block.type === "imageCover") return null;

  if (!isTextBlock(block)) {
    return null;
  }

  // If not composing, use regular cursor coordinates
  if (!state.ui.composition?.isComposing || !state.ui.composition.text) {
    return getCursorCoordinates(position, state, viewport, styles);
  }

  // When composing, we need to account for the composition text
  // Create modified content with composition text injected (similar to renderer)
  const compositionText = state.ui.composition.text;
  const cursorTextIndex = position.textIndex;
  let modifiedContent: Text[] = [];

  // Handle empty block or cursor at start
  if (block.content.length === 0 || cursorTextIndex === 0) {
    modifiedContent = [{ content: compositionText, formats: [] }, ...block.content];
  } else {
    // Inject composition at cursor position
    let currentIndex = 0;
    let compositionInserted = false;

    for (let i = 0; i < block.content.length; i++) {
      const segment = block.content[i];
      const segmentStart = currentIndex;
      const segmentEnd = currentIndex + segment.content.length;

      if (cursorTextIndex >= segmentStart && cursorTextIndex <= segmentEnd) {
        const offsetInSegment = cursorTextIndex - segmentStart;
        const beforeCursor = segment.content.substring(0, offsetInSegment);
        const afterCursor = segment.content.substring(offsetInSegment);

        if (beforeCursor) {
          modifiedContent.push({ ...segment, content: beforeCursor });
        }
        modifiedContent.push({ content: compositionText, formats: segment.formats || [] });
        compositionInserted = true;
        if (afterCursor) {
          modifiedContent.push({ ...segment, content: afterCursor });
        }
      } else {
        modifiedContent.push(segment);
      }

      currentIndex = segmentEnd;
    }

    if (!compositionInserted) {
      const lastSegment = block.content[block.content.length - 1];
      modifiedContent.push({
        content: compositionText,
        formats: lastSegment?.formats || [],
      });
    }
  }

  // Now calculate coordinates at the END of the composition text
  const targetTextIndex = cursorTextIndex + compositionText.length;

  // Calculate position using modified content
  const maxWidth = viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  let currentY = styles.canvas.paddingTop;

  // Add heights of blocks before this one
  for (let i = 0; i < position.blockIndex; i++) {
    const prevBlock = state.document.page.blocks[i];
    const blockHeight = getBlockHeight(prevBlock, maxWidth, styles);
    currentY += blockHeight;
  }

  const textStyle = getTextStyle(styles, block.type);
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;
  const fontMetrics = getFontMetrics(
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily
  );
  const lineHeight = fontMetrics.fontSize * textStyle.lineHeight;

  const isRTL = getFormattedTextDirection(modifiedContent) === "rtl";

  // Wrap the MODIFIED content (with composition)
  const compositionRange = {
    start: cursorTextIndex,
    end: cursorTextIndex + compositionText.length
  };
  const lines = wrapFormattedTextDetailed(
    modifiedContent,
    maxWidth,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    codePadding,
    compositionRange
  );

  let textIndex = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const wrappedLine = lines[lineIndex];
    const line = wrappedLine.text;
    const lineEndIndex = textIndex + line.length;

    if (targetTextIndex >= textIndex && targetTextIndex <= lineEndIndex) {
      if (isRTL) {
        const widthFromStart = measureFormattedTextUpToIndex(
          modifiedContent,
          textIndex,
          targetTextIndex,
          textStyle.fontSize,
          textStyle.fontWeight,
          fontFamily,
          codePadding
        );
        return {
          x: styles.canvas.paddingLeft + maxWidth - widthFromStart,
          y: currentY,
          height: lineHeight,
        };
      } else {
        const textWidth = measureFormattedTextUpToIndex(
          modifiedContent,
          textIndex,
          targetTextIndex,
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
    }

    textIndex += line.length;
    if (wrappedLine.consumedSpace) {
      textIndex += 1;
    }
    currentY += lineHeight;
  }

  // Fallback to end position
  if (isRTL) {
    return {
      x: styles.canvas.paddingLeft + maxWidth,
      y: currentY,
      height: lineHeight,
    };
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
  _visibility: { start: number; end: number },
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

  // We need to iterate through ALL blocks from the start to get correct Y positions
  // (same as renderPage does), but we can optimize by only checking clicks within visible range
  for (let blockIndex = 0; blockIndex < state.document.page.blocks.length; blockIndex++) {
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
  // Image cover blocks don't have text content - position at start of block
  // The cursor will actually be in a neighboring text block
  if (block.type === "imageCover") {
    return {
      blockIndex,
      textIndex: 0,
    };
  }

  if (!isTextBlock(block)) {
    return {
      blockIndex,
      textIndex: 0,
    };
  }

  const textStyle = getTextStyle(styles, block.type);
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;

  // Detect if this is an RTL block
  const isRTL = getFormattedTextDirection(block.content) === "rtl";

  // Get font metrics for line height calculation
  const fontMetrics = getFontMetrics(
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily
  );
  const lineHeight = fontMetrics.fontSize * textStyle.lineHeight;

  // Wrap text to get lines using formatted text wrapping
  const lines = wrapFormattedTextDetailed(
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
    const wrappedLine = lines[lineIndex];
    const line = wrappedLine.text;
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
        codePadding,
        maxWidth,
        isRTL
      );
      return {
        blockIndex,
        textIndex: position.textIndex,
      };
    }

    textIndex += line.length;
    // Account for the space character consumed during text wrapping
    if (wrappedLine.consumedSpace) {
      textIndex += 1;
    }
    currentLineY += lineHeight;
  }

  // Click is in padding bottom area - find closest position on last line
  if (lines.length > 0) {
    const lastWrappedLine = lines[lines.length - 1];
    const lastLine = lastWrappedLine.text;
    const lastLineStartIndex = textIndex - lastLine.length - (lastWrappedLine.consumedSpace ? 1 : 0);

    const position = getPositionWithinLine(
      x,
      lastLine,
      lastLineStartIndex,
      padding,
      textStyle,
      fontFamily,
      block,
      codePadding,
      maxWidth,
      isRTL
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
  codePadding: number,
  maxWidth: number,
  isRTL: boolean
): Position {
  if (!isTextBlock(block)) {
    return {
      blockIndex: 0,
      textIndex: lineStartIndex,
    };
  }

  const relativeX = x - paddingLeft;

  // Calculate line width first
  const lineEndIndex = lineStartIndex + line.length;
  const lineWidth = measureFormattedTextUpToIndex(
    block.content,
    lineStartIndex,
    lineEndIndex,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    codePadding
  );

  if (isRTL) {
    // For RTL text rendered with canvas direction="rtl":
    // - Browser renders from right edge (maxWidth) going leftward
    // - First character (index 0) appears at the RIGHT
    // - Last character appears at the LEFT
    // - Line occupies space from (maxWidth - lineWidth) to maxWidth
    
    const lineVisualStart = maxWidth - lineWidth; // Left edge of RTL text visually
    const lineVisualEnd = maxWidth; // Right edge of RTL text visually
    
    // If click is to the left of the text (before visual start), position at end of text (last character logically)
    if (relativeX < lineVisualStart) {
      return {
        blockIndex: 0, // Placeholder - will be overridden by caller
        textIndex: lineEndIndex,
      };
    }

    // If click is to the right of the text (after visual end), position at start of text (first character logically)
    if (relativeX > lineVisualEnd) {
      return {
        blockIndex: 0,
        textIndex: lineStartIndex,
      };
    }

    // Find closest position by checking each character
    // For RTL: logical index 0 is at the RIGHT, logical index N is at the LEFT
    let bestPosition = lineStartIndex;
    let minDistance = Infinity;

    for (let i = 0; i <= line.length; i++) {
      const charIndex = lineStartIndex + i;
      
      // Measure text width from line start to this position
      const widthFromStart = measureFormattedTextUpToIndex(
        block.content,
        lineStartIndex,
        charIndex,
        textStyle.fontSize,
        textStyle.fontWeight,
        fontFamily,
        codePadding
      );

      // For RTL, cursor at charIndex appears at: maxWidth - widthFromStart
      // (further we are from start logically, further LEFT we are visually)
      const charVisualX = maxWidth - widthFromStart;
      const distance = Math.abs(relativeX - charVisualX);

      if (distance < minDistance) {
        minDistance = distance;
        bestPosition = charIndex;
      }
    }

    return {
      blockIndex: 0,
      textIndex: bestPosition,
    };
  } else {
    // LTR logic (existing)
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

  // Image cover blocks don't have text content or links
  if (block.type === "imageCover") return null;

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
