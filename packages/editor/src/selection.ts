import type { Block, Char } from "./deserializer/loadPage";
import { isListBlock, isTextualBlock } from "./deserializer/loadPage";
import {
  getCurrentFontFamily,
  getFontMetrics,
  measureCRDTPositions,
  measureTextUpToIndex,
  wrapText,
  type FontFamily,
} from "./fonts";
import { getBlockHeight } from "./renderer";
import { getTextDirection } from "./rtl";
import { getBlockTextContent } from "./state";
import { getEditorStyles, getTextStyle } from "./styles";
import {
  charRunsToChars,
  findCharInRuns,
  iterateVisibleChars,
} from "./sync/char-runs";
import { getVisibleText } from "./sync/crdt-helpers";
import type {
  EditorState,
  EditorStyles,
  Position,
  TextStyle,
  ViewportState,
} from "./types";

/**
 * Get visible text from Char[] array (filters out deleted chars)
 */
function getVisibleTextFromChars(chars: Char[]): string {
  return chars
    .filter((c) => !c.deleted)
    .map((c) => c.char)
    .join("");
}

export function getCursorDocumentCoords(
  position: Position,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles()
): { x: number; y: number; height: number } | null {
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  let currentY = styles.canvas.paddingTop;

  // Iterate through visible blocks up to the target block
  const visibleBlocks = state.view.visibleBlocks;
  const allBlocks = state.document.page.blocks;
  const targetBlock = allBlocks[position.blockIndex];

  if (!targetBlock) return null;

  // Find visible blocks before the target block
  for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
    const block = visibleBlocks[visibleIdx];
    if (block.originalIndex >= position.blockIndex) break;

    currentY += getBlockHeight(block, maxWidth, styles, visibleIdx === 0);
  }

  const block = targetBlock;
  if (!block) return null;

  if (!isTextualBlock(block)) {
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
  const isRTL = getTextDirection(getVisibleText(block.charRuns)) === "rtl";

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
  const lines = wrapText(
    charRunsToChars(block.charRuns),
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
        const widthFromStart = measureTextUpToIndex(
          charRunsToChars(block.charRuns),
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
        const textWidth = measureTextUpToIndex(
          charRunsToChars(block.charRuns),
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
  if (!block || block.deleted) return null;
  if (!block) return null;

  if (!isTextualBlock(block)) {
    return null;
  }

  // If not composing, use regular cursor coordinates
  if (!state.ui.composition?.isComposing || !state.ui.composition.text) {
    return getCursorDocumentCoords(position, state, viewport, styles);
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

  // Convert charRuns to chars for composition insertion
  const blockChars = charRunsToChars(block.charRuns);
  for (const char of blockChars) {
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

  // Add heights of blocks before this one (only visible blocks)
  const visibleBlocks = state.view.visibleBlocks;
  for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
    const block = visibleBlocks[visibleIdx];
    if (block.originalIndex >= position.blockIndex) break;

    currentY += getBlockHeight(block, maxWidth, styles, visibleIdx === 0);
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

  const isRTL =
    getTextDirection(getVisibleTextFromChars(modifiedChars)) === "rtl";

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
  const lines = wrapText(
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
        const widthFromStart = measureTextUpToIndex(
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
        const textWidth = measureTextUpToIndex(
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
  const coords = getCursorDocumentCoords(position, state, viewport, styles);
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

  const visibleBlocks = state.view.visibleBlocks;

  for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
    const block = visibleBlocks[visibleIdx];
    const blockHeight = getBlockHeight(
      block,
      maxWidth,
      styles,
      visibleIdx === 0
    );

    // Check if click is within this block's Y bounds
    if (y >= currentY && y < currentY + blockHeight) {
      if (!isTextualBlock(block)) {
        return { blockIndex: block.originalIndex, textIndex: 0 };
      }

      // Detect text direction
      const isRTL = getTextDirection(getVisibleText(block.charRuns)) === "rtl";

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
      const lines = wrapText(
        charRunsToChars(block.charRuns),
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
              blockIndex: block.originalIndex,
              textIndex: isRTL ? lineEndIndex : lineStartIndex,
            };
          } else {
            return {
              blockIndex: block.originalIndex,
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
            blockIndex: block.originalIndex,
            textIndex: isRTL ? lastLineEndIndex : lastLineStartIndex,
          };
        } else {
          return {
            blockIndex: block.originalIndex,
            textIndex: isRTL ? lastLineStartIndex : lastLineEndIndex,
          };
        }
      }

      return { blockIndex: block.originalIndex, textIndex: 0 };
    }

    currentY += blockHeight;
  }

  // Click is below all blocks - position at end of last visible block
  if (visibleBlocks.length > 0) {
    const lastVisibleBlock = visibleBlocks[visibleBlocks.length - 1];
    const allBlocks = state.document.page.blocks;
    const lastBlockIndex = allBlocks.findIndex(
      (b) => b.id === lastVisibleBlock.id
    );
    if (lastBlockIndex === -1) return null;
    const lastBlock = allBlocks[lastBlockIndex];
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
  const visibleBlocks = state.view.visibleBlocks;
  const allBlocks = state.document.page.blocks;

  for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
    const block = visibleBlocks[visibleIdx];
    const blockHeight = getBlockHeight(
      block,
      maxWidth,
      styles,
      visibleIdx === 0
    );

    // Check if click is within this block's Y bounds
    if (y >= currentY && y < currentY + blockHeight) {
      return getPositionWithinBlock(
        x,
        y,
        block.originalIndex,
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

  // If click is below all blocks, position at end of last visible block
  if (y >= currentY && visibleBlocks.length > 0) {
    const lastVisibleBlock = visibleBlocks[visibleBlocks.length - 1];
    const lastBlock = allBlocks[lastVisibleBlock.originalIndex];
    const content = getBlockTextContent(lastBlock);

    return {
      blockIndex: lastVisibleBlock.originalIndex,
      textIndex: content.length,
    };
  }

  // If click is above all blocks, position at start of first visible block
  if (
    y < styles.canvas.paddingTop - viewport.scrollY &&
    visibleBlocks.length > 0
  ) {
    return {
      blockIndex: visibleBlocks[0].originalIndex,
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
  if (!isTextualBlock(block)) {
    return {
      blockIndex: blockIndex,
      textIndex: 0,
    };
  }

  const textStyle = getTextStyle(styles, block.type);
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;

  // Detect if this is an RTL block
  const isRTL = getTextDirection(getVisibleText(block.charRuns)) === "rtl";

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
  const lines = wrapText(
    charRunsToChars(block.charRuns),
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
        blockIndex: blockIndex,
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
      blockIndex: blockIndex,
      textIndex: position.textIndex,
    };
  }

  // Empty block - position at start
  return {
    blockIndex: blockIndex,
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
  _codePadding: number,
  maxWidth: number,
  isRTL: boolean
): Position {
  if (!isTextualBlock(block)) {
    return {
      blockIndex: 0,
      textIndex: lineStartIndex,
    };
  }

  const relativeX = x - paddingLeft;
  const lineEndIndex = lineStartIndex + line.length;

  // Pre-calculate widths for all positions using batched measurement
  // This is more efficient and preserves Arabic ligatures consistently
  const positionWidths = measureCRDTPositions(
    charRunsToChars(block.charRuns),
    block.formats,
    lineStartIndex,
    lineEndIndex,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily
  );

  const lineWidth = positionWidths[positionWidths.length - 1];

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

    // Find closest position using pre-calculated widths
    // For RTL: logical index 0 is at the RIGHT, logical index N is at the LEFT
    let bestPosition = lineStartIndex;
    let minDistance = Infinity;

    for (let i = 0; i <= line.length; i++) {
      // Use pre-calculated width from positionWidths array
      const widthFromStart = positionWidths[i];

      // For RTL, cursor at charIndex appears at: maxWidth - widthFromStart
      // (further we are from start logically, further LEFT we are visually)
      const charVisualX = maxWidth - widthFromStart;
      const distance = Math.abs(relativeX - charVisualX);

      if (distance < minDistance) {
        minDistance = distance;
        bestPosition = lineStartIndex + i;
      }
    }

    return {
      blockIndex: 0,
      textIndex: bestPosition,
    };
  } else {
    // LTR logic
    // If click is before the line start, position at line start
    if (relativeX <= 0) {
      return {
        blockIndex: 0, // Placeholder - will be overridden by caller
        textIndex: lineStartIndex,
      };
    }

    let bestPosition = lineStartIndex;
    let minDistance = Math.abs(relativeX);

    // Find closest position using pre-calculated widths
    for (let i = 0; i <= line.length; i++) {
      // Use pre-calculated width from positionWidths array
      const currentX = positionWidths[i];

      const distance = Math.abs(relativeX - currentX);

      if (distance < minDistance) {
        minDistance = distance;
        bestPosition = lineStartIndex + i;
      }
    }

    // Inline-math chips occupy multiple visible indices but render as one
    // atomic unit. measureCRDTPositions assigns the chip's full width to
    // positions[startIdx+1] and zero to positions[startIdx+2..endIdx+1], so
    // the closest-position scan can land *inside* the span (especially when
    // the chip is at end-of-line: clicks past it tie at the chip's right edge
    // and the earliest-tying index wins, dropping the cursor mid-LaTeX).
    // Snap to whichever span boundary is closer to relativeX.
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
            spanEndLocal <= line.length &&
            spanStartLocal < positionWidths.length &&
            spanEndLocal < positionWidths.length
          ) {
            const spanStartX = positionWidths[spanStartLocal];
            const spanEndX = positionWidths[spanEndLocal];            // Only snap when the click falls outside the chip's x-range —
            // clicks on the chip itself must stay inside the span so hover
            // and click handlers can detect them via getInlineMathAtPosition.
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
  const anchorCoords = getCursorDocumentCoords(
    selection.anchor,
    state,
    viewport,
    styles
  );
  const focusCoords = getCursorDocumentCoords(
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
  if (!block || block.deleted) return null;
  if (!block) return null;

  if (!isTextualBlock(block)) return null;

  // Find the char at this position
  let visibleIndex = 0;
  let charIdAtPosition: string | null = null;

  for (const { id } of iterateVisibleChars(block.charRuns)) {
    if (visibleIndex === position.textIndex) {
      charIdAtPosition = id;
      break;
    }
    visibleIndex++;
  }

  if (!charIdAtPosition) return null;

  // Find if this char is within a link format span
  for (const formatSpan of block.formats) {
    if (formatSpan.format.type !== "link") continue;

    // Check if charIdAtPosition is within this span using findCharInRuns
    const startChar = findCharInRuns(block.charRuns, formatSpan.startCharId);
    const endChar = findCharInRuns(block.charRuns, formatSpan.endCharId);
    const charAtPos = findCharInRuns(block.charRuns, charIdAtPosition);

    if (!startChar || !endChar || !charAtPos) continue;

    // Check if charAtPos is between startChar and endChar
    // We need to compare positions by iterating through visible chars
    let startVisIndex = -1;
    let endVisIndex = -1;
    let charAtPosVisIndex = -1;
    visibleIndex = 0;

    for (const { id } of iterateVisibleChars(block.charRuns)) {
      if (id === formatSpan.startCharId) {
        startVisIndex = visibleIndex;
      }
      if (id === formatSpan.endCharId) {
        endVisIndex = visibleIndex;
      }
      if (id === charIdAtPosition) {
        charAtPosVisIndex = visibleIndex;
      }
      visibleIndex++;
    }

    if (
      startVisIndex !== -1 &&
      endVisIndex !== -1 &&
      charAtPosVisIndex !== -1 &&
      charAtPosVisIndex >= startVisIndex &&
      charAtPosVisIndex <= endVisIndex
    ) {
      // Get the text of the link
      const linkText: string[] = [];
      visibleIndex = 0;
      for (const { char } of iterateVisibleChars(block.charRuns)) {
        if (visibleIndex >= startVisIndex && visibleIndex <= endVisIndex) {
          linkText.push(char);
        }
        if (visibleIndex > endVisIndex) break;
        visibleIndex++;
      }

      return {
        url: formatSpan.format.url || "",
        text: linkText.join(""),
        startIndex: startVisIndex,
        endIndex: endVisIndex + 1,
      };
    }
  }

  return null;
}

/**
 * Find the inline-math span containing a visible character index within a block.
 * Inline math is stored as a run of LaTeX characters tagged with the "math" format.
 * The span is treated as a single atomic unit by callers — the cursor should snap
 * to either the start (visible index = startIndex) or the end (visible index = endIndex)
 * rather than landing inside the chip.
 *
 * `mode` controls inclusivity at the boundaries:
 * - "inside": treat positions strictly between [startIndex+1, endIndex-1] as inside
 *             (positions at the edges return null — cursor is fine to sit there)
 * - "any":    return the span if the index is anywhere within [startIndex, endIndex]
 */
export function getInlineMathAtPosition(
  blockIndex: number,
  textIndex: number,
  state: EditorState,
  mode: "inside" | "any" = "inside",
  pointer?: { x: number; viewport: ViewportState; styles?: EditorStyles },
): {
  blockId: string;
  startIndex: number;
  endIndex: number;
  latex: string;
} | null {
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return null;
  if (!isTextualBlock(block)) return null;

  // Build a quick id → visible-index lookup for chars in this block
  const visibleIds: string[] = [];
  const visibleChars: string[] = [];
  for (const { id, char } of iterateVisibleChars(block.charRuns)) {
    visibleIds.push(id);
    visibleChars.push(char);
  }

  for (const formatSpan of block.formats) {
    if (formatSpan.format.type !== "math") continue;

    const startIdx = visibleIds.indexOf(formatSpan.startCharId);
    const endIdx = visibleIds.indexOf(formatSpan.endCharId);
    if (startIdx === -1 || endIdx === -1) continue;

    // Visible-index range is [startIdx, endIdx + 1) — caret positions go from
    // startIdx (before first char) to endIdx + 1 (after last char).
    const spanStart = startIdx;
    const spanEnd = endIdx + 1;

    let insideHit =
      mode === "any"
        ? textIndex >= spanStart && textIndex <= spanEnd
        : textIndex > spanStart && textIndex < spanEnd;

    // Boundary disambiguation for single-char spans (and any case where
    // textIndex sits on a span boundary): textIndex alone can't tell "end
    // of preceding text" from "start of chip". When pointer x is provided,
    // verify the click landed within the chip's rendered x-range.
    if (
      !insideHit &&
      mode === "inside" &&
      pointer &&
      (textIndex === spanStart || textIndex === spanEnd)
    ) {
      const startCoords = getCursorDocumentCoords(
        { blockIndex, textIndex: spanStart },
        state,
        pointer.viewport,
        pointer.styles,
      );
      const endCoords = getCursorDocumentCoords(
        { blockIndex, textIndex: spanEnd },
        state,
        pointer.viewport,
        pointer.styles,
      );
      if (
        startCoords &&
        endCoords &&
        startCoords.y === endCoords.y &&
        pointer.x >= startCoords.x &&
        pointer.x <= endCoords.x
      ) {
        insideHit = true;
      }
    }

    if (insideHit) {
      return {
        blockId: block.id,
        startIndex: spanStart,
        endIndex: spanEnd,
        latex: visibleChars.slice(spanStart, spanEnd).join(""),
      };
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

  // Iterate through blocks that are part of the selection (only visible blocks)
  const visibleBlocks = state.view.visibleBlocks;

  for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
    const block = visibleBlocks[visibleIdx];
    const blockHeight = getBlockHeight(
      block,
      maxWidth,
      styles,
      visibleIdx === 0
    );

    // Skip blocks before selection
    if (block.originalIndex < start.blockIndex) {
      currentY += blockHeight;
      continue;
    }

    // Stop after we pass the selection
    if (block.originalIndex > end.blockIndex) {
      break;
    }

    // Skip image and line blocks (they don't have text content)
    if (!isTextualBlock(block)) {
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

      const isRTL = getTextDirection(getVisibleText(block.charRuns)) === "rtl";
      if (isRTL) {
        baseX = styles.canvas.paddingLeft + indentOffset;
      } else {
        baseX = styles.canvas.paddingLeft + indentOffset + markerWidth;
      }
    }

    // Get wrapped lines for this block
    const wrappedLines = wrapText(
      charRunsToChars(block.charRuns),
      block.formats,
      adjustedMaxWidth,
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily,
      codePadding
    );

    const isRTL = getTextDirection(getVisibleText(block.charRuns)) === "rtl";
    let lineY = currentY;
    let textIndex = 0;

    for (const wrappedLine of wrappedLines) {
      const lineText = wrappedLine.text;
      const lineStartIndex = textIndex;
      // Account for consumed space in endIndex calculation
      const lineEndIndex =
        textIndex + lineText.length + (wrappedLine.consumedSpace ? 1 : 0);

      // Measure the line width
      const lineWidth = measureTextUpToIndex(
        charRunsToChars(block.charRuns),
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

        if (start.blockIndex === block.originalIndex && end.blockIndex === block.originalIndex) {
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
              const widthToSelStart = measureTextUpToIndex(
                charRunsToChars(block.charRuns),
                block.formats,
                lineStartIndex,
                selStartTextIndex,
                textStyle.fontSize,
                textStyle.fontWeight,
                fontFamily,
                codePadding
              );
              const widthToSelEnd = measureTextUpToIndex(
                charRunsToChars(block.charRuns),
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
                selectionStartX += measureTextUpToIndex(
                  charRunsToChars(block.charRuns),
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
                const selectedWidth = measureTextUpToIndex(
                  charRunsToChars(block.charRuns),
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
          start.blockIndex < block.originalIndex &&
          end.blockIndex > block.originalIndex
        ) {
          // Entire block is selected
          hasSelection = true;
          if (isRTL) {
            const lineStartX = baseX + adjustedMaxWidth - lineWidth;
            selectionStartX = lineStartX;
            selectionEndX = lineStartX + lineWidth;
          }
        } else if (
          start.blockIndex === block.originalIndex &&
          end.blockIndex > block.originalIndex
        ) {
          // Selection starts in this block
          if (start.textIndex <= lineEndIndex) {
            hasSelection = true;
            if (isRTL) {
              const widthToSelStart = measureTextUpToIndex(
                charRunsToChars(block.charRuns),
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
                selectionStartX += measureTextUpToIndex(
                  charRunsToChars(block.charRuns),
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
          start.blockIndex < block.originalIndex &&
          end.blockIndex === block.originalIndex
        ) {
          // Selection ends in this block
          if (end.textIndex >= lineStartIndex) {
            hasSelection = true;
            if (isRTL) {
              const lineStartX = baseX + adjustedMaxWidth - lineWidth;
              const widthToSelEnd = measureTextUpToIndex(
                charRunsToChars(block.charRuns),
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
                  measureTextUpToIndex(
                    charRunsToChars(block.charRuns),
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
