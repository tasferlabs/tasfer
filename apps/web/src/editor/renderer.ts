import type { Block, Text } from "../deserializer/loadPage";
import {
  FONT_STACKS,
  getCurrentFontFamily,
  getFontMetrics,
  measureText,
  wrapFormattedText,
  type FontFamily,
} from "./fonts";
import { renderScrollbar } from "./scrollbar";
import { getBlockTextContent, isCursorBlinking } from "./state";
import { defaultStyles, getTextStyle } from "./styles";
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

// Helper to get or calculate block height, storing it on the block
export const getBlockHeight = (
  block: Block,
  maxWidth: number,
  styles: EditorStyles
): number => {
  // Check if cached height is valid for current width
  if (block.cachedHeight !== undefined && block.cachedWidth === maxWidth) {
    return block.cachedHeight;
  }

  // Calculate and cache the height
  const height = calculateBlockHeight(block, maxWidth, styles);
  block.cachedHeight = height;
  block.cachedWidth = maxWidth;
  return height;
};

// Invalidate cache for specific block (when content changes)
export const invalidateBlockCache = (block: Block) => {
  block.cachedHeight = undefined;
  block.cachedWidth = undefined;
};

// Clear all block caches in a page (for window resize)
export const clearAllBlockCaches = (blocks: Block[]) => {
  blocks.forEach((block) => invalidateBlockCache(block));
};

// Rendering Functions
// Helper function to measure the width of a portion of formatted text
// This matches how renderFormattedLine advances currentX after each segment
function measureFormattedLineWidth(
  segments: Text[],
  lineStartIndex: number,
  lineEndIndex: number,
  textStyle: TextStyle,
  fontFamily: FontFamily,
  codePadding: number
): number {
  let width = 0;
  let currentIndex = 0;

  for (const segment of segments) {
    const segmentStart = currentIndex;
    const segmentEnd = currentIndex + segment.content.length;

    if (segmentEnd <= lineStartIndex) {
      // This entire segment is before our measurement range
      currentIndex = segmentEnd;
      continue;
    }

    if (segmentStart >= lineEndIndex) {
      // We've passed our endpoint
      break;
    }

    // This segment overlaps with our range
    const overlapStart = Math.max(segmentStart, lineStartIndex);
    const overlapEnd = Math.min(segmentEnd, lineEndIndex);
    const textToMeasure = segment.content.substring(
      overlapStart - segmentStart,
      overlapEnd - segmentStart
    );

    const effectiveFontWeight = segment.formats?.includes("bold")
      ? "bold"
      : textStyle.fontWeight;

    let segmentWidth = measureText(
      textToMeasure,
      textStyle.fontSize,
      effectiveFontWeight,
      fontFamily
    );

    width += segmentWidth;

    // Add code padding only if we've MOVED PAST this segment to the next one
    // (not just at the end boundary, but actually beyond it)
    // The cursor at the end of a code segment should be before the right padding
    if (segment.formats?.includes("code") && overlapEnd === segmentEnd && lineEndIndex > segmentEnd) {
      width += codePadding * 2;
    }

    currentIndex = segmentEnd;
  }

  return width;
}

// Helper function to render a line with formatting
function renderFormattedLine(
  ctx: CanvasRenderingContext2D,
  segments: Text[],
  lineStartIndex: number,
  lineEndIndex: number,
  x: number,
  y: number,
  textStyle: TextStyle,
  fontFamily: FontFamily,
  styles: EditorStyles
) {
  let currentX = x;
  let currentIndex = 0;

  // Iterate through segments and render the parts that belong to this line
  for (const segment of segments) {
    const segmentStart = currentIndex;
    const segmentEnd = currentIndex + segment.content.length;

    // Check if this segment overlaps with the current line
    if (segmentEnd > lineStartIndex && segmentStart < lineEndIndex) {
      // Calculate the part of the segment that belongs to this line
      const overlapStart = Math.max(segmentStart, lineStartIndex);
      const overlapEnd = Math.min(segmentEnd, lineEndIndex);
      const textToRender = segment.content.substring(
        overlapStart - segmentStart,
        overlapEnd - segmentStart
      );

      // Determine effective font weight for measurement
      const effectiveFontWeight = segment.formats?.includes("bold")
        ? "bold"
        : textStyle.fontWeight;
      const fontStyle = segment.formats?.includes("italic") ? "italic" : "normal";
      
      ctx.font = `${fontStyle} ${effectiveFontWeight} ${textStyle.fontSize}px ${
        FONT_STACKS[fontFamily]
      }`;
      ctx.textBaseline = "alphabetic";

      // Handle code background
      if (segment.formats?.includes("code")) {
        const textWidth = ctx.measureText(textToRender).width;
        const codeStyle = styles.textFormats.code;
        
        // Draw code background with rounded corners
        ctx.save();
        ctx.fillStyle = codeStyle.backgroundColor;
        const padding = codeStyle.padding;
        const rectX = currentX - padding;
        const rectY = y - textStyle.fontSize - padding;
        const rectWidth = textWidth + padding * 2;
        const rectHeight = textStyle.fontSize + padding * 2;
        
        // Simple rounded rectangle
        ctx.beginPath();
        ctx.roundRect(rectX, rectY, rectWidth, rectHeight, codeStyle.borderRadius);
        ctx.fill();
        ctx.restore();
        
        // Set code text color
        ctx.fillStyle = codeStyle.color;
      } else {
        ctx.fillStyle = textStyle.color;
      }

      // Render the text
      ctx.fillText(textToRender, currentX, y);

      // Handle strikethrough
      if (segment.formats?.includes("strikethrough")) {
        const textWidth = ctx.measureText(textToRender).width;
        ctx.save();
        ctx.strokeStyle = textStyle.color;
        ctx.lineWidth = Math.max(1, textStyle.fontSize / 16);
        ctx.beginPath();
        ctx.moveTo(currentX, y - textStyle.fontSize * 0.3);
        ctx.lineTo(currentX + textWidth, y - textStyle.fontSize * 0.3);
        ctx.stroke();
        ctx.restore();
      }

      // Move X position for next segment - use actual measured width
      let segmentWidth = ctx.measureText(textToRender).width;
      if (segment.formats?.includes("code")) {
        segmentWidth += styles.textFormats.code.padding * 2;
      }
      currentX += segmentWidth;
    }

    currentIndex = segmentEnd;

    // Stop if we've passed the end of the line
    if (currentIndex >= lineEndIndex) break;
  }
}

