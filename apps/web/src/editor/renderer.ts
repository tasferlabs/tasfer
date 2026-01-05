import type { Block, Text } from "../deserializer/loadPage";
import { isTextBlock } from "../deserializer/loadPage";
import {
  FONT_STACKS,
  getCurrentFontFamily,
  getFontMetrics,
  measureText,
  wrapFormattedTextDetailed,
  type FontFamily,
} from "./fonts";
import { renderScrollbar } from "./scrollbar";
import { getBlockTextContent, isCursorBlinking } from "./state";
import { getEditorStyles, getTextStyle } from "./styles";
import { getFormattedTextDirection } from "./rtl";
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

// Helper to inject composition text into block content for rendering
function getContentWithComposition(
  block: Block,
  state: EditorState,
  blockIndex: number
): {
  content: Text[];
  compositionRange: { start: number; end: number } | null;
} {
  if (!isTextBlock(block)) {
    return { content: [], compositionRange: null };
  }

  // Check if composition is active and cursor is in this block
  if (
    !state.ui.composition ||
    !state.ui.composition.isComposing ||
    !state.document.cursor ||
    state.document.cursor.position.blockIndex !== blockIndex
  ) {
    return { content: block.content, compositionRange: null };
  }

  const compositionText = state.ui.composition.text;
  if (!compositionText) {
    return { content: block.content, compositionRange: null };
  }

  const cursorTextIndex = state.document.cursor.position.textIndex;

  // Handle empty block or cursor at the very end
  if (block.content.length === 0 || cursorTextIndex === 0) {
    // Insert composition at the start
    return {
      content: [{ content: compositionText, formats: [] }, ...block.content],
      compositionRange: { start: 0, end: compositionText.length },
    };
  }

  // Create a modified copy of the content with composition text inserted
  const modifiedContent: Text[] = [];
  let currentIndex = 0;
  let compositionInserted = false;

  for (let i = 0; i < block.content.length; i++) {
    const segment = block.content[i];
    const segmentStart = currentIndex;
    const segmentEnd = currentIndex + segment.content.length;

    // Check if cursor is within this segment
    if (cursorTextIndex >= segmentStart && cursorTextIndex <= segmentEnd) {
      const offsetInSegment = cursorTextIndex - segmentStart;

      // Split the segment at the cursor position
      const beforeCursor = segment.content.substring(0, offsetInSegment);
      const afterCursor = segment.content.substring(offsetInSegment);

      // Add the part before cursor (if any)
      if (beforeCursor) {
        modifiedContent.push({
          ...segment,
          content: beforeCursor,
        });
      }

      // Add composition text as a new segment
      modifiedContent.push({
        content: compositionText,
        formats: segment.formats || [], // Inherit formats from current segment
      });
      compositionInserted = true;

      // Add the part after cursor (if any)
      if (afterCursor) {
        modifiedContent.push({
          ...segment,
          content: afterCursor,
        });
      }
    } else {
      // Keep segment as is
      modifiedContent.push(segment);
    }

    currentIndex = segmentEnd;
  }

  // If cursor is at the very end (after all segments), append composition
  if (!compositionInserted) {
    const lastSegment = block.content[block.content.length - 1];
    modifiedContent.push({
      content: compositionText,
      formats: lastSegment?.formats || [],
    });
  }

  // Calculate composition range in the modified content
  const compositionStart = cursorTextIndex;
  const compositionEnd = cursorTextIndex + compositionText.length;

  return {
    content: modifiedContent,
    compositionRange: { start: compositionStart, end: compositionEnd },
  };
}

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

    const effectiveFontWeight = segment.formats?.some((f) => f.type === "bold")
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
    if (
      segment.formats?.some((f) => f.type === "code") &&
      overlapEnd === segmentEnd &&
      lineEndIndex > segmentEnd
    ) {
      width += codePadding * 2;
    }

    currentIndex = segmentEnd;
  }

  return width;
}

