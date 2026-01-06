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
  styles: EditorStyles,
  blockIndex?: number
): number => {
  // Calculate the base height (with caching)
  let height: number;
  if (block.cachedHeight !== undefined && block.cachedWidth === maxWidth) {
    height = block.cachedHeight;
  } else {
    height = calculateBlockHeight(block, maxWidth, styles);
    block.cachedHeight = height;
    block.cachedWidth = maxWidth;
  }

  // Special handling for first block image covers that bleed into top padding
  // They use up the padding space, so we subtract it from the effective height
  // Only apply this for full-width images that actually bleed
  if (blockIndex === 0 && block.type === "image") {
    const imageWidth = block.width ?? "full";
    const shouldBleed = imageWidth === "full";
    if (shouldBleed) {
      return height - styles.canvas.paddingTop;
    }
  }

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
  // Save context state
  ctx.save();

  // Enable text antialiasing for better quality on high-DPI screens
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Clear canvas (background color is handled by CSS on the canvas element)
  // Note: Context is already scaled by DPR in layers.ts, so use CSS pixels here
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
    const blockHeight = getBlockHeight(block, maxWidth, styles, i);

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
  if (block.type === "image") {
    return renderImageBlock(
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

  // NOTE: Cursor rendering is now handled by the separate cursor layer
  // This prevents double-rendering of the cursor during composition (IME input)

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
export const imageCache = new Map<string, HTMLImageElement>();
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
function renderImageBlock(
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  block: Block,
  blockIndex: number,
  _x: number,
  y: number,
  _maxWidth: number,
  styles: EditorStyles
): RenderedBlock {
  if (block.type !== "image") {
    throw new Error("renderImageBlock called on non-image block");
  }

  const {
    paddingBottom: padding,
    height: defaultImageHeight,
    placeholderHeight,
  } = styles.blocks.image.dimensions;

  // Get image properties (with defaults)
  const imageWidth = block.width ?? "full";
  const imageHeight = block.height ?? defaultImageHeight;
  const objectFit = block.objectFit ?? "cover";

  // Calculate dimensions based on width setting
  let displayWidth: number;
  let displayHeight: number;
  let displayX: number;

  if (imageWidth === "full") {
    // Full width: edge-to-edge (ignoring padding)
    displayWidth =
      _maxWidth + styles.canvas.paddingLeft + styles.canvas.paddingRight;
    displayX = 0;
    displayHeight = block.url ? imageHeight : placeholderHeight;
  } else {
    // Custom width: respect padding and constrain to container
    const requestedWidth = imageWidth;
    displayWidth = Math.min(requestedWidth, _maxWidth);
    displayX = styles.canvas.paddingLeft + (_maxWidth - displayWidth) / 2; // Center the image
    
    // Adjust height proportionally if width was constrained
    // This ensures images resized on desktop don't get distorted on mobile
    if (block.url && displayWidth < requestedWidth) {
      // Width was constrained - adjust height proportionally
      const widthRatio = displayWidth / requestedWidth;
      displayHeight = imageHeight * widthRatio;
    } else {
      displayHeight = block.url ? imageHeight : placeholderHeight;
    }
  }

  // First block images in cover mode (full width) bleed into the top padding for edge-to-edge experience
  // They start higher but maintain their proper dimensions
  const isFirstBlock = blockIndex === 0;
  const shouldBleedIntoTopPadding = isFirstBlock && imageWidth === "full";
  const adjustedY = shouldBleedIntoTopPadding
    ? y - styles.canvas.paddingTop
    : y;
  const adjustedHeight = displayHeight; // Always use actual dimensions

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
    ctx.fillStyle = styles.blocks.image.uploading.backgroundColor;
    ctx.fillRect(displayX, adjustedY, displayWidth, adjustedHeight);

    ctx.fillStyle = styles.blocks.image.uploading.textColor;
    ctx.font = "14px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      styles.blocks.image.uploading.text,
      displayX + displayWidth / 2,
      adjustedY + adjustedHeight / 2
    );
  } else if (uploadStatus === "error") {
    // Error state
    ctx.fillStyle = styles.blocks.image.error.backgroundColor;
    ctx.fillRect(displayX, adjustedY, displayWidth, adjustedHeight);

    ctx.fillStyle = styles.blocks.image.error.textColor;
    ctx.font = "14px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      styles.blocks.image.error.text,
      displayX + displayWidth / 2,
      adjustedY + adjustedHeight / 2
    );
    ctx.fillText(
      styles.blocks.image.error.retryText,
      displayX + displayWidth / 2,
      adjustedY + adjustedHeight / 2 + 20
    );
  } else if (block.url) {
    // Check if this image previously failed to load
    if (failedImageCache.has(block.url)) {
      // Show error state for failed images
      ctx.fillStyle = styles.blocks.image.error.backgroundColor;
      ctx.fillRect(displayX, adjustedY, displayWidth, adjustedHeight);

      ctx.fillStyle = styles.blocks.image.error.textColor;
      ctx.font = "14px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        styles.blocks.image.error.text,
        displayX + displayWidth / 2,
        adjustedY + adjustedHeight / 2
      );
      ctx.fillText(
        styles.blocks.image.error.retryText,
        displayX + displayWidth / 2,
        adjustedY + adjustedHeight / 2 + 20
      );
    } else {
      // Try to load and draw the actual image
      const cachedImage = imageCache.get(block.url);

      if (cachedImage && cachedImage.complete) {
        const imgAspectRatio =
          cachedImage.naturalWidth / cachedImage.naturalHeight;
        const containerAspectRatio = displayWidth / adjustedHeight;

        let sourceX = 0;
        let sourceY = 0;
        let sourceWidth = cachedImage.naturalWidth;
        let sourceHeight = cachedImage.naturalHeight;
        let destX = displayX;
        let destY = adjustedY;
        let destWidth = displayWidth;
        let destHeight = adjustedHeight;

        if (objectFit === "cover") {
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
        } else {
          // Contain algorithm: fit the entire image while maintaining aspect ratio
          if (imgAspectRatio > containerAspectRatio) {
            // Image is wider than container - fit to width
            destHeight = displayWidth / imgAspectRatio;
            destY = adjustedY + (adjustedHeight - destHeight) / 2;
          } else {
            // Image is taller than container - fit to height
            destWidth = adjustedHeight * imgAspectRatio;
            destX = displayX + (displayWidth - destWidth) / 2;
          }
        }

        // Draw background (for any transparency or contain mode)
        ctx.fillStyle = styles.blocks.image.loading.backgroundColor;
        ctx.fillRect(displayX, adjustedY, displayWidth, adjustedHeight);

        // Draw the image
        ctx.drawImage(
          cachedImage,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight, // Source rectangle
          destX,
          destY,
          destWidth,
          destHeight // Destination rectangle
        );
      } else {
        // Show loading placeholder while image loads
        ctx.fillStyle = styles.blocks.image.loading.backgroundColor;
        ctx.fillRect(displayX, adjustedY, displayWidth, adjustedHeight);

        ctx.fillStyle = styles.blocks.image.loading.textColor;
        ctx.font = "14px system-ui, -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(
          styles.blocks.image.loading.text,
          displayX + displayWidth / 2,
          adjustedY + adjustedHeight / 2
        );

        // Start loading the image
        loadImage(block.url)
          .then(() => {
            invalidateBlockCache(block);
          })
          .catch((error) => {
            console.error("Failed to load image:", error);
          });
      }
    }
  } else {
    ctx.fillStyle = styles.blocks.image.placeholder.backgroundColor;
    ctx.fillRect(displayX, adjustedY, displayWidth, adjustedHeight);
    // No image - show upload prompt
    ctx.strokeStyle = styles.blocks.image.placeholder.borderColor;
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 2;
    ctx.strokeRect(displayX, adjustedY, displayWidth, adjustedHeight);

    ctx.fillStyle = styles.blocks.image.placeholder.textColor;
    ctx.font = "14px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      styles.blocks.image.placeholder.text,
      displayX + displayWidth / 2,
      adjustedY + adjustedHeight / 2
    );
  }

  // Render selection overlay if this image block is selected
  if (state.document.selection && !state.document.selection.isCollapsed) {
    const { anchor, focus } = state.document.selection;
    const start = anchor.blockIndex <= focus.blockIndex ? anchor : focus;
    const end = anchor.blockIndex <= focus.blockIndex ? focus : anchor;

    // Check if this image block is within the selection
    const isSelected =
      blockIndex >= start.blockIndex && blockIndex <= end.blockIndex;

    if (isSelected) {
      ctx.fillStyle = styles.selection.backgroundColor;
      ctx.globalAlpha = styles.selection.opacity;
      ctx.fillRect(displayX, adjustedY, displayWidth, adjustedHeight);
      ctx.globalAlpha = 1.0;
    }
  }

  // Render drag handles if hovering or dragging this image
  // This ensures drag handles are rendered with the exact same dimensions as the image
  const shouldRenderDragHandles = 
    (state.ui.imageHover && state.ui.imageHover.blockIndex === blockIndex) ||
    (state.ui.imageDrag && state.ui.imageDrag.blockIndex === blockIndex);

  if (shouldRenderDragHandles) {
    let hoveredHandle: "left" | "right" | "bottom" | null = null;
    
    if (state.ui.imageDrag && state.ui.imageDrag.blockIndex === blockIndex) {
      hoveredHandle = state.ui.imageDrag.handle;
    } else if (state.ui.imageHover && state.ui.imageHover.blockIndex === blockIndex) {
      hoveredHandle = state.ui.imageHover.hoveredHandle;
    }

    renderImageDragHandlesForBlock(
      ctx,
      displayX,
      adjustedY,
      displayWidth,
      adjustedHeight,
      objectFit,
      hoveredHandle,
      styles
    );
  }

  ctx.restore();

  const blockBounds: BlockBounds = {
    x: displayX,
    y: adjustedY,
    width: displayWidth,
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
  if (block.type === "image") {
    const {
      height: defaultHeight,
      placeholderHeight,
      paddingBottom: padding,
    } = styles.blocks.image.dimensions;
    
    const imageWidth = block.width ?? "full";
    const imageHeight = block.height ?? defaultHeight;
    let displayHeight: number;
    
    if (imageWidth === "full") {
      // Full width images use their configured height
      displayHeight = block.url ? imageHeight : placeholderHeight;
    } else {
      // Custom width: adjust height proportionally if width was constrained
      const requestedWidth = imageWidth;
      const displayWidth = Math.min(requestedWidth, maxWidth);
      
      if (block.url && displayWidth < requestedWidth) {
        // Width was constrained - adjust height proportionally
        const widthRatio = displayWidth / requestedWidth;
        displayHeight = imageHeight * widthRatio;
      } else {
        displayHeight = block.url ? imageHeight : placeholderHeight;
      }
    }
    
    // Always add padding after image blocks for visual spacing
    return displayHeight + padding;
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

/**
 * Render only the cursor on a separate layer (for blink animation).
 * This is much faster than re-rendering the entire page.
 */
export function renderCursorLayer(
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles()
) {
  // Save context state
  ctx.save();

  // Clear the cursor layer
  // Note: Context is already scaled by DPR in layers.ts, so use CSS pixels here
  ctx.clearRect(0, 0, viewport.width, viewport.height);

  // Only render if cursor exists, editor is focused, and cursor is visible (not blinking)
  if (
    !state.document.cursor ||
    !state.view.isFocused ||
    isCursorBlinking(state.document.cursor, styles)
  ) {
    ctx.restore();
    return;
  }

  // Don't show cursor when there's an active selection
  const hasActiveSelection =
    state.document.selection && !state.document.selection.isCollapsed;
  if (hasActiveSelection) {
    ctx.restore();
    return;
  }

  const cursorBlockIndex = state.document.cursor.position.blockIndex;
  const block = state.document.page.blocks[cursorBlockIndex];

  if (!isTextBlock(block)) {
    ctx.restore();
    return;
  }

  // Calculate block position
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  let currentY = styles.canvas.paddingTop - viewport.scrollY;

  // Calculate Y position of cursor block
  for (let i = 0; i < cursorBlockIndex; i++) {
    const prevBlock = state.document.page.blocks[i];
    const blockHeight = getBlockHeight(prevBlock, maxWidth, styles, i);
    currentY += blockHeight;
  }

  // Optimization: Skip rendering if cursor block is completely outside viewport
  const blockHeight = getBlockHeight(block, maxWidth, styles, cursorBlockIndex);
  if (currentY + blockHeight < 0 || currentY > viewport.height) {
    // Cursor block is not visible in viewport
    ctx.restore();
    return;
  }

  // Get text style and calculate lines for cursor block
  const textStyle = getTextStyle(styles, block.type);
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;

  // Get content with composition text injected (if composing in this block)
  const { content: renderContent, compositionRange } =
    getContentWithComposition(block, state, cursorBlockIndex);

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

  // Find which line the cursor is on
  const content = getBlockTextContent(block);
  const isRTL = getFormattedTextDirection(renderContent) === "rtl";

  let cursorX = styles.canvas.paddingLeft;
  let cursorY = currentY;
  let cursorHeight = fontMetrics.fontSize * textStyle.lineHeight;

  // Calculate the target cursor position (original position + composition length if composing)
  let targetCursorIndex = state.document.cursor.position.textIndex;
  if (compositionRange && state.ui.composition?.isComposing) {
    // During composition, cursor appears at the END of composition text
    targetCursorIndex = compositionRange.end;
  }

  let textIndex = 0;
  for (const wrappedLine of lines) {
    const lineStartIndex = textIndex;
    const lineEndIndex = textIndex + wrappedLine.text.length;

    if (
      targetCursorIndex >= lineStartIndex &&
      targetCursorIndex <= lineEndIndex
    ) {
      cursorY = currentY;
      cursorHeight = fontMetrics.ascent + fontMetrics.descent;

      // Calculate cursor position differently for RTL
      if (isRTL) {
        const widthFromStart = measureFormattedLineWidth(
          renderContent,
          lineStartIndex,
          targetCursorIndex,
          textStyle,
          fontFamily,
          codePadding
        );
        cursorX = styles.canvas.paddingLeft + maxWidth - widthFromStart;
      } else {
        cursorX += measureFormattedLineWidth(
          renderContent,
          lineStartIndex,
          targetCursorIndex,
          textStyle,
          fontFamily,
          codePadding
        );
      }
      break;
    }

    textIndex += wrappedLine.text.length;
    if (wrappedLine.consumedSpace) {
      textIndex += 1;
    }
    currentY += lineHeight;
  }

  // Handle cursor at end of block (only when not composing)
  if (
    !state.ui.composition?.isComposing &&
    state.document.cursor.position.textIndex === content.length &&
    lines.length > 0
  ) {
    const lastLine = lines[lines.length - 1];
    const lastLineIndex = lines.length - 1;

    // Calculate position of last line
    let lastLineY = styles.canvas.paddingTop - viewport.scrollY;
    for (let i = 0; i < cursorBlockIndex; i++) {
      const prevBlock = state.document.page.blocks[i];
      const blockHeight = getBlockHeight(prevBlock, maxWidth, styles, i);
      lastLineY += blockHeight;
    }
    lastLineY += lastLineIndex * lineHeight;

    const lastLineWidth = measureFormattedLineWidth(
      renderContent,
      content.length - lastLine.text.length,
      content.length,
      textStyle,
      fontFamily,
      codePadding
    );

    if (isRTL) {
      cursorX = styles.canvas.paddingLeft + maxWidth - lastLineWidth;
    } else {
      cursorX = styles.canvas.paddingLeft + lastLineWidth;
    }
    cursorY = lastLineY;
    cursorHeight = fontMetrics.ascent + fontMetrics.descent;
  }

  // Draw the cursor
  ctx.fillStyle = styles.cursor.color;
  ctx.fillRect(cursorX, cursorY, styles.cursor.width, cursorHeight);

  // Restore context state
  ctx.restore();
}

/**
 * Render drag handles for a specific image block using exact dimensions
 * This is called from within renderImageBlock to ensure consistency
 */
function renderImageDragHandlesForBlock(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  objectFit: 'cover' | 'contain',
  hoveredHandle: "left" | "right" | "bottom" | null,
  styles: EditorStyles
) {
  const { vertical, horizontal } = styles.imageResize.dragHandles;
  const {
    color: outlineColor,
    width: outlineWidth,
    hoverOpacity: outlineHoverOpacity,
    dashPattern,
  } = styles.imageResize.outline;

  const showBottomHandle = objectFit === "cover"; // Only show bottom handle in cover mode

  ctx.save();

  // Helper to render a single drag bar
  const renderBar = (
    barX: number,
    barY: number,
    barWidth: number,
    barHeight: number,
    isHovered: boolean
  ) => {
    ctx.save();

    // Set opacity based on hover state
    const opacity = isHovered
      ? vertical.hoverOpacity
      : vertical.opacity;
    ctx.globalAlpha = opacity;

    // Draw bar background
    ctx.fillStyle = isHovered
      ? vertical.hoverBackgroundColor
      : vertical.backgroundColor;

    if (vertical.borderRadius > 0) {
      // Draw rounded rectangle
      ctx.beginPath();
      ctx.roundRect(barX, barY, barWidth, barHeight, vertical.borderRadius);
      ctx.fill();
    } else {
      ctx.fillRect(barX, barY, barWidth, barHeight);
    }

    ctx.restore();
  };

  // Left vertical bar (centered vertically with specified length)
  renderBar(
    x + vertical.inset,
    y + (height - vertical.length) / 2,
    vertical.thickness,
    vertical.length,
    hoveredHandle === "left"
  );

  // Right vertical bar (centered vertically with specified length)
  renderBar(
    x + width - vertical.inset - vertical.thickness,
    y + (height - vertical.length) / 2,
    vertical.thickness,
    vertical.length,
    hoveredHandle === "right"
  );

  // Bottom horizontal bar (centered horizontally with specified length)
  // Only render in cover mode
  if (showBottomHandle) {
    renderBar(
      x + (width - horizontal.length) / 2,
      y + height - horizontal.inset - horizontal.thickness,
      horizontal.length,
      horizontal.thickness,
      hoveredHandle === "bottom"
    );
  }

  // Render a subtle dashed outline around the image when hovering any handle
  if (hoveredHandle !== null) {
    ctx.save();
    ctx.globalAlpha = outlineHoverOpacity;
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = outlineWidth;
    ctx.setLineDash(dashPattern as number[]);
    ctx.strokeRect(x, y, width, height);
    ctx.setLineDash([]); // Reset dash pattern
    ctx.restore();
  }

  ctx.restore();
}