export const renderPage = (
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  viewport: ViewportState,
  visibility: { start: number; end: number },
  styles: EditorStyles = defaultStyles
) => {
  // Get device pixel ratio and scale canvas context for high-DPI displays
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

  // Save context state
  ctx.save();

  // Scale all drawing operations by DPR
  ctx.scale(dpr, dpr);

  // Enable text antialiasing for better quality on high-DPI screens
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Clear canvas
  ctx.fillStyle = styles.canvas.backgroundColor;
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  let currentY = styles.canvas.paddingTop - viewport.scrollY;
  const renderedBlocks: RenderedBlock[] = [];
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  let documentHeight = 0;

  // Render each block
  for (let i = 0; i < state.page.blocks.length; i++) {
    const block = state.page.blocks[i];

    // Get or calculate block height (cached on the block itself)
    const blockHeight = getBlockHeight(block, maxWidth, styles);

    documentHeight += blockHeight;
    // Only render if block is visible
    if (isBlockVisible(currentY, blockHeight, viewport)) {
      // console.log(i);
      visibility.start ??= i;
      visibility.end = i;

      const renderedBlock = renderBlock(
        ctx,
        state,
        block,
        i,
        styles.canvas.paddingLeft,
        currentY,
        maxWidth,
        styles
      );
      renderedBlocks.push(renderedBlock);
    }

    currentY += blockHeight;
  }

  // Add extra padding on mobile devices for keyboard space
  documentHeight += styles.canvas.paddingBottom;

  // Render scrollbar
  renderScrollbar(ctx, viewport, documentHeight, state.scrollbar);

  // Restore context state (undo scaling)
  ctx.restore();

  return documentHeight;
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
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;

  // Calculate line wrapping using formatted text wrapping
  const lines = wrapFormattedText(
    block.content,
    maxWidth,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    codePadding
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

  // Get full content for backward compatibility
  const fullContent = getBlockTextContent(block);

  // Render each line
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lineStartIndex = textIndex;
    const lineEndIndex = textIndex + line.length;

    // Render the line with formatting
    renderFormattedLine(
      ctx,
      block.content,
      lineStartIndex,
      lineEndIndex,
      x,
      currentY + fontMetrics.ascent,
      textStyle,
      fontFamily,
      styles
    );

    // Use font metrics for consistent positioning
    const textHeight = fontMetrics.ascent + fontMetrics.descent;

    // Measure the line width (need to account for formatting)
    const lineWidth = measureFormattedLineWidth(
      block.content,
      lineStartIndex,
      lineEndIndex,
      textStyle,
      fontFamily,
      codePadding
    );

    // Store rendered line
    const renderedLine: RenderedLine = {
      text: line,
      x,
      y: currentY,
      width: lineWidth,
      height: textHeight,
      startIndex: lineStartIndex,
      endIndex: lineEndIndex,
    };
    renderedLines.push(renderedLine);

    textIndex += line.length;
    // Account for the space character consumed during text wrapping (if not last line)
    if (lineIndex < lines.length - 1) {
      textIndex += 1;
    }
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
      y,
      fullContent,
      textStyle,
      fontFamily,
      block
    );
  }

  // Handle placeholder rendering
  if (
    state.cursor &&
    state.cursor.position.blockIndex === blockIndex &&
    fullContent.length === 0
  ) {
    renderPlaceholder(
      ctx,
      x,
      y + fontMetrics.ascent,
      styles,
      textStyle,
      block.type
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
      fullContent,
      fontFamily,
      ctx,
      styles,
      block
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

function renderPlaceholder(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  styles: EditorStyles,
  textStyle: TextStyle,
  blockType: "heading1" | "heading2" | "heading3" | "paragraph"
) {
  ctx.save();
  ctx.fillStyle = styles.placeholder.color;
  ctx.globalAlpha = styles.placeholder.opacity;
  ctx.font = `${textStyle.fontWeight} ${textStyle.fontSize}px ${
    FONT_STACKS[getCurrentFontFamily()]
  }`;
  ctx.textBaseline = "alphabetic";

  const placeholderConfig = styles.placeholder[blockType];
  const isMobile = typeof window !== "undefined" && window.innerWidth <= 768;
  let placeholderText: string;

  if (blockType === "paragraph" && isMobile) {
    placeholderText = styles.placeholder.paragraph.mobileText;
  } else {
    placeholderText = placeholderConfig.text;
  }

  ctx.fillText(placeholderText, x, y);
  ctx.restore();
}

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
  styles: EditorStyles,
  block: Block
) {
  if (!state.cursor || !state.isFocused) return;

  let cursorX = x;
  let cursorY = y;
  let cursorHeight = fontMetrics.fontSize * textStyle.lineHeight;
  const codePadding = styles.textFormats.code.padding;

  // console.log(renderedLines);
  for (const line of renderedLines) {
    if (
      state.cursor.position.textIndex >= line.startIndex &&
      state.cursor.position.textIndex <= line.endIndex
    ) {
      cursorY = line.y;
      cursorHeight = line.height;
      // Use format-aware measurement for cursor positioning
      cursorX += measureFormattedLineWidth(
        block.content,
        line.startIndex,
        state.cursor.position.textIndex,
        textStyle,
        fontFamily,
        codePadding
      );
      break;
    }
  }

  // For end-of-block selections (textIndex at content end), place cursor at end of last line
  if (
    state.cursor.position.textIndex === content.length &&
    renderedLines.length > 0
  ) {
    const lastLine = renderedLines[renderedLines.length - 1];
    cursorX = lastLine.x + lastLine.width;
    cursorY = lastLine.y;
    cursorHeight = lastLine.height;
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
  y: number,
  content: string,
  textStyle: TextStyle,
  fontFamily: FontFamily,
  block: Block
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

    const lineHeight = textStyle.fontSize * textStyle.lineHeight;
    const codePadding = styles.textFormats.code.padding;

    // Handle empty blocks
    if (
      content.length === 0 &&
      renderedLines.length === 1 &&
      blockIndex !== state.cursor?.position.blockIndex
    ) {
      const fontMetrics = getFontMetrics(
        textStyle.fontSize,
        textStyle.fontWeight,
        fontFamily
      );
      const emptyBlockHeight = fontMetrics.fontSize * textStyle.lineHeight;
      const minSelectionWidth = textStyle.fontSize * 0.5;

      ctx.fillRect(x, y, minSelectionWidth, emptyBlockHeight);
      ctx.restore();
      return;
    }

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
            // Use format-aware measurement
            selectionStartX += measureFormattedLineWidth(
              block.content,
              line.startIndex,
              start.textIndex,
              textStyle,
              fontFamily,
              codePadding
            );
          }
          if (end.textIndex < line.endIndex) {
            // Use format-aware measurement
            const selectedWidth = measureFormattedLineWidth(
              block.content,
              Math.max(line.startIndex, start.textIndex),
              Math.min(line.endIndex, end.textIndex),
              textStyle,
              fontFamily,
              codePadding
            );
            selectionEndX = selectionStartX + selectedWidth;
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
            // Use format-aware measurement
            selectionStartX += measureFormattedLineWidth(
              block.content,
              line.startIndex,
              start.textIndex,
              textStyle,
              fontFamily,
              codePadding
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
            // Use format-aware measurement
            selectionEndX = x + measureFormattedLineWidth(
              block.content,
              line.startIndex,
              end.textIndex,
              textStyle,
              fontFamily,
              codePadding
            );
          }
        }
      }

      if (shouldRender) {
        ctx.fillRect(
          selectionStartX,
          line.y,
          selectionEndX - selectionStartX,
          lineHeight
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
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;

  const lines = wrapFormattedText(
    block.content,
    maxWidth,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    codePadding
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
  // Buffer not needed anymore because we use canvas based scrolling
  const buffer = 0;
  return (
    // blockY is relative to canvas (already offset by scrollY), so viewport top is 0
    blockBottom >= -buffer && blockTop <= viewport.height + buffer
  );
};