// Helper to render underline decoration for composition text
function renderCompositionUnderline(
  ctx: CanvasRenderingContext2D,
  segments: Text[],
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
  _maxWidth: number
) {
  // Calculate the overlap between this line and the composition range
  const underlineStart = Math.max(lineStartIndex, compositionStart);
  const underlineEnd = Math.min(lineEndIndex, compositionEnd);

  if (underlineStart >= underlineEnd) return;

  // Measure width from line start to underline start
  const offsetToStart = measureFormattedLineWidth(
    segments,
    lineStartIndex,
    underlineStart,
    textStyle,
    fontFamily,
    codePadding
  );

  // Measure width of the underlined portion
  const underlineWidth = measureFormattedLineWidth(
    segments,
    underlineStart,
    underlineEnd,
    textStyle,
    fontFamily,
    codePadding
  );

  // Calculate underline position
  const underlineY = y + fontMetrics.ascent + 2;
  const underlineThickness = 1.5;

  ctx.save();
  ctx.strokeStyle = textStyle.color;
  ctx.lineWidth = underlineThickness;
  ctx.beginPath();
  11;

  if (isRTL) {
    // For RTL, x is already adjusted to right edge (x + maxWidth), so just subtract offset
    const startX = x - offsetToStart;
    ctx.moveTo(startX, underlineY);
    ctx.lineTo(startX - underlineWidth, underlineY);
  } else {
    // For LTR, measure from the left edge
    const startX = x + offsetToStart;
    ctx.moveTo(startX, underlineY);
    ctx.lineTo(startX + underlineWidth, underlineY);
  }

  ctx.stroke();
  ctx.restore();
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
  // Detect text direction for this line
  const direction = getFormattedTextDirection(segments);
  const isRTL = direction === "rtl";

  // Set canvas direction
  ctx.direction = direction;

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
      const effectiveFontWeight = segment.formats?.some(
        (f) => f.type === "bold"
      )
        ? "bold"
        : textStyle.fontWeight;
      const fontStyle = segment.formats?.some((f) => f.type === "italic")
        ? "italic"
        : "normal";

      ctx.font = `${fontStyle} ${effectiveFontWeight} ${textStyle.fontSize}px ${FONT_STACKS[fontFamily]}`;
      ctx.textBaseline = "alphabetic";

      // Check if this is a link
      const linkFormat = segment.formats?.find((f) => f.type === "link");
      const isLink = !!linkFormat;

      // Measure text width with correct font already set
      const textWidth = ctx.measureText(textToRender).width;

      // For RTL text with canvas direction="rtl":
      // fillText(text, x, y) draws text ending at position x (text goes leftward from x)
      // So for RTL, currentX is the RIGHT edge where text ends
      const visualX = currentX;

      // Handle code background
      if (segment.formats?.some((f) => f.type === "code")) {
        const codeStyle = styles.textFormats.code;
        const padding = codeStyle.padding;

        // Draw code background with rounded corners
        ctx.save();
        ctx.fillStyle = codeStyle.backgroundColor;

        let rectX: number;
        if (isRTL) {
          // For RTL with direction="rtl", text is drawn ENDING at visualX going leftward
          // So background should span from (visualX - textWidth - padding) to (visualX + padding)
          rectX = visualX - textWidth - padding;
        } else {
          // For LTR, background starts just before text
          rectX = visualX - padding;
        }

        const rectY = y - textStyle.fontSize - padding;
        const rectWidth = textWidth + padding * 2;
        const rectHeight = textStyle.fontSize * textStyle.lineHeight;

        // Simple rounded rectangle
        ctx.beginPath();
        ctx.roundRect(
          rectX,
          rectY,
          rectWidth,
          rectHeight,
          codeStyle.borderRadius
        );
        ctx.fill();
        ctx.restore();

        // Set code text color
        ctx.fillStyle = codeStyle.color;
      } else if (isLink) {
        // Set link color from styles
        ctx.fillStyle = styles.textFormats.link.color;
      } else {
        ctx.fillStyle = textStyle.color;
      }

      // Render the text
      ctx.fillText(textToRender, visualX, y);

      // Handle underline for links
      if (isLink) {
        const linkStyle = styles.textFormats.link;
        ctx.save();
        ctx.strokeStyle = linkStyle.color;
        ctx.lineWidth = linkStyle.underlineThickness;
        ctx.beginPath();

        if (isRTL) {
          // For RTL with direction="rtl", text ends at visualX and extends left
          // Underline from left edge (visualX - textWidth) to right edge (visualX)
          ctx.moveTo(visualX - textWidth, y + textStyle.fontSize * 0.1);
          ctx.lineTo(visualX, y + textStyle.fontSize * 0.1);
        } else {
          // For LTR, underline from left to right
          ctx.moveTo(visualX, y + textStyle.fontSize * 0.1);
          ctx.lineTo(visualX + textWidth, y + textStyle.fontSize * 0.1);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Handle strikethrough
      if (segment.formats?.some((f) => f.type === "strikethrough")) {
        ctx.save();
        ctx.strokeStyle = textStyle.color;
        ctx.lineWidth = Math.max(1, textStyle.fontSize / 16);
        ctx.beginPath();

        if (isRTL) {
          // For RTL with direction="rtl", strikethrough from left to right
          ctx.moveTo(visualX - textWidth, y - textStyle.fontSize * 0.3);
          ctx.lineTo(visualX, y - textStyle.fontSize * 0.3);
        } else {
          // For LTR, strikethrough from left to right
          ctx.moveTo(visualX, y - textStyle.fontSize * 0.3);
          ctx.lineTo(visualX + textWidth, y - textStyle.fontSize * 0.3);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Move X position for next segment
      let segmentWidth = textWidth;
      if (segment.formats?.some((f) => f.type === "code")) {
        segmentWidth += styles.textFormats.code.padding * 2;
      }

      // For RTL, move LEFT (subtract); for LTR, move RIGHT (add)
      if (isRTL) {
        currentX -= segmentWidth;
      } else {
        currentX += segmentWidth;
      }
    }

    currentIndex = segmentEnd;

    // Stop if we've passed the end of the line
    if (currentIndex >= lineEndIndex) break;
  }

  // Reset direction
  ctx.direction = "ltr";
}

export const renderPage = (
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  viewport: ViewportState,
  visibility: { start: number; end: number },
  styles: EditorStyles = getEditorStyles()
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

  // Clear canvas (background color is handled by CSS on the canvas element)
  ctx.clearRect(0, 0, viewport.width, viewport.height);

  let currentY = styles.canvas.paddingTop - viewport.scrollY;
  const renderedBlocks: RenderedBlock[] = [];
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  let documentHeight = 0;

  // Render each block
  for (let i = 0; i < state.document.page.blocks.length; i++) {
    const block = state.document.page.blocks[i];

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
  renderScrollbar(ctx, viewport, documentHeight, state.view.scrollbar);

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
  styles: EditorStyles = getEditorStyles()
): RenderedBlock => {
  // Handle image cover blocks
  if (block.type === "imageCover") {
    return renderImageCoverBlock(
      ctx,
      state,
      block,
      blockIndex,
      x,
      y,
      maxWidth,
      styles
    );
  }

  const textStyle = getTextStyle(styles, block.type);
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;

  // Get content with composition text injected (if composing in this block)
  const { content: renderContent, compositionRange } =
    getContentWithComposition(block, state, blockIndex);

  // Calculate line wrapping using the render content (includes composition)
  const lines = wrapFormattedTextDetailed(
    renderContent,
    maxWidth,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    codePadding,
    compositionRange
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
    const wrappedLine = lines[lineIndex];
    const line = wrappedLine.text;
    const lineStartIndex = textIndex;
    const lineEndIndex = textIndex + line.length;

    // Detect text direction and adjust x position for RTL
    const direction = getFormattedTextDirection(renderContent);
    const renderX = direction === "rtl" ? x + maxWidth : x;

    // Render the line with formatting (using render content with composition)
    renderFormattedLine(
      ctx,
      renderContent,
      lineStartIndex,
      lineEndIndex,
      renderX,
      currentY + fontMetrics.ascent,
      textStyle,
      fontFamily,
      styles
    );

    // Render composition underline if this line contains composition text
    if (compositionRange) {
      const lineContainsComposition =
        lineStartIndex < compositionRange.end &&
        lineEndIndex > compositionRange.start;

      if (lineContainsComposition) {
        renderCompositionUnderline(
          ctx,
          renderContent,
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
          direction === "rtl",
          maxWidth
        );
      }
    }

    // Use font metrics for consistent positioning
    const textHeight = fontMetrics.ascent + fontMetrics.descent;

    // Measure the line width (need to account for formatting)
    const lineWidth = measureFormattedLineWidth(
      renderContent,
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
    // Account for the space character consumed during text wrapping
    if (wrappedLine.consumedSpace) {
      textIndex += 1;
    }
    currentY += lineHeight;
  }

  // Handle selection rendering
  if (state.document.selection && !state.document.selection.isCollapsed) {
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
      block,
      maxWidth
    );
  }

  // Don't show placeholder or cursor when there's an active selection
  const hasActiveSelection =
    state.document.selection && !state.document.selection.isCollapsed;

  // Handle placeholder rendering
  if (
    state.document.cursor &&
    state.document.cursor.position.blockIndex === blockIndex &&
    fullContent.length === 0 &&
    !state.ui.composition &&
    !hasActiveSelection
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
    state.document.cursor &&
    state.document.cursor.position.blockIndex === blockIndex &&
    !isCursorBlinking(state.document.cursor, styles) &&
    !hasActiveSelection
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
      block,
      maxWidth
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
  block: Block,
  maxWidth: number
) {
  if (!state.document.cursor || !state.view.isFocused) return;

  if (!isTextBlock(block)) {
    return;
  }

  let cursorX = x;
  let cursorY = y;
  let cursorHeight = fontMetrics.fontSize * textStyle.lineHeight;
  const codePadding = styles.textFormats.code.padding;

  // Detect if this is an RTL block
  const isRTL = getFormattedTextDirection(block.content) === "rtl";

  // console.log(renderedLines);
  for (const line of renderedLines) {
    if (
      state.document.cursor.position.textIndex >= line.startIndex &&
      state.document.cursor.position.textIndex <= line.endIndex
    ) {
      cursorY = line.y;
      cursorHeight = line.height;

      // Calculate cursor position differently for RTL
      if (isRTL) {
        // For RTL text rendered with canvas direction="rtl":
        // - Cursor at logical index 0 (line start) appears at the RIGHT (x + maxWidth)
        // - Cursor at logical index N appears at the LEFT
        // Measure from line start to cursor position
        const widthFromStart = measureFormattedLineWidth(
          block.content,
          line.startIndex,
          state.document.cursor.position.textIndex,
          textStyle,
          fontFamily,
          codePadding
        );
        cursorX = x + maxWidth - widthFromStart;
      } else {
        // LTR: measure from start to cursor
        cursorX += measureFormattedLineWidth(
          block.content,
          line.startIndex,
          state.document.cursor.position.textIndex,
          textStyle,
          fontFamily,
          codePadding
        );
      }
      break;
    }
  }

  // For end-of-block selections (textIndex at content end), place cursor at end of last line
  if (
    state.document.cursor.position.textIndex === content.length &&
    renderedLines.length > 0
  ) {
    const lastLine = renderedLines[renderedLines.length - 1];
    if (isRTL) {
      // For RTL, cursor goes to the left edge
      cursorX = lastLine.x + maxWidth - lastLine.width;
    } else {
      cursorX = lastLine.x + lastLine.width;
    }
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
  block: Block,
  maxWidth: number
) {
  if (!state.document.selection) return;

  if (!isTextBlock(block)) {
    return;
  }

  // Sort anchor and focus to ensure start is always before end
  let start = state.document.selection.isForward
    ? state.document.selection.anchor
    : state.document.selection.focus;
  let end = state.document.selection.isForward
    ? state.document.selection.focus
    : state.document.selection.anchor;

  // Detect if this is an RTL block
  const isRTL = getFormattedTextDirection(block.content) === "rtl";

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
    if (content.length === 0 && renderedLines.length === 1) {
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

          if (isRTL) {
            // For RTL text rendered with canvas direction="rtl":
            // - Logical index 0 appears at RIGHT (x + maxWidth)
            // - Logical index N appears at LEFT
            // Selection needs to be drawn from left to right visually

            const selStartTextIndex = Math.max(
              line.startIndex,
              start.textIndex
            );
            const selEndTextIndex = Math.min(line.endIndex, end.textIndex);

            // Measure from line START to selection START
            const widthToSelStart = measureFormattedLineWidth(
              block.content,
              line.startIndex,
              selStartTextIndex,
              textStyle,
              fontFamily,
              codePadding
            );

            // Measure from line START to selection END
            const widthToSelEnd = measureFormattedLineWidth(
              block.content,
              line.startIndex,
              selEndTextIndex,
              textStyle,
              fontFamily,
              codePadding
            );

            // Visual X positions: further from line start logically = further LEFT visually
            // Selection START (lower index) is at RIGHT visually
            // Selection END (higher index) is at LEFT visually
            selectionEndX = x + maxWidth - widthToSelStart; // Right edge of selection (lower logical index)
            selectionStartX = x + maxWidth - widthToSelEnd; // Left edge of selection (higher logical index)
          } else {
            // LTR logic (existing)
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
        }
      } else if (start.blockIndex < blockIndex && end.blockIndex > blockIndex) {
        // Entire block is selected
        shouldRender = true;
        if (isRTL) {
          const lineStartX = x + maxWidth - line.width;
          selectionStartX = lineStartX;
          selectionEndX = lineStartX + line.width;
        }
      } else if (
        start.blockIndex === blockIndex &&
        end.blockIndex > blockIndex
      ) {
        // Selection starts in this block
        if (start.textIndex <= line.endIndex) {
          shouldRender = true;

          if (isRTL) {
            // Selection starts in this block and continues beyond
            const selStartTextIndex = Math.max(
              line.startIndex,
              start.textIndex
            );

            // Measure from line start to selection start
            const widthToSelStart = measureFormattedLineWidth(
              block.content,
              line.startIndex,
              selStartTextIndex,
              textStyle,
              fontFamily,
              codePadding
            );

            // Selection goes from start.textIndex (appears RIGHT) to end of line (appears LEFT)
            selectionEndX = x + maxWidth - widthToSelStart; // Right edge (selection start, lower index)
            selectionStartX = x + maxWidth - line.width; // Left edge (line end, higher index)
          } else {
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
        }
      } else if (
        start.blockIndex < blockIndex &&
        end.blockIndex === blockIndex
      ) {
        // Selection ends in this block
        if (end.textIndex >= line.startIndex) {
          shouldRender = true;

          if (isRTL) {
            // Selection ends in this block, started before
            const selEndTextIndex = Math.min(line.endIndex, end.textIndex);

            // Measure from line start to selection end
            const widthToSelEnd = measureFormattedLineWidth(
              block.content,
              line.startIndex,
              selEndTextIndex,
              textStyle,
              fontFamily,
              codePadding
            );

            // Selection goes from start of line (appears RIGHT, lower index) to end.textIndex (appears LEFT)
            selectionEndX = x + maxWidth; // Right edge (line start, index 0)
            selectionStartX = x + maxWidth - widthToSelEnd; // Left edge (selection end, higher index)
          } else {
            if (end.textIndex < line.endIndex) {
              // Use format-aware measurement
              selectionEndX =
                x +
                measureFormattedLineWidth(
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

// Image cache to avoid reloading images
const imageCache = new Map<string, HTMLImageElement>();
// Cache for failed image loads to prevent repeated requests
const failedImageCache = new Set<string>();

// Clear failed image from cache (useful for retry scenarios)
export function clearFailedImageCache(url?: string) {
  if (url) {
    failedImageCache.delete(url);
  } else {
    failedImageCache.clear();
  }
}

// Load image and cache it
function loadImage(url: string): Promise<HTMLImageElement> {
  // Check if this image previously failed to load
  if (failedImageCache.has(url)) {
    return Promise.reject(new Error(`Image previously failed to load: ${url}`));
  }

  // Check cache first
  if (imageCache.has(url)) {
    const cached = imageCache.get(url)!;
    if (cached.complete) {
      return Promise.resolve(cached);
    }
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // Enable CORS if needed

    img.onload = () => {
      imageCache.set(url, img);
      resolve(img);
    };

    img.onerror = () => {
      // Cache the failed URL to prevent repeated requests
      failedImageCache.add(url);
      reject(new Error(`Failed to load image: ${url}`));
    };

    img.src = url;

    // If already complete (from cache), resolve immediately
    if (img.complete) {
      imageCache.set(url, img);
      resolve(img);
    }
  });
}

// Render image cover block
function renderImageCoverBlock(
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  block: Block,
  blockIndex: number,
  _x: number,
  y: number,
  _maxWidth: number,
  styles: EditorStyles
): RenderedBlock {
  if (block.type !== "imageCover") {
    throw new Error("renderImageCoverBlock called on non-image-cover block");
  }

  const { paddingBottom: padding, height: imageHeight } = styles.imageCover.dimensions;

  // Calculate full canvas width (accounting for left and right padding)
  const fullWidth =
    _maxWidth + styles.canvas.paddingLeft + styles.canvas.paddingRight;
  const fullWidthX = 0; // Start from canvas edge, not content edge

  // If this is the first block, bleed into the top padding for edge-to-edge experience
  const isFirstBlock = blockIndex === 0;
  const adjustedY = isFirstBlock ? y - styles.canvas.paddingTop : y;
  const adjustedHeight = isFirstBlock
    ? imageHeight + styles.canvas.paddingTop
    : imageHeight;

  ctx.save();

  // Get upload status from UI state (transient state)
  const uploadStatus =
    state.ui.activeMenu.type === "imageUpload" &&
    state.ui.activeMenu.blockIndex === blockIndex
      ? state.ui.activeMenu.uploadStatus
      : undefined;

  // Draw placeholder or image
  if (uploadStatus === "uploading") {
    // Uploading state
    ctx.fillStyle = styles.imageCover.uploading.backgroundColor;
    ctx.fillRect(fullWidthX, adjustedY, fullWidth, adjustedHeight);

    ctx.fillStyle = styles.imageCover.uploading.textColor;
    ctx.font = "14px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      styles.imageCover.uploading.text,
      fullWidthX + fullWidth / 2,
      adjustedY + adjustedHeight / 2
    );
  } else if (uploadStatus === "error") {
    // Error state
    ctx.fillStyle = styles.imageCover.error.backgroundColor;
    ctx.fillRect(fullWidthX, adjustedY, fullWidth, adjustedHeight);

    ctx.fillStyle = styles.imageCover.error.textColor;
    ctx.font = "14px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      styles.imageCover.error.text,
      fullWidthX + fullWidth / 2,
      adjustedY + adjustedHeight / 2
    );
    ctx.fillText(
      styles.imageCover.error.retryText,
      fullWidthX + fullWidth / 2,
      adjustedY + adjustedHeight / 2 + 20
    );
  } else if (block.url) {
    // Check if this image previously failed to load
    if (failedImageCache.has(block.url)) {
      // Show error state for failed images
      ctx.fillStyle = styles.imageCover.error.backgroundColor;
      ctx.fillRect(fullWidthX, adjustedY, fullWidth, adjustedHeight);

      ctx.fillStyle = styles.imageCover.error.textColor;
      ctx.font = "14px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        styles.imageCover.error.text,
        fullWidthX + fullWidth / 2,
        adjustedY + adjustedHeight / 2
      );
      ctx.fillText(
        styles.imageCover.error.retryText,
        fullWidthX + fullWidth / 2,
        adjustedY + adjustedHeight / 2 + 20
      );
    } else {
      // Try to load and draw the actual image
      const cachedImage = imageCache.get(block.url);

      if (cachedImage && cachedImage.complete) {
        // Use "cover" algorithm: fill the entire area while maintaining aspect ratio
        const imgAspectRatio =
          cachedImage.naturalWidth / cachedImage.naturalHeight;
        const containerAspectRatio = fullWidth / adjustedHeight;

        let sourceX = 0;
        let sourceY = 0;
        let sourceWidth = cachedImage.naturalWidth;
        let sourceHeight = cachedImage.naturalHeight;

        // Cover algorithm: crop the image to fill the container
        if (imgAspectRatio > containerAspectRatio) {
          // Image is wider than container - crop width
          sourceWidth = cachedImage.naturalHeight * containerAspectRatio;
          sourceX = (cachedImage.naturalWidth - sourceWidth) / 2;
        } else {
          // Image is taller than container - crop height
          sourceHeight = cachedImage.naturalWidth / containerAspectRatio;
          sourceY = (cachedImage.naturalHeight - sourceHeight) / 2;
        }

        // Draw background (for any transparency)
        ctx.fillStyle = styles.imageCover.loading.backgroundColor;
        ctx.fillRect(fullWidthX, adjustedY, fullWidth, adjustedHeight);

        // Draw the image using cover algorithm (cropping as needed)
        ctx.drawImage(
          cachedImage,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight, // Source rectangle
          fullWidthX,
          adjustedY,
          fullWidth,
          adjustedHeight // Destination rectangle
        );
      } else {
        // Show loading placeholder while image loads
        ctx.fillStyle = styles.imageCover.loading.backgroundColor;
        ctx.fillRect(fullWidthX, adjustedY, fullWidth, adjustedHeight);

        ctx.fillStyle = styles.imageCover.loading.textColor;
        ctx.font = "14px system-ui, -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(
          styles.imageCover.loading.text,
          fullWidthX + fullWidth / 2,
          adjustedY + adjustedHeight / 2
        );

        // Start loading the image
        loadImage(block.url)
          .then(() => {
            // Force re-render when image loads
            // This will be handled by the editor's render loop
          })
          .catch((error) => {
            console.error("Failed to load image:", error);
          });
      }
    }
  } else {
    // No image - show upload prompt
    ctx.strokeStyle = styles.imageCover.placeholder.borderColor;
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 2;
    ctx.strokeRect(fullWidthX, adjustedY, fullWidth, adjustedHeight);

    ctx.fillStyle = styles.imageCover.placeholder.textColor;
    ctx.font = "14px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      styles.imageCover.placeholder.text,
      fullWidthX + fullWidth / 2,
      adjustedY + adjustedHeight / 2
    );
  }

  // Render selection overlay if this image block is selected
  if (state.document.selection && !state.document.selection.isCollapsed) {
    const { anchor, focus } = state.document.selection;
    const start = anchor.blockIndex <= focus.blockIndex ? anchor : focus;
    const end = anchor.blockIndex <= focus.blockIndex ? focus : anchor;

    // Check if this image block is within the selection
    const isSelected = blockIndex >= start.blockIndex && blockIndex <= end.blockIndex;

    if (isSelected) {
      ctx.fillStyle = styles.selection.backgroundColor;
      ctx.globalAlpha = styles.selection.opacity;
      ctx.fillRect(fullWidthX, adjustedY, fullWidth, adjustedHeight);
      ctx.globalAlpha = 1.0;
    }
  }

  ctx.restore();

  const blockBounds: BlockBounds = {
    x: fullWidthX,
    y: adjustedY,
    width: fullWidth,
    height: adjustedHeight + padding,
  };

  return {
    block,
    bounds: blockBounds,
    lines: [], // Image cover blocks don't have text lines
  };
}

// Calculate block height dynamically based on content and max width
export const calculateBlockHeight = (
  block: Block,
  maxWidth: number,
  styles: EditorStyles
): number => {
  // Handle image cover blocks
  if (block.type === "imageCover") {
    const { height, paddingBottom: padding } = styles.imageCover.dimensions;
    return height + padding;
  }

  if (!isTextBlock(block)) {
    return 0;
  }

  const textStyle = getTextStyle(styles, block.type);
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;

  const lines = wrapFormattedTextDetailed(
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
