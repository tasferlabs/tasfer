import type { Block, Char } from "../deserializer/loadPage";
import { isVisualBlock, isListBlock } from "../deserializer/loadPage";
import {
  getCurrentFontFamily,
  getFontMetrics,
  measureCRDTTextUpToIndex,
  wrapCRDTText,
  type FontFamily,
} from "./fonts";
import { getBlockHeight } from "./renderer";
import { getBlockTextContent } from "./state";
import { getEditorStyles, getTextStyle } from "./styles";
import { getVisibleText } from "./crdt-helpers";
import { getTextDirection } from "./rtl";
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
    currentY += getBlockHeight(block, maxWidth, styles, i);
  }

  const block = state.document.page.blocks[position.blockIndex];
  if (!block) return null;

  // Image cover and line blocks don't have cursors - they shouldn't be used with this function
  if (block.type === "image" || block.type === "line") return null;

  if (!isVisualBlock(block)) {
    return null;
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

  // Detect if this is an RTL block
  const isRTL = getTextDirection(getVisibleText(block.chars)) === "rtl";

  // Calculate indent and marker space for list blocks
  let indentOffset = 0;
  let markerWidth = 0;
  let adjustedMaxWidth = maxWidth;
  let baseX = styles.canvas.paddingLeft;

  if (isListBlock(block)) {
    const indent = block.indent || 0;
    indentOffset = indent * styles.list.indent.size;

    // Use consistent marker width for all list types to ensure text alignment
    markerWidth = styles.list.numbered.minWidth + styles.list.marker.textGap;

    adjustedMaxWidth = maxWidth - indentOffset - markerWidth;

    // Adjust baseX based on text direction
    if (isRTL) {
      // RTL: text area starts at left (no marker space on left)
      baseX = styles.canvas.paddingLeft + indentOffset;
    } else {
      // LTR: text area starts after marker
      baseX = styles.canvas.paddingLeft + indentOffset + markerWidth;
    }
  }

  // Use CRDT text wrapping
  const lines = wrapCRDTText(
    block.chars,
    block.formats,
    adjustedMaxWidth,
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
        // - Cursor at logical index 0 (lineStartIndex) appears at the RIGHT (baseX + adjustedMaxWidth)
        // - Cursor at logical index N appears at the LEFT
        // Measure from line start to cursor position
        const widthFromStart = measureCRDTTextUpToIndex(
          block.chars,
          block.formats,
          textIndex,
          position.textIndex,
          textStyle.fontSize,
          textStyle.fontWeight,
          fontFamily,
          codePadding
        );

        return {
          x: baseX + adjustedMaxWidth - widthFromStart,
          y: currentY,
          height: lineHeight,
        };
      } else {
        // LTR: Calculate X using format-aware measurement
        // Measure from the line start to the cursor position
        const textWidth = measureCRDTTextUpToIndex(
          block.chars,
          block.formats,
          textIndex,
          position.textIndex,
          textStyle.fontSize,
          textStyle.fontWeight,
          fontFamily,
          codePadding
        );

        return {
          x: baseX + textWidth,
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
      x: baseX + adjustedMaxWidth,
      y: currentY,
      height: lineHeight,
    };
  }

  return {
    x: baseX,
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

  // Image cover and line blocks don't have cursors
  if (block.type === "image" || block.type === "line") return null;

  if (!isVisualBlock(block)) {
    return null;
  }

  // If not composing, use regular cursor coordinates
  if (!state.ui.composition?.isComposing || !state.ui.composition.text) {
    return getCursorCoordinates(position, state, viewport, styles);
  }

  // When composing, we need to account for the composition text
  // Create modified chars with composition text injected (similar to renderer)
  const compositionText = state.ui.composition.text;
  const cursorTextIndex = position.textIndex;

  // Create temporary composition chars (without IDs since they're not persisted)
  const compositionChars: Char[] = Array.from(compositionText).map(
    (char, i) => ({
      id: `composition-${i}`,
      char,
      deleted: false,
    })
  );

  // Insert composition chars at cursor position (visible index)
  const modifiedChars: Char[] = [];
  let visibleIndex = 0;
  let insertionDone = false;

  for (const char of block.chars) {
    if (char.deleted) {
      modifiedChars.push(char);
      continue;
    }

    if (visibleIndex === cursorTextIndex && !insertionDone) {
      // Insert composition chars here
      modifiedChars.push(...compositionChars);
      insertionDone = true;
    }

    modifiedChars.push(char);
    visibleIndex++;
  }

  // If cursor is at the end, append composition
  if (!insertionDone) {
    modifiedChars.push(...compositionChars);
  }

  // Now calculate coordinates at the END of the composition text
  const targetTextIndex = cursorTextIndex + compositionText.length;

  // Calculate position using modified content
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  let currentY = styles.canvas.paddingTop;

  // Add heights of blocks before this one
  for (let i = 0; i < position.blockIndex; i++) {
    const prevBlock = state.document.page.blocks[i];
    currentY += getBlockHeight(prevBlock, maxWidth, styles, i);
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

  const isRTL = getTextDirection(getVisibleText(modifiedChars)) === "rtl";

  // Calculate indent and marker space for list blocks
  let indentOffset = 0;
  let markerWidth = 0;
  let adjustedMaxWidth = maxWidth;
  let baseX = styles.canvas.paddingLeft;

  if (isListBlock(block)) {
    const indent = block.indent || 0;
    indentOffset = indent * styles.list.indent.size;

    // Use consistent marker width for all list types to ensure text alignment
    markerWidth = styles.list.numbered.minWidth + styles.list.marker.textGap;

    adjustedMaxWidth = maxWidth - indentOffset - markerWidth;

    // Adjust baseX based on text direction
    if (isRTL) {
      // RTL: text area starts at left (no marker space on left)
      baseX = styles.canvas.paddingLeft + indentOffset;
    } else {
      // LTR: text area starts after marker
      baseX = styles.canvas.paddingLeft + indentOffset + markerWidth;
    }
  }

  // Wrap the MODIFIED chars (with composition)
  const compositionRange = {
    start: cursorTextIndex,
    end: cursorTextIndex + compositionText.length,
  };
  const lines = wrapCRDTText(
    modifiedChars,
    block.formats,
    adjustedMaxWidth,
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
        const widthFromStart = measureCRDTTextUpToIndex(
          modifiedChars,
          block.formats,
          textIndex,
          targetTextIndex,
          textStyle.fontSize,
          textStyle.fontWeight,
          fontFamily,
          codePadding
        );
        return {
          x: baseX + adjustedMaxWidth - widthFromStart,
          y: currentY,
          height: lineHeight,
        };
      } else {
        const textWidth = measureCRDTTextUpToIndex(
          modifiedChars,
          block.formats,
          textIndex,
          targetTextIndex,
          textStyle.fontSize,
          textStyle.fontWeight,
          fontFamily,
          codePadding
        );
        return {
          x: baseX + textWidth,
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
      x: baseX + adjustedMaxWidth,
      y: currentY,
      height: lineHeight,
    };
  }

  return {
    x: baseX,
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

/**
 * Find position when clicking in left or right padding area.
 * Returns start or end of line based on text direction:
 * - LTR: left padding → start of line, right padding → end of line
 * - RTL: left padding → end of line, right padding → start of line
 */
function getPositionFromPaddingClick(
  y: number,
  isLeftPadding: boolean,
  state: EditorState,
  maxWidth: number,
  startY: number,
  styles: EditorStyles
): Position | null {
  let currentY = startY;

  for (
    let blockIndex = 0;
    blockIndex < state.document.page.blocks.length;
    blockIndex++
  ) {
    const block = state.document.page.blocks[blockIndex];
    const blockHeight = getBlockHeight(block, maxWidth, styles, blockIndex);

    // Check if click is within this block's Y bounds
    if (y >= currentY && y < currentY + blockHeight) {
      // Image and line blocks - position at start (they don't have text content)
      if (
        block.type === "image" ||
        block.type === "line" ||
        !isVisualBlock(block)
      ) {
        return { blockIndex, textIndex: 0 };
      }

      // Detect text direction
      const isRTL = getTextDirection(getVisibleText(block.chars)) === "rtl";

      // Get text style for line height calculation
      const textStyle = getTextStyle(styles, block.type);
      const fontFamily = getCurrentFontFamily();
      const codePadding = styles.textFormats.code.padding;

      // Calculate adjusted max width for list blocks
      let adjustedMaxWidth = maxWidth;
      if (isListBlock(block)) {
        const indent = block.indent || 0;
        const indentOffset = indent * styles.list.indent.size;
        const markerWidth =
          styles.list.numbered.minWidth + styles.list.marker.textGap;
        adjustedMaxWidth = maxWidth - indentOffset - markerWidth;
      }

      // Wrap text to get lines
      const lines = wrapCRDTText(
        block.chars,
        block.formats,
        adjustedMaxWidth,
        textStyle.fontSize,
        textStyle.fontWeight,
        fontFamily,
        codePadding
      );

      // Calculate line height
      const fontMetrics = getFontMetrics(
        textStyle.fontSize,
        textStyle.fontWeight,
        fontFamily
      );
      const lineHeight = fontMetrics.fontSize * textStyle.lineHeight;

      // Find which line was clicked
      let textIndex = 0;
      let lineY = currentY;

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const wrappedLine = lines[lineIndex];
        const line = wrappedLine.text;
        const lineBottom = lineY + lineHeight;

        if (y >= lineY && y < lineBottom) {
          // Found the line - determine start or end based on direction
          const lineStartIndex = textIndex;
          const lineEndIndex = textIndex + line.length;

          // LTR: left → start, right → end
          // RTL: left → end, right → start
          if (isLeftPadding) {
            return {
              blockIndex,
              textIndex: isRTL ? lineEndIndex : lineStartIndex,
            };
          } else {
            return {
              blockIndex,
              textIndex: isRTL ? lineStartIndex : lineEndIndex,
            };
          }
        }

        textIndex += line.length;
        if (wrappedLine.consumedSpace) {
          textIndex += 1;
        }
        lineY += lineHeight;
      }

      // Click is in block padding - use last line
      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1];
        const lastLineStartIndex =
          textIndex - lastLine.text.length - (lastLine.consumedSpace ? 1 : 0);
        const lastLineEndIndex = lastLineStartIndex + lastLine.text.length;

        if (isLeftPadding) {
          return {
            blockIndex,
            textIndex: isRTL ? lastLineEndIndex : lastLineStartIndex,
          };
        } else {
          return {
            blockIndex,
            textIndex: isRTL ? lastLineStartIndex : lastLineEndIndex,
          };
        }
      }

      return { blockIndex, textIndex: 0 };
    }

    currentY += blockHeight;
  }

  // Click is below all blocks - position at end of last block
  if (state.document.page.blocks.length > 0) {
    const lastBlockIndex = state.document.page.blocks.length - 1;
    const lastBlock = state.document.page.blocks[lastBlockIndex];
    const content = getBlockTextContent(lastBlock);

    return {
      blockIndex: lastBlockIndex,
      textIndex: content.length,
    };
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
  const isInLeftPadding = x < styles.canvas.paddingLeft;
  const isInRightPadding = x > styles.canvas.paddingLeft + maxWidth;
  const isInPadding = isInLeftPadding || isInRightPadding;

  // For padding clicks, find the line and position at start/end based on direction
  if (isInPadding) {
    return getPositionFromPaddingClick(
      y,
      isInLeftPadding,
      state,
      maxWidth,
      currentY,
      styles
    );
  }

  // We need to iterate through blocks from the start to get correct Y positions
  // (same as renderPage does), but we can break early once we pass the visible area
  for (
    let blockIndex = 0;
    blockIndex < state.document.page.blocks.length;
    blockIndex++
  ) {
    const block = state.document.page.blocks[blockIndex];
    const blockHeight = getBlockHeight(block, maxWidth, styles, blockIndex);

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

    // Break early if we've passed the visible area (click can only be in visible area)
    if (currentY > viewport.height) {
      break;
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
  // Image cover and line blocks don't have text content - position at start of block
  // The cursor will actually be in a neighboring text block
  if (block.type === "image" || block.type === "line") {
    return {
      blockIndex,
      textIndex: 0,
    };
  }

  if (!isVisualBlock(block)) {
    return {
      blockIndex,
      textIndex: 0,
    };
  }

  const textStyle = getTextStyle(styles, block.type);
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;

  // Detect if this is an RTL block
  const isRTL = getTextDirection(getVisibleText(block.chars)) === "rtl";

  // Calculate indent and marker space for list blocks
  let indentOffset = 0;
  let markerWidth = 0;
  let adjustedMaxWidth = maxWidth;
  let adjustedPaddingLeft = padding;

  if (isListBlock(block)) {
    const indent = block.indent || 0;
    indentOffset = indent * styles.list.indent.size;

    // Use consistent marker width for all list types to ensure text alignment
    markerWidth = styles.list.numbered.minWidth + styles.list.marker.textGap;

    adjustedMaxWidth = maxWidth - indentOffset - markerWidth;

    // Adjust padding based on text direction
    if (isRTL) {
      // RTL: text area starts at left (no marker space on left)
      adjustedPaddingLeft = padding + indentOffset;
    } else {
      // LTR: text area starts after marker
      adjustedPaddingLeft = padding + indentOffset + markerWidth;
    }
  }

  // Get font metrics for line height calculation
  const fontMetrics = getFontMetrics(
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily
  );
  const lineHeight = fontMetrics.fontSize * textStyle.lineHeight;

  // Wrap text to get lines using CRDT text wrapping
  const lines = wrapCRDTText(
    block.chars,
    block.formats,
    adjustedMaxWidth,
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
        adjustedPaddingLeft,
        textStyle,
        fontFamily,
        block,
        codePadding,
        adjustedMaxWidth,
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
    const lastLineStartIndex =
      textIndex - lastLine.length - (lastWrappedLine.consumedSpace ? 1 : 0);

    const position = getPositionWithinLine(
      x,
      lastLine,
      lastLineStartIndex,
      adjustedPaddingLeft,
      textStyle,
      fontFamily,
      block,
      codePadding,
      adjustedMaxWidth,
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
  if (!isVisualBlock(block)) {
    return {
      blockIndex: 0,
      textIndex: lineStartIndex,
    };
  }

  const relativeX = x - paddingLeft;

  // Calculate line width first
  const lineEndIndex = lineStartIndex + line.length;
  const lineWidth = measureCRDTTextUpToIndex(
    block.chars,
    block.formats,
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
      const widthFromStart = measureCRDTTextUpToIndex(
        block.chars,
        block.formats,
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
      const currentX = measureCRDTTextUpToIndex(
        block.chars,
        block.formats,
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
 * Get selection handle positions for mobile selection dragging.
 * Returns coordinates for both anchor and focus handles.
 * The anchor handle appears at the start of selection, focus at the end.
 */
export function getSelectionHandlePositions(
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles()
): {
  anchor: { x: number; y: number; height: number; isTop: boolean } | null;
  focus: { x: number; y: number; height: number; isTop: boolean } | null;
} | null {
  const selection = state.document.selection;
  if (!selection || selection.isCollapsed) {
    return null;
  }

  // Get coordinates for anchor and focus positions
  const anchorCoords = getCursorCoordinates(
    selection.anchor,
    state,
    viewport,
    styles
  );
  const focusCoords = getCursorCoordinates(
    selection.focus,
    state,
    viewport,
    styles
  );

  if (!anchorCoords || !focusCoords) {
    return null;
  }

  // Determine which is start and which is end based on selection direction
  // isTop: true means the handle circle is above the stem (at top of selection)
  // isTop: false means the handle circle is below the stem (at bottom of selection)
  const isForward = selection.isForward;

  return {
    anchor: {
      x: anchorCoords.x,
      y: anchorCoords.y,
      height: anchorCoords.height,
      // Anchor is at the start of selection
      // If forward, anchor is at top (isTop=true means circle on top)
      // If backward, anchor is at bottom (isTop=false means circle on bottom)
      isTop: isForward,
    },
    focus: {
      x: focusCoords.x,
      y: focusCoords.y,
      height: focusCoords.height,
      // Focus is at the end of selection
      // If forward, focus is at bottom (isTop=false)
      // If backward, focus is at top (isTop=true)
      isTop: !isForward,
    },
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
  url: string;
  text: string;
  startIndex: number;
  endIndex: number;
} | null {
  const block = state.document.page.blocks[position.blockIndex];
  if (!block) return null;

  // Image cover and line blocks don't have text content or links
  if (block.type === "image" || block.type === "line") return null;

  if (!isVisualBlock(block)) return null;

  // Find the char at this position
  let visibleIndex = 0;
  let charIdAtPosition: string | null = null;
  
  for (const char of block.chars) {
    if (char.deleted) continue;
    
    if (visibleIndex === position.textIndex) {
      charIdAtPosition = char.id;
      break;
    }
    visibleIndex++;
  }

  if (!charIdAtPosition) return null;

  // Find if this char is within a link format span
  for (const formatSpan of block.formats) {
    if (formatSpan.format.type !== "link") continue;

    // Check if charIdAtPosition is within this span
    const startIdx = block.chars.findIndex(c => c.id === formatSpan.startCharId);
    const endIdx = block.chars.findIndex(c => c.id === formatSpan.endCharId);
    const charIdx = block.chars.findIndex(c => c.id === charIdAtPosition);

    if (startIdx !== -1 && endIdx !== -1 && charIdx !== -1 && charIdx >= startIdx && charIdx <= endIdx) {
      // Found a link span containing this position
      // Calculate visible start and end indices
      let visStart = 0;
      let visEnd = 0;
      let foundStart = false;
      let foundEnd = false;
      visibleIndex = 0;

      for (let i = 0; i < block.chars.length; i++) {
        if (block.chars[i].deleted) continue;

        if (i === startIdx) {
          visStart = visibleIndex;
          foundStart = true;
        }
        if (i === endIdx) {
          visEnd = visibleIndex;
          foundEnd = true;
          break;
        }
        visibleIndex++;
      }

      if (foundStart && foundEnd) {
        // Get the text of the link
        const linkText = block.chars
          .slice(startIdx, endIdx + 1)
          .filter(c => !c.deleted)
          .map(c => c.char)
          .join("");

        return {
          url: formatSpan.format.url || "",
          text: linkText,
          startIndex: visStart,
          endIndex: visEnd + 1,
        };
      }
    }
  }

  return null;
}

/**
 * Check if pixel coordinates (x, y) fall within the actual visual selection rectangles.
 * This accounts for text wrapping and only returns true if the point is on highlighted text.
 * Used for mobile tap detection to avoid clearing selection when tapping empty space.
 */
export function isPointWithinSelectionRects(
  x: number,
  y: number,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles()
): boolean {
  const selection = state.document.selection;
  if (!selection || selection.isCollapsed) {
    return false;
  }

  // Sort anchor and focus to get start and end
  const start = selection.isForward ? selection.anchor : selection.focus;
  const end = selection.isForward ? selection.focus : selection.anchor;

  // If start equals end, no selection
  if (
    start.blockIndex === end.blockIndex &&
    start.textIndex === end.textIndex
  ) {
    return false;
  }

  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  let currentY = styles.canvas.paddingTop - viewport.scrollY;
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;

  // Iterate through blocks that are part of the selection
  for (
    let blockIndex = 0;
    blockIndex < state.document.page.blocks.length;
    blockIndex++
  ) {
    const block = state.document.page.blocks[blockIndex];
    const blockHeight = getBlockHeight(block, maxWidth, styles, blockIndex);

    // Skip blocks before selection
    if (blockIndex < start.blockIndex) {
      currentY += blockHeight;
      continue;
    }

    // Stop after we pass the selection
    if (blockIndex > end.blockIndex) {
      break;
    }

    // Skip image and line blocks (they don't have text content)
    if (!isVisualBlock(block)) {
      currentY += blockHeight;
      continue;
    }

    const textStyle = getTextStyle(styles, block.type);
    const fontMetrics = getFontMetrics(
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily
    );
    const lineHeight = fontMetrics.fontSize * textStyle.lineHeight;

    // Calculate indent and marker space for list blocks
    let indentOffset = 0;
    let markerWidth = 0;
    let adjustedMaxWidth = maxWidth;
    let baseX = styles.canvas.paddingLeft;

    if (isListBlock(block)) {
      const indent = block.indent || 0;
      indentOffset = indent * styles.list.indent.size;
      markerWidth = styles.list.numbered.minWidth + styles.list.marker.textGap;
      adjustedMaxWidth = maxWidth - indentOffset - markerWidth;

      const isRTL = getTextDirection(getVisibleText(block.chars)) === "rtl";
      if (isRTL) {
        baseX = styles.canvas.paddingLeft + indentOffset;
      } else {
        baseX = styles.canvas.paddingLeft + indentOffset + markerWidth;
      }
    }

    // Get wrapped lines for this block
    const wrappedLines = wrapCRDTText(
      block.chars,
      block.formats,
      adjustedMaxWidth,
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily,
      codePadding
    );

    const isRTL = getTextDirection(getVisibleText(block.chars)) === "rtl";
    let lineY = currentY;
    let textIndex = 0;

    for (const wrappedLine of wrappedLines) {
      const lineText = wrappedLine.text;
      const lineStartIndex = textIndex;
      // Account for consumed space in endIndex calculation
      const lineEndIndex =
        textIndex + lineText.length + (wrappedLine.consumedSpace ? 1 : 0);

      // Measure the line width
      const lineWidth = measureCRDTTextUpToIndex(
        block.chars,
        block.formats,
        lineStartIndex,
        lineStartIndex + lineText.length,
        textStyle.fontSize,
        textStyle.fontWeight,
        fontFamily,
        codePadding
      );

      const lineTop = lineY;
      const lineBottom = lineY + lineHeight;

      // Check if y is within this line's vertical bounds
      if (y >= lineTop && y < lineBottom) {
        // Determine selection bounds for this line
        let selectionStartX = baseX;
        let selectionEndX = baseX + lineWidth;
        let hasSelection = false;

        if (start.blockIndex === blockIndex && end.blockIndex === blockIndex) {
          // Selection within same block
          if (
            start.textIndex <= lineEndIndex &&
            end.textIndex >= lineStartIndex
          ) {
            hasSelection = true;

            const selStartTextIndex = Math.max(lineStartIndex, start.textIndex);
            const selEndTextIndex = Math.min(
              lineStartIndex + lineText.length,
              end.textIndex
            );

            if (isRTL) {
              const widthToSelStart = measureCRDTTextUpToIndex(
                block.chars,
                block.formats,
                lineStartIndex,
                selStartTextIndex,
                textStyle.fontSize,
                textStyle.fontWeight,
                fontFamily,
                codePadding
              );
              const widthToSelEnd = measureCRDTTextUpToIndex(
                block.chars,
                block.formats,
                lineStartIndex,
                selEndTextIndex,
                textStyle.fontSize,
                textStyle.fontWeight,
                fontFamily,
                codePadding
              );
              selectionEndX = baseX + adjustedMaxWidth - widthToSelStart;
              selectionStartX = baseX + adjustedMaxWidth - widthToSelEnd;
            } else {
              if (start.textIndex > lineStartIndex) {
                selectionStartX += measureCRDTTextUpToIndex(
                  block.chars,
                  block.formats,
                  lineStartIndex,
                  start.textIndex,
                  textStyle.fontSize,
                  textStyle.fontWeight,
                  fontFamily,
                  codePadding
                );
              }
              if (end.textIndex < lineStartIndex + lineText.length) {
                const selectedWidth = measureCRDTTextUpToIndex(
                  block.chars,
                  block.formats,
                  Math.max(lineStartIndex, start.textIndex),
                  Math.min(lineStartIndex + lineText.length, end.textIndex),
                  textStyle.fontSize,
                  textStyle.fontWeight,
                  fontFamily,
                  codePadding
                );
                selectionEndX = selectionStartX + selectedWidth;
              }
            }
          }
        } else if (
          start.blockIndex < blockIndex &&
          end.blockIndex > blockIndex
        ) {
          // Entire block is selected
          hasSelection = true;
          if (isRTL) {
            const lineStartX = baseX + adjustedMaxWidth - lineWidth;
            selectionStartX = lineStartX;
            selectionEndX = lineStartX + lineWidth;
          }
        } else if (
          start.blockIndex === blockIndex &&
          end.blockIndex > blockIndex
        ) {
          // Selection starts in this block
          if (start.textIndex <= lineEndIndex) {
            hasSelection = true;
            if (isRTL) {
              const widthToSelStart = measureCRDTTextUpToIndex(
                block.chars,
                block.formats,
                lineStartIndex,
                Math.max(lineStartIndex, start.textIndex),
                textStyle.fontSize,
                textStyle.fontWeight,
                fontFamily,
                codePadding
              );
              selectionEndX = baseX + adjustedMaxWidth - widthToSelStart;
              const lineStartX = baseX + adjustedMaxWidth - lineWidth;
              selectionStartX = lineStartX;
            } else {
              if (start.textIndex > lineStartIndex) {
                selectionStartX += measureCRDTTextUpToIndex(
                  block.chars,
                  block.formats,
                  lineStartIndex,
                  start.textIndex,
                  textStyle.fontSize,
                  textStyle.fontWeight,
                  fontFamily,
                  codePadding
                );
              }
            }
          }
        } else if (
          start.blockIndex < blockIndex &&
          end.blockIndex === blockIndex
        ) {
          // Selection ends in this block
          if (end.textIndex >= lineStartIndex) {
            hasSelection = true;
            if (isRTL) {
              const lineStartX = baseX + adjustedMaxWidth - lineWidth;
              const widthToSelEnd = measureCRDTTextUpToIndex(
                block.chars,
                block.formats,
                lineStartIndex,
                Math.min(lineStartIndex + lineText.length, end.textIndex),
                textStyle.fontSize,
                textStyle.fontWeight,
                fontFamily,
                codePadding
              );
              selectionStartX = baseX + adjustedMaxWidth - widthToSelEnd;
              selectionEndX = lineStartX + lineWidth;
            } else {
              if (end.textIndex < lineStartIndex + lineText.length) {
                selectionEndX =
                  baseX +
                  measureCRDTTextUpToIndex(
                    block.chars,
                    block.formats,
                    lineStartIndex,
                    end.textIndex,
                    textStyle.fontSize,
                    textStyle.fontWeight,
                    fontFamily,
                    codePadding
                  );
              }
            }
          }
        }

        // Check if point is within the selection rectangle
        if (hasSelection && x >= selectionStartX && x <= selectionEndX) {
          return true;
        }
      }

      lineY += lineHeight;
      textIndex = lineEndIndex;
    }

    currentY += blockHeight;
  }

  return false;
}
