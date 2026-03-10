import type {
  Block,
  Char,
  CharRun,
  FormatSpan,
} from "../deserializer/loadPage";
import { isListBlock, isTextualBlock } from "../deserializer/loadPage";
import {
  batchCRDTChars,
  FONT_STACKS,
  getCurrentFontFamily,
  getFontMetrics,
  measureText,
  wrapCRDTText,
  type FontFamily,
  type TextBatch,
} from "./fonts";
import { renderScrollbar } from "./scrollbar";
import { getBlockTextContent, isCursorBlinking, isTouchDevice } from "./state";
import { getEditorStyles, getTextStyle } from "./styles";
import type { AwarenessState } from "./sync/awareness";
import {
  awarenessCursorToPosition,
  awarenessSelectionToSelection,
} from "./sync/awareness";
import {
  getCharIdFromRun,
  getVisibleTextFromRuns,
  isCharDeleted,
  iterateVisibleChars,
} from "./sync/char-runs";
import type {
  BlockBounds,
  EditorState,
  EditorStyles,
  FontMetrics,
  RenderedBlock,
  RenderedLine,
  SelectionState,
  TextStyle,
  ViewportState,
} from "./types";

/**
 * Convert charRuns to Char[] for compatibility with measurement functions
 */
function charRunsToChars(charRuns: CharRun[] | undefined): Char[] {
  if (!charRuns) return [];
  const chars: Char[] = [];
  for (const run of charRuns) {
    for (let offset = 0; offset < run.text.length; offset++) {
      chars.push({
        id: getCharIdFromRun(run, offset),
        char: run.text[offset],
        deleted: isCharDeleted(run, offset),
      });
    }
  }
  return chars;
}

/**
 * Get visible text from Char[] array (filters out deleted chars)
 */
function getVisibleTextFromChars(chars: Char[]): string {
  return chars
    .filter((c) => !c.deleted)
    .map((c) => c.char)
    .join("");
}

// Helper to inject composition text into block for rendering
function getContentWithComposition(
  block: Block,
  state: EditorState,
  blockIndex: number,
): {
  chars: Char[];
  formats: FormatSpan[];
  compositionRange: { start: number; end: number } | null;
} {
  if (!isTextualBlock(block)) {
    return { chars: [], formats: [], compositionRange: null };
  }

  // Check if composition is active and cursor is in this block
  if (
    !state.ui.composition ||
    !state.ui.composition.isComposing ||
    !state.document.cursor ||
    state.document.cursor.position.blockIndex !== blockIndex
  ) {
    return {
      chars: charRunsToChars(block.charRuns),
      formats: block.formats,
      compositionRange: null,
    };
  }

  const compositionText = state.ui.composition.text;
  if (!compositionText) {
    return {
      chars: charRunsToChars(block.charRuns),
      formats: block.formats,
      compositionRange: null,
    };
  }

  const cursorTextIndex = state.document.cursor.position.textIndex;

  // Create temporary composition chars (without IDs since they're not persisted)
  const compositionChars: Char[] = Array.from(compositionText).map(
    (char, i) => ({
      id: `composition-${i}`,
      char,
      deleted: false,
    }),
  );

  // Insert composition chars at cursor position (visible index)
  const modifiedChars: Char[] = [];
  let visibleIndex = 0;
  let insertionDone = false;

  // Convert charRuns to chars and insert composition
  for (const { id, char } of iterateVisibleChars(block.charRuns)) {
    if (visibleIndex === cursorTextIndex && !insertionDone) {
      // Insert composition chars here
      modifiedChars.push(...compositionChars);
      insertionDone = true;
    }

    modifiedChars.push({ id, char, deleted: false });
    visibleIndex++;
  }

  // If cursor is at the end, append composition
  if (!insertionDone) {
    modifiedChars.push(...compositionChars);
  }

  return {
    chars: modifiedChars,
    formats: block.formats, // Keep formats as-is
    compositionRange: {
      start: cursorTextIndex,
      end: cursorTextIndex + compositionText.length,
    },
  };
}

// Helper to get or calculate block height, storing it on the block
export const getBlockHeight = (
  block: Block,
  maxWidth: number,
  styles: EditorStyles,
  first: boolean,
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
  if (first && block.type === "image") {
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
// Helper function to measure the width of a portion of CRDT text
// Uses batched measurement to preserve Arabic ligatures
function measureCRDTLineWidth(
  chars: Char[],
  formats: FormatSpan[],
  lineStartIndex: number,
  lineEndIndex: number,
  textStyle: TextStyle,
  fontFamily: FontFamily,
  _codePadding: number,
): number {
  // Use batched measurement to preserve Arabic ligatures
  // This is critical for accurate cursor positioning in Arabic text
  const batches = batchCRDTChars(chars, formats, lineStartIndex, lineEndIndex);

  let width = 0;
  for (const batch of batches) {
    const effectiveFontWeight = batch.isBold ? "bold" : textStyle.fontWeight;
    // Measure the entire batch as a string (preserves ligature widths)
    width += measureText(
      batch.text,
      textStyle.fontSize,
      effectiveFontWeight,
      fontFamily,
    );
  }

  return width;
}

// Helper to render underline decoration for composition text
function renderCompositionUnderline(
  ctx: CanvasRenderingContext2D,
  chars: Char[],
  formats: FormatSpan[],
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
  _maxWidth: number,
) {
  // Calculate the overlap between this line and the composition range
  const underlineStart = Math.max(lineStartIndex, compositionStart);
  const underlineEnd = Math.min(lineEndIndex, compositionEnd);

  if (underlineStart >= underlineEnd) return;

  // Measure width from line start to underline start
  const offsetToStart = measureCRDTLineWidth(
    chars,
    formats,
    lineStartIndex,
    underlineStart,
    textStyle,
    fontFamily,
    codePadding,
  );

  // Measure width of the underlined portion
  const underlineWidth = measureCRDTLineWidth(
    chars,
    formats,
    underlineStart,
    underlineEnd,
    textStyle,
    fontFamily,
    codePadding,
  );

  // Calculate underline position
  const underlineY = y + fontMetrics.ascent + 2;
  const underlineThickness = 1.5;

  ctx.save();
  ctx.strokeStyle = textStyle.color;
  ctx.lineWidth = underlineThickness;
  ctx.beginPath();

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

// Note: getFormatKey is now imported from fonts.ts

// Helper function to render a line with CRDT formatting
// Batches consecutive characters with same formatting to preserve Arabic ligatures
function renderCRDTLine(
  ctx: CanvasRenderingContext2D,
  chars: Char[],
  formats: FormatSpan[],
  lineStartIndex: number,
  lineEndIndex: number,
  x: number,
  y: number,
  textStyle: TextStyle,
  fontFamily: FontFamily,
  styles: EditorStyles,
  isRTL: boolean,
) {
  // Set canvas direction
  ctx.direction = isRTL ? "rtl" : "ltr";

  // Batch characters by formatting to preserve Arabic ligatures
  const batches: TextBatch[] = batchCRDTChars(
    chars,
    formats,
    lineStartIndex,
    lineEndIndex,
  );

  // Render each batch
  let currentX = x;

  for (const batch of batches) {
    const effectiveFontWeight = batch.isBold ? "bold" : textStyle.fontWeight;
    const fontStyle = batch.isItalic ? "italic" : "normal";

    ctx.font = `${fontStyle} ${effectiveFontWeight} ${textStyle.fontSize}px ${FONT_STACKS[fontFamily]}`;
    ctx.textBaseline = "alphabetic";

    // Measure the entire batch text width
    const textWidth = ctx.measureText(batch.text).width;
    const visualX = currentX;

    // Handle code background
    if (batch.isCode) {
      const codeStyle = styles.textFormats.code;
      const padding = codeStyle.padding;

      ctx.save();
      ctx.fillStyle = codeStyle.backgroundColor;

      let rectX: number;
      if (isRTL) {
        rectX = visualX - textWidth - padding;
      } else {
        rectX = visualX - padding;
      }

      const rectY = y - textStyle.fontSize - padding;
      const rectWidth = textWidth + padding * 2;
      const rectHeight = textStyle.fontSize * textStyle.lineHeight;

      ctx.beginPath();
      ctx.roundRect(
        rectX,
        rectY,
        rectWidth,
        rectHeight,
        codeStyle.borderRadius,
      );
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = codeStyle.color;
    } else if (batch.isLink) {
      ctx.fillStyle = styles.textFormats.link.color;
    } else {
      ctx.fillStyle = textStyle.color;
    }

    // Render the entire batch text at once (preserves Arabic ligatures)
    ctx.fillText(batch.text, visualX, y);

    // Handle underline for links
    if (batch.isLink) {
      const linkStyle = styles.textFormats.link;
      ctx.save();
      ctx.strokeStyle = linkStyle.color;
      ctx.lineWidth = linkStyle.underlineThickness;
      ctx.beginPath();

      if (isRTL) {
        ctx.moveTo(visualX - textWidth, y + textStyle.fontSize * 0.1);
        ctx.lineTo(visualX, y + textStyle.fontSize * 0.1);
      } else {
        ctx.moveTo(visualX, y + textStyle.fontSize * 0.1);
        ctx.lineTo(visualX + textWidth, y + textStyle.fontSize * 0.1);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Handle strikethrough
    if (batch.isStrikethrough) {
      ctx.save();
      ctx.strokeStyle = textStyle.color;
      ctx.lineWidth = Math.max(1, textStyle.fontSize / 16);
      ctx.beginPath();

      if (isRTL) {
        ctx.moveTo(visualX - textWidth, y - textStyle.fontSize * 0.3);
        ctx.lineTo(visualX, y - textStyle.fontSize * 0.3);
      } else {
        ctx.moveTo(visualX, y - textStyle.fontSize * 0.3);
        ctx.lineTo(visualX + textWidth, y - textStyle.fontSize * 0.3);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Advance position
    if (isRTL) {
      currentX -= textWidth;
    } else {
      currentX += textWidth;
    }
  }

  // Reset direction
  ctx.direction = "ltr";
}

export const renderPage = (
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  viewport: ViewportState,
  visibility: { start: number; end: number },
  styles: EditorStyles = getEditorStyles(),
  remoteAwareness: Map<string, AwarenessState>,
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
  const documentHeight = viewport.documentHeight;

  // Render each visible block
  const visibleBlocks = state.view.visibleBlocks;
  let foundVisibleBlock = false;

  for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
    const block = visibleBlocks[visibleIdx];

    // Get or calculate block height (cached on the block itself)
    const blockHeight = getBlockHeight(
      block,
      maxWidth,
      styles,
      visibleIdx === 0,
    );

    // Only render if block is visible in viewport
    if (isBlockVisible(currentY, blockHeight, viewport)) {
      if (!foundVisibleBlock) {
        visibility.start = visibleIdx;
        foundVisibleBlock = true;
      }
      visibility.end = visibleIdx;

      const renderedBlock = renderBlock(
        ctx,
        state,
        block,
        block.originalIndex,
        styles.canvas.paddingLeft,
        currentY,
        maxWidth,
        styles,
        remoteAwareness,
      );
      renderedBlocks.push(renderedBlock);
    } else if (foundVisibleBlock) {
      // We've passed the visible range, no need to continue
      break;
    }
    currentY += blockHeight;
  }

  // Add extra padding on mobile devices for keyboard space
  // documentHeight += styles.canvas.paddingBottom;

  // Render selection handles for mobile (after selection rendering, before scrollbar)
  renderSelectionHandles(ctx, state, viewport, styles);

  // Render scrollbar
  renderScrollbar(ctx, viewport, documentHeight, state, remoteAwareness);

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
  styles: EditorStyles = getEditorStyles(),
  remoteAwareness?: Map<string, AwarenessState>,
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
      styles,
      remoteAwareness,
    );
  }

  // Handle line/divider blocks
  if (block.type === "line") {
    return renderLineBlock(
      ctx,
      state,
      block,
      blockIndex,
      x,
      y,
      maxWidth,
      styles,
      remoteAwareness,
    );
  }

  const textStyle = getTextStyle(styles, block.type);
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;

  // Calculate indent and marker space for list blocks
  let indentOffset = 0;
  let markerWidth = 0;
  let adjustedX = x;
  let adjustedMaxWidth = maxWidth;
  let markerX = x; // X position where marker should be rendered

  // Get content early to detect RTL for proper layout
  const {
    chars: renderChars,
    formats: renderFormats,
    compositionRange,
  } = getContentWithComposition(block, state, blockIndex);

  // Detect text direction
  const visibleText = getVisibleTextFromRuns(block.charRuns);
  const direction =
    visibleText.length > 0 &&
    /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(visibleText)
      ? "rtl"
      : "ltr";
  const isRTL = direction === "rtl";

  if (isListBlock(block)) {
    const indent = block.indent || 0;
    indentOffset = indent * styles.list.indent.size;

    // Use consistent marker width for all list types to ensure text alignment
    // All list types reserve the same space (minWidth + textGap)
    markerWidth = styles.list.numbered.minWidth + styles.list.marker.textGap;

    adjustedMaxWidth = maxWidth - indentOffset - markerWidth;

    if (isRTL) {
      // RTL: [TEXT_AREA][MARKER][INDENT]
      // Text area starts at left, marker after text, indent space on the right
      adjustedX = x;
      markerX = x + adjustedMaxWidth;
    } else {
      // LTR: [MARKER][TEXT_AREA]
      // Marker on left, text area on the right
      markerX = x + indentOffset;
      adjustedX = x + indentOffset + markerWidth;
    }
  }

  // Calculate line wrapping using CRDT data
  // Use adjusted max width for list blocks to account for indent and marker
  // Convert charRuns to chars for measurement functions
  const charsForWrapping = renderChars || charRunsToChars(block.charRuns);
  const lines = wrapCRDTText(
    charsForWrapping,
    renderFormats || block.formats,
    adjustedMaxWidth,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    codePadding,
    compositionRange,
  );

  const fontMetrics = getFontMetrics(
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
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

    // Adjust x position for RTL text rendering
    const renderX = isRTL ? adjustedX + adjustedMaxWidth : adjustedX;

    // Render list marker only on the first line
    if (lineIndex === 0 && isListBlock(block)) {
      renderListMarker(
        ctx,
        block,
        markerX,
        currentY,
        fontMetrics,
        textStyle,
        styles,
        state,
        blockIndex,
        markerWidth,
      );
    }

    // Render the line with formatting (using CRDT data with composition)
    renderCRDTLine(
      ctx,
      renderChars,
      renderFormats,
      lineStartIndex,
      lineEndIndex,
      renderX,
      currentY + fontMetrics.ascent,
      textStyle,
      fontFamily,
      styles,
      isRTL,
    );

    // Render composition underline if this line contains composition text
    if (compositionRange) {
      const lineContainsComposition =
        lineStartIndex < compositionRange.end &&
        lineEndIndex > compositionRange.start;

      if (lineContainsComposition) {
        renderCompositionUnderline(
          ctx,
          renderChars,
          renderFormats,
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
          isRTL,
          maxWidth,
        );
      }
    }

    // Use font metrics for consistent positioning
    const textHeight = fontMetrics.ascent + fontMetrics.descent;

    // Measure the line width (need to account for formatting)
    const lineWidth = measureCRDTLineWidth(
      renderChars,
      renderFormats,
      lineStartIndex,
      lineEndIndex,
      textStyle,
      fontFamily,
      codePadding,
    );

    // Store rendered line
    const renderedLine: RenderedLine = {
      text: line,
      x: adjustedX,
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

  // Render remote selections first (so they appear behind local selection)
  if (remoteAwareness && remoteAwareness.size > 0) {
    renderRemoteSelections(
      state,
      blockIndex,
      ctx,
      styles,
      renderedLines,
      adjustedX,
      y,
      fullContent,
      textStyle,
      fontFamily,
      block,
      adjustedMaxWidth,
      remoteAwareness,
    );
  }

  // Handle local selection rendering
  if (state.document.selection && !state.document.selection.isCollapsed) {
    renderSelection(
      state,
      blockIndex,
      ctx,
      styles,
      renderedLines,
      adjustedX,
      y,
      fullContent,
      textStyle,
      fontFamily,
      block,
      adjustedMaxWidth,
    );
  }

  // Don't show placeholder or cursor when there's an active selection
  const hasActiveSelection =
    state.document.selection && !state.document.selection.isCollapsed;

  // Handle placeholder rendering (not in readonly mode)
  if (
    state.document.cursor &&
    state.document.cursor.position.blockIndex === blockIndex &&
    fullContent.length === 0 &&
    !state.ui.composition &&
    !hasActiveSelection &&
    state.ui.mode === "edit"
  ) {
    renderPlaceholder(
      ctx,
      adjustedX,
      y + fontMetrics.ascent,
      styles,
      textStyle,
      block.type,
      state,
    );
  }

  // NOTE: Cursor rendering is now handled by the separate cursor layer
  // This prevents double-rendering of the cursor during composition (IME input)

  // Create block bounds
  const blockBounds: BlockBounds = {
    x: adjustedX,
    y,
    width: adjustedMaxWidth,
    height: lines.length * lineHeight,
  };

  return {
    block,
    bounds: blockBounds,
    lines: renderedLines,
  };
}; // Calculate position from mouse coordinates dynamically

// Helper function to calculate the item number for a numbered list
function calculateListItemNumber(
  state: EditorState,
  blockIndex: number,
): number {
  const currentBlock = state.document.page.blocks[blockIndex];
  if (!currentBlock || currentBlock.deleted) return 0;
  if (!isListBlock(currentBlock) || currentBlock.type !== "numbered_list") {
    return 1;
  }

  const currentIndent = currentBlock.indent;
  let number = 1;

  // Count backwards to find previous numbered list items at the same indent level
  // Only consider visible blocks
  const visibleBlocks = state.view.visibleBlocks;
  const allBlocks = state.document.page.blocks;

  // Find visible blocks before the current block
  for (let i = visibleBlocks.length - 1; i >= 0; i--) {
    const visibleBlock = visibleBlocks[i];
    const visibleBlockIndex = allBlocks.findIndex(
      (b) => b.id === visibleBlock.id,
    );

    // Only consider blocks before the current block
    if (visibleBlockIndex >= blockIndex) continue;

    const prevBlock = visibleBlock;

    // Stop if we hit a non-list block or different list type
    if (!isListBlock(prevBlock) || prevBlock.type !== "numbered_list") {
      break;
    }

    // Stop if indent level changed (higher or lower)
    if (prevBlock.indent !== currentIndent) {
      break;
    }

    // Increment number for each item at same indent
    number++;
  }

  // Reverse the count to get the actual number
  return blockIndex - (blockIndex - number + 1) + 1;
}

// Render list marker (bullet, number, or checkbox)
function renderListMarker(
  ctx: CanvasRenderingContext2D,
  block: Block,
  x: number,
  y: number,
  fontMetrics: FontMetrics,
  textStyle: TextStyle,
  styles: EditorStyles,
  state: EditorState,
  blockIndex: number,
  _markerWidth: number,
) {
  if (!isListBlock(block)) return;

  const fontFamily = getCurrentFontFamily();

  if (block.type === "bullet_list") {
    // Render bullet character
    ctx.save();
    ctx.fillStyle = styles.list.bullet.color;
    ctx.font = `${textStyle.fontWeight} ${styles.list.bullet.size}px ${FONT_STACKS[fontFamily]}`;
    ctx.textBaseline = "alphabetic";

    // Position bullet - x is already the correct position (left for LTR, right for RTL)
    const bulletX = x + 6;

    ctx.fillText(styles.list.bullet.character, bulletX, y + fontMetrics.ascent);
    ctx.restore();
  } else if (block.type === "numbered_list") {
    // Calculate and render number
    const number = calculateListItemNumber(state, blockIndex);
    const numberText = `${number}.`;

    ctx.save();
    ctx.fillStyle = styles.list.numbered.color;
    ctx.font = `${textStyle.fontWeight} ${textStyle.fontSize}px ${FONT_STACKS[fontFamily]}`;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "right";

    // Position number - x is already the correct position, right-align within marker space
    ctx.fillText(numberText, x + 18, y + fontMetrics.ascent);

    ctx.textAlign = "left"; // Reset
    ctx.restore();
  } else if (block.type === "todo_list") {
    // Render checkbox
    const checkboxSize = styles.list.todo.checkboxSize;
    const checkboxY = y + fontMetrics.ascent - checkboxSize + 2; // Align with text baseline

    // Position checkbox - x is already the correct position
    const checkboxX = x + 2;

    ctx.save();

    // Draw checkbox background and border
    ctx.strokeStyle = styles.list.todo.checkboxBorderColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(
      checkboxX,
      checkboxY,
      checkboxSize,
      checkboxSize,
      styles.list.todo.checkboxBorderRadius,
    );
    ctx.stroke();

    // Fill checkbox if checked
    if (block.checked) {
      ctx.fillStyle = styles.list.todo.checkboxCheckedColor;
      ctx.fill();

      // Draw checkmark
      ctx.strokeStyle = styles.list.todo.checkmarkColor;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      const checkmarkPadding = 3;
      const checkX = checkboxX + checkmarkPadding;
      const checkY = checkboxY + checkmarkPadding;
      const checkWidth = checkboxSize - checkmarkPadding * 2;
      const checkHeight = checkboxSize - checkmarkPadding * 2;

      ctx.beginPath();
      ctx.moveTo(checkX, checkY + checkHeight / 2);
      ctx.lineTo(checkX + checkWidth / 3, checkY + checkHeight - 1);
      ctx.lineTo(checkX + checkWidth, checkY + 1);
      ctx.stroke();
    }

    ctx.restore();
  }
}

function renderPlaceholder(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  styles: EditorStyles,
  textStyle: TextStyle,
  blockType:
    | "heading1"
    | "heading2"
    | "heading3"
    | "paragraph"
    | "bullet_list"
    | "numbered_list"
    | "todo_list",
  state: EditorState,
) {
  ctx.save();
  ctx.fillStyle = styles.placeholder.color;
  ctx.globalAlpha = styles.placeholder.opacity;
  ctx.font = `${textStyle.fontWeight} ${textStyle.fontSize}px ${
    FONT_STACKS[getCurrentFontFamily()]
  }`;
  ctx.textBaseline = "alphabetic";

  let placeholderText = "";

  // Handle list block placeholders
  if (blockType === "bullet_list") {
    placeholderText = "List item";
  } else if (blockType === "numbered_list") {
    placeholderText = "List item";
  } else if (blockType === "todo_list") {
    placeholderText = "To-do item";
  } else {
    // Handle text block placeholders
    const placeholderConfig = styles.placeholder[blockType];

    // Determine if we should show touch-optimized text
    // Show touch text only if device has touch AND no physical keyboard
    const isTouch = isTouchDevice();
    const hasPhysicalKeyboard = state.view.hasPhysicalKeyboard;
    const isTouchOnly = isTouch && !hasPhysicalKeyboard;

    if (blockType === "paragraph") {
      if (isTouchOnly) {
        placeholderText = styles.placeholder.paragraph.touchCompatiableText;
      } else {
        placeholderText = styles.placeholder.paragraph.keyboardCompatibleText;
      }
    } else if ("text" in placeholderConfig) {
      placeholderText = placeholderConfig.text;
    }
  }

  ctx.fillText(placeholderText, x, y);
  ctx.restore();
}

/**
 * Core selection rendering logic shared between local and remote selections.
 * This function handles all the complexity of calculating selection bounds
 * including RTL support, multi-block selections, and empty blocks.
 */
function renderSelectionCore(
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
  maxWidth: number,
  selection: { anchor: any; focus: any; isForward: boolean },
  fillStyle: string,
  opacity: number,
) {
  if (!isTextualBlock(block)) {
    return;
  }

  // Sort anchor and focus to ensure start is always before end
  let start = selection.isForward ? selection.anchor : selection.focus;
  let end = selection.isForward ? selection.focus : selection.anchor;

  // Detect if this is an RTL block
  const blockVisibleText = getVisibleTextFromRuns(block.charRuns);
  const isRTL =
    blockVisibleText.length > 0 &&
    /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(blockVisibleText);

  if (
    (start.blockIndex === blockIndex && end.blockIndex === blockIndex) ||
    (start.blockIndex <= blockIndex && end.blockIndex >= blockIndex)
  ) {
    ctx.save();
    ctx.fillStyle = fillStyle;
    ctx.globalAlpha = opacity;

    const lineHeight = textStyle.fontSize * textStyle.lineHeight;
    const codePadding = styles.textFormats.code.padding;

    // Handle empty blocks
    if (content.length === 0 && renderedLines.length === 1) {
      const fontMetrics = getFontMetrics(
        textStyle.fontSize,
        textStyle.fontWeight,
        fontFamily,
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
            const selStartTextIndex = Math.max(
              line.startIndex,
              start.textIndex,
            );
            const selEndTextIndex = Math.min(line.endIndex, end.textIndex);

            const blockChars = charRunsToChars(block.charRuns);
            const widthToSelStart = measureCRDTLineWidth(
              blockChars,
              block.formats,
              line.startIndex,
              selStartTextIndex,
              textStyle,
              fontFamily,
              codePadding,
            );

            const widthToSelEnd = measureCRDTLineWidth(
              blockChars,
              block.formats,
              line.startIndex,
              selEndTextIndex,
              textStyle,
              fontFamily,
              codePadding,
            );

            selectionEndX = x + maxWidth - widthToSelStart;
            selectionStartX = x + maxWidth - widthToSelEnd;
          } else {
            // LTR logic
            const blockChars = charRunsToChars(block.charRuns);
            if (start.textIndex > line.startIndex) {
              selectionStartX += measureCRDTLineWidth(
                blockChars,
                block.formats,
                line.startIndex,
                start.textIndex,
                textStyle,
                fontFamily,
                codePadding,
              );
            }
            if (end.textIndex < line.endIndex) {
              const selectedWidth = measureCRDTLineWidth(
                blockChars,
                block.formats,
                Math.max(line.startIndex, start.textIndex),
                Math.min(line.endIndex, end.textIndex),
                textStyle,
                fontFamily,
                codePadding,
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
            const selStartTextIndex = Math.max(
              line.startIndex,
              start.textIndex,
            );

            const blockChars = charRunsToChars(block.charRuns);
            const widthToSelStart = measureCRDTLineWidth(
              blockChars,
              block.formats,
              line.startIndex,
              selStartTextIndex,
              textStyle,
              fontFamily,
              codePadding,
            );

            selectionEndX = x + maxWidth - widthToSelStart;
            selectionStartX = x + maxWidth - line.width;
          } else {
            const blockChars = charRunsToChars(block.charRuns);
            if (start.textIndex > line.startIndex) {
              selectionStartX += measureCRDTLineWidth(
                blockChars,
                block.formats,
                line.startIndex,
                start.textIndex,
                textStyle,
                fontFamily,
                codePadding,
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
            const selEndTextIndex = Math.min(line.endIndex, end.textIndex);

            const blockChars = charRunsToChars(block.charRuns);
            const widthToSelEnd = measureCRDTLineWidth(
              blockChars,
              block.formats,
              line.startIndex,
              selEndTextIndex,
              textStyle,
              fontFamily,
              codePadding,
            );

            selectionEndX = x + maxWidth;
            selectionStartX = x + maxWidth - widthToSelEnd;
          } else {
            const blockChars = charRunsToChars(block.charRuns);
            if (end.textIndex < line.endIndex) {
              selectionEndX =
                x +
                measureCRDTLineWidth(
                  blockChars,
                  block.formats,
                  line.startIndex,
                  end.textIndex,
                  textStyle,
                  fontFamily,
                  codePadding,
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
          lineHeight,
        );
      }
    }

    ctx.restore();
  }
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
  maxWidth: number,
) {
  if (!state.document.selection) return;

  renderSelectionCore(
    blockIndex,
    ctx,
    styles,
    renderedLines,
    x,
    y,
    content,
    textStyle,
    fontFamily,
    block,
    maxWidth,
    state.document.selection,
    styles.selection.backgroundColor,
    styles.selection.opacity,
  );
}

/**
 * Render a single remote user's selection with their assigned color.
 */
function renderRemoteSelection(
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
  maxWidth: number,
  selection: SelectionState,
  color: string,
) {
  renderSelectionCore(
    blockIndex,
    ctx,
    styles,
    renderedLines,
    x,
    y,
    content,
    textStyle,
    fontFamily,
    block,
    maxWidth,
    selection,
    color,
    0.2, // More transparent for remote selections
  );
}

/**
 * Render all remote selections for the current block.
 */
function renderRemoteSelections(
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
  maxWidth: number,
  remoteAwareness: Map<string, AwarenessState>,
) {
  for (const [_peerId, awareness] of remoteAwareness) {
    if (!awareness.selection) continue;

    // Convert awareness selection to editor selection
    const selection = awarenessSelectionToSelection(
      awareness.selection,
      state.document.page,
    );
    if (!selection) continue;

    // Check if the selection is collapsed (shouldn't render)
    if (selection.isCollapsed) continue;

    renderRemoteSelection(
      blockIndex,
      ctx,
      styles,
      renderedLines,
      x,
      y,
      content,
      textStyle,
      fontFamily,
      block,
      maxWidth,
      selection,
      awareness.user.color,
    );
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
  styles: EditorStyles,
  remoteAwareness?: Map<string, AwarenessState>,
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
      adjustedY + adjustedHeight / 2,
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
      adjustedY + adjustedHeight / 2,
    );
    ctx.fillText(
      styles.blocks.image.error.retryText,
      displayX + displayWidth / 2,
      adjustedY + adjustedHeight / 2 + 20,
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
        adjustedY + adjustedHeight / 2,
      );
      ctx.fillText(
        styles.blocks.image.error.retryText,
        displayX + displayWidth / 2,
        adjustedY + adjustedHeight / 2 + 20,
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
          destHeight, // Destination rectangle
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
          adjustedY + adjustedHeight / 2,
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
      adjustedY + adjustedHeight / 2,
    );
  }

  // Render remote selection overlays first (so they appear behind local selection)
  if (remoteAwareness && remoteAwareness.size > 0) {
    for (const [_peerId, awareness] of remoteAwareness) {
      if (!awareness.selection) continue;

      const selection = awarenessSelectionToSelection(
        awareness.selection,
        state.document.page,
      );
      if (!selection) continue;

      // For visual blocks, check if this specific block is selected
      // (visual block selections have anchor === focus on the block)
      const isVisualBlockSelected =
        selection.anchor.blockIndex === blockIndex &&
        selection.focus.blockIndex === blockIndex;

      // For multi-block selections that include this block
      const { anchor, focus } = selection;
      const start = anchor.blockIndex <= focus.blockIndex ? anchor : focus;
      const end = anchor.blockIndex <= focus.blockIndex ? focus : anchor;
      const isInMultiBlockSelection =
        !selection.isCollapsed &&
        blockIndex >= start.blockIndex &&
        blockIndex <= end.blockIndex;

      if (isVisualBlockSelected || isInMultiBlockSelection) {
        ctx.save();
        ctx.fillStyle = awareness.user.color;
        ctx.globalAlpha = 0.2; // More transparent for remote selections
        ctx.fillRect(displayX, adjustedY, displayWidth, adjustedHeight);
        ctx.restore();
      }
    }
  }

  // Render selection overlay if this image block is selected (local)
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
    ((state.ui.imageHover && state.ui.imageHover.blockIndex === blockIndex) ||
      (state.ui.imageDrag && state.ui.imageDrag.blockIndex === blockIndex)) &&
    !!block.url;

  if (shouldRenderDragHandles) {
    let hoveredHandle: "left" | "right" | "bottom" | null = null;

    if (state.ui.imageDrag && state.ui.imageDrag.blockIndex === blockIndex) {
      hoveredHandle = state.ui.imageDrag.handle;
    } else if (
      state.ui.imageHover &&
      state.ui.imageHover.blockIndex === blockIndex
    ) {
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
      styles,
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

// Render line/divider block
function renderLineBlock(
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  block: Block,
  blockIndex: number,
  x: number,
  y: number,
  maxWidth: number,
  styles: EditorStyles,
  remoteAwareness?: Map<string, AwarenessState>,
): RenderedBlock {
  if (block.type !== "line") {
    throw new Error("renderLineBlock called on non-line block");
  }

  const lineStyles = styles.blocks.line;
  const lineY = y + lineStyles.paddingTop;

  ctx.save();
  ctx.fillStyle = lineStyles.color;
  ctx.fillRect(x, lineY, maxWidth, lineStyles.lineHeight);
  ctx.restore();

  // Render remote selection overlays first (so they appear behind local selection)
  if (remoteAwareness && remoteAwareness.size > 0) {
    for (const [_peerId, awareness] of remoteAwareness) {
      if (!awareness.selection) continue;

      const selection = awarenessSelectionToSelection(
        awareness.selection,
        state.document.page,
      );
      if (!selection) continue;

      // For visual blocks, check if this specific block is selected
      // (visual block selections have anchor === focus on the block)
      const isVisualBlockSelected =
        selection.anchor.blockIndex === blockIndex &&
        selection.focus.blockIndex === blockIndex;

      // For multi-block selections that include this block
      const { anchor, focus } = selection;
      const start = anchor.blockIndex <= focus.blockIndex ? anchor : focus;
      const end = anchor.blockIndex <= focus.blockIndex ? focus : anchor;
      const isInMultiBlockSelection =
        !selection.isCollapsed &&
        blockIndex >= start.blockIndex &&
        blockIndex <= end.blockIndex;

      if (isVisualBlockSelected || isInMultiBlockSelection) {
        ctx.save();
        ctx.fillStyle = awareness.user.color;
        ctx.globalAlpha = 0.2; // More transparent for remote selections
        ctx.fillRect(x, y, maxWidth, lineStyles.height);
        ctx.restore();
      }
    }
  }

  // Render selection overlay if this line block is selected
  if (state.document.selection && !state.document.selection.isCollapsed) {
    const { anchor, focus } = state.document.selection;
    const start = anchor.blockIndex <= focus.blockIndex ? anchor : focus;
    const end = anchor.blockIndex <= focus.blockIndex ? focus : anchor;

    const isSelected =
      blockIndex >= start.blockIndex && blockIndex <= end.blockIndex;

    if (isSelected) {
      ctx.save();
      ctx.fillStyle = styles.selection.backgroundColor;
      ctx.globalAlpha = styles.selection.opacity;
      ctx.fillRect(x, y, maxWidth, lineStyles.height);
      ctx.restore();
    }
  }

  const blockBounds: BlockBounds = {
    x,
    y,
    width: maxWidth,
    height: lineStyles.height,
  };

  return {
    block,
    bounds: blockBounds,
    lines: [], // Line blocks don't have text lines
  };
}

// Calculate block height dynamically based on content and max width
export const calculateBlockHeight = (
  block: Block,
  maxWidth: number,
  styles: EditorStyles,
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

  // Handle line/divider blocks
  if (block.type === "line") {
    return styles.blocks.line.height;
  }

  if (!isTextualBlock(block)) {
    return 0;
  }

  const textStyle = getTextStyle(styles, block.type);
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;

  // Calculate adjusted width for list blocks
  let adjustedMaxWidth = maxWidth;
  if (isListBlock(block)) {
    const indent = block.indent || 0;
    const indentOffset = indent * styles.list.indent.size;

    // Use consistent marker width for all list types to ensure text alignment
    const markerWidth =
      styles.list.numbered.minWidth + styles.list.marker.textGap;

    adjustedMaxWidth = maxWidth - indentOffset - markerWidth;
  }

  // Use CRDT wrapping
  const blockChars = charRunsToChars(block.charRuns);
  const lines = wrapCRDTText(
    blockChars,
    block.formats,
    adjustedMaxWidth,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    codePadding,
  );

  const fontMetrics = getFontMetrics(
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
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
  viewport: { scrollY: number; height: number },
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
 * Core cursor position calculation logic shared between local and remote cursors.
 * Returns the x, y coordinates and height of the cursor.
 */
function calculateCursorPosition(
  position: { blockIndex: number; textIndex: number },
  block: Block,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles,
  compositionRange: { start: number; end: number } | null = null,
  renderChars?: Char[],
  renderFormats?: FormatSpan[],
): { x: number; y: number; height: number } | null {
  if (!isTextualBlock(block)) return null;

  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  // Calculate block position
  let currentY = styles.canvas.paddingTop - viewport.scrollY;
  const visibleBlocks = state.view.visibleBlocks;

  for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
    const visibleBlock = visibleBlocks[visibleIdx];
    if (visibleBlock.originalIndex >= position.blockIndex) break;

    const blockHeight = getBlockHeight(
      visibleBlock,
      maxWidth,
      styles,
      visibleIdx === 0,
    );
    currentY += blockHeight;
  }

  // Get text style
  const textStyle = getTextStyle(styles, block.type);
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;

  // Calculate indent and marker space for list blocks
  let indentOffset = 0;
  let markerWidth = 0;
  let adjustedMaxWidth = maxWidth;

  if (isListBlock(block)) {
    const indent = block.indent || 0;
    indentOffset = indent * styles.list.indent.size;
    markerWidth = styles.list.numbered.minWidth + styles.list.marker.textGap;
    adjustedMaxWidth = maxWidth - indentOffset - markerWidth;
  }

  // Use provided chars/formats or default to block's
  const chars = renderChars ?? charRunsToChars(block.charRuns);
  const formats = renderFormats ?? block.formats;

  const lines = wrapCRDTText(
    chars,
    formats,
    adjustedMaxWidth,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    codePadding,
    compositionRange,
  );

  const fontMetrics = getFontMetrics(
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
  );
  const lineHeight = fontMetrics.fontSize * textStyle.lineHeight;

  // Calculate cursor position
  const visibleText = getVisibleTextFromChars(chars);
  const isRTL =
    visibleText.length > 0 &&
    /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(visibleText);

  let baseX: number;
  if (isListBlock(block)) {
    if (isRTL) {
      // RTL: indent is on the right side, text starts at left
      baseX = styles.canvas.paddingLeft;
    } else {
      baseX = styles.canvas.paddingLeft + indentOffset + markerWidth;
    }
  } else {
    baseX = styles.canvas.paddingLeft;
  }

  let cursorX = baseX;
  let cursorY = currentY;
  let cursorHeight = fontMetrics.fontSize * textStyle.lineHeight;

  const targetCursorIndex = Math.min(position.textIndex, visibleText.length);

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

      if (isRTL) {
        const widthFromStart = measureCRDTLineWidth(
          chars,
          formats,
          lineStartIndex,
          targetCursorIndex,
          textStyle,
          fontFamily,
          codePadding,
        );
        cursorX = baseX + adjustedMaxWidth - widthFromStart;
      } else {
        cursorX =
          baseX +
          measureCRDTLineWidth(
            chars,
            formats,
            lineStartIndex,
            targetCursorIndex,
            textStyle,
            fontFamily,
            codePadding,
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

  return { x: cursorX, y: cursorY, height: cursorHeight };
}

/**
 * Render remote user cursors.
 * Each cursor is drawn with the peer's color.
 */
interface OutOfViewPeer {
  awareness: AwarenessState;
  direction: "above" | "below";
  x: number;
}

function renderOutOfViewIndicators(
  ctx: CanvasRenderingContext2D,
  peers: OutOfViewPeer[],
  viewport: ViewportState,
  topOffset: number = 0,
) {
  const abovePeers = peers.filter((p) => p.direction === "above");
  const belowPeers = peers.filter((p) => p.direction === "below");

  const pillHeight = 24;
  const pillPadding = 8;
  const fontSize = 12;
  const chevronSize = 6;
  const gap = 8;

  ctx.font = `600 ${fontSize}px ${FONT_STACKS.poppins}`;

  // Render indicators for peers above viewport
  abovePeers.forEach((peer, i) => {
    const initial = peer.awareness.user.name?.charAt(0).toUpperCase() || "?";
    const textWidth = ctx.measureText(initial).width;
    const pillWidth = textWidth + pillPadding * 2;

    const x = pillPadding + i * (pillWidth + gap);
    const y = topOffset + pillPadding + chevronSize;

    // Draw chevron pointing up
    ctx.fillStyle = peer.awareness.user.color;
    ctx.beginPath();
    ctx.moveTo(x + pillWidth / 2, y - chevronSize);
    ctx.lineTo(x + pillWidth / 2 - chevronSize, y);
    ctx.lineTo(x + pillWidth / 2 + chevronSize, y);
    ctx.closePath();
    ctx.fill();

    // Draw pill background
    ctx.beginPath();
    ctx.roundRect(x, y, pillWidth, pillHeight, pillHeight / 2);
    ctx.fill();

    // Draw initial
    ctx.fillStyle = "#FFFFFF";
    ctx.textBaseline = "middle";
    ctx.fillText(initial, x + pillPadding, y + pillHeight / 2);
  });

  // Render indicators for peers below viewport
  belowPeers.forEach((peer, i) => {
    const initial = peer.awareness.user.name?.charAt(0).toUpperCase() || "?";
    const textWidth = ctx.measureText(initial).width;
    const pillWidth = textWidth + pillPadding * 2;

    const x = pillPadding + i * (pillWidth + gap);
    const y = viewport.height - pillPadding - pillHeight - chevronSize;

    // Draw pill background
    ctx.fillStyle = peer.awareness.user.color;
    ctx.beginPath();
    ctx.roundRect(x, y, pillWidth, pillHeight, pillHeight / 2);
    ctx.fill();

    // Draw chevron pointing down
    ctx.beginPath();
    ctx.moveTo(x + pillWidth / 2, y + pillHeight + chevronSize);
    ctx.lineTo(x + pillWidth / 2 - chevronSize, y + pillHeight);
    ctx.lineTo(x + pillWidth / 2 + chevronSize, y + pillHeight);
    ctx.closePath();
    ctx.fill();

    // Draw initial
    ctx.fillStyle = "#FFFFFF";
    ctx.textBaseline = "middle";
    ctx.fillText(initial, x + pillPadding, y + pillHeight / 2);
  });
}

function renderRemoteCursors(
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles,
  remoteAwareness: Map<string, AwarenessState>,
) {
  const outOfViewPeers: OutOfViewPeer[] = [];

  for (const [_peerId, awareness] of remoteAwareness) {
    // Skip if no cursor
    if (!awareness.cursor) continue;

    // Skip if there is a selection (show selection highlight, not caret)
    if (awareness.selection) continue;

    // Convert awareness cursor (blockId) to editor position (blockIndex)
    const position = awarenessCursorToPosition(
      awareness.cursor,
      state.document.page,
    );
    if (!position) continue;

    const block = state.document.page.blocks[position.blockIndex];
    if (!block || block.deleted || !isTextualBlock(block)) continue;

    const cursorPos = calculateCursorPosition(
      position,
      block,
      state,
      viewport,
      styles,
    );
    if (!cursorPos) continue;

    // Check if cursor is out of viewport (account for top padding where tags may overlay)
    if (cursorPos.y + cursorPos.height < styles.canvas.paddingTop) {
      outOfViewPeers.push({ awareness, direction: "above", x: cursorPos.x });
      continue;
    }
    if (cursorPos.y > viewport.height) {
      outOfViewPeers.push({ awareness, direction: "below", x: cursorPos.x });
      continue;
    }

    // Draw the remote cursor with the peer's color
    ctx.fillStyle = awareness.user.color;
    ctx.fillRect(
      cursorPos.x,
      cursorPos.y,
      styles.cursor.width,
      cursorPos.height,
    );

    // Optionally draw a name label above the cursor
    if (awareness.user.name) {
      const labelPadding = 2;
      const labelFontSize = 10;
      ctx.font = `${labelFontSize}px ${FONT_STACKS.poppins}`;
      const labelWidth =
        ctx.measureText(awareness.user.name).width + labelPadding * 2;
      const labelHeight = labelFontSize + labelPadding * 2;

      // Clamp label position to stay within canvas bounds
      let labelX = cursorPos.x;
      let labelY = cursorPos.y - labelHeight - 2;

      // Prevent going off the right edge
      if (labelX + labelWidth > viewport.width) {
        labelX = viewport.width - labelWidth;
      }
      // Prevent going off the left edge
      if (labelX < 0) {
        labelX = 0;
      }
      // Prevent going into the top padding area (where tags overlay)
      if (labelY < styles.canvas.paddingTop) {
        labelY = styles.canvas.paddingTop;
      }

      // Draw label background
      ctx.fillStyle = awareness.user.color;
      ctx.beginPath();
      ctx.roundRect(
        labelX,
        labelY,
        labelWidth,
        labelHeight,
        2,
      );
      ctx.fill();

      // Draw label text
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(
        awareness.user.name,
        labelX + labelPadding,
        labelY + labelFontSize + labelPadding - 2,
      );
    }
  }

  // Render out-of-view indicators (offset above indicators below the tags area)
  if (outOfViewPeers.length > 0) {
    renderOutOfViewIndicators(ctx, outOfViewPeers, viewport, styles.canvas.paddingTop);
  }
}

/**
 * Render only the cursor on a separate layer (for blink animation).
 * This is much faster than re-rendering the entire page.
 */
export function renderCursorLayer(
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles(),
  remoteAwareness?: Map<string, AwarenessState>,
) {
  // Save context state
  ctx.save();

  // Clear the cursor layer
  // Note: Context is already scaled by DPR in layers.ts, so use CSS pixels here
  ctx.clearRect(0, 0, viewport.width, viewport.height);

  // Render remote cursors first (so they appear behind local cursor)
  if (remoteAwareness && remoteAwareness.size > 0) {
    renderRemoteCursors(ctx, state, viewport, styles, remoteAwareness);
  }

  // Only render if cursor exists, editor is focused, and cursor is visible (not blinking)
  // Don't render cursor in readonly mode
  if (
    !state.document.cursor ||
    !state.view.isFocused ||
    state.ui.mode === "readonly" ||
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
  if (!block || block.deleted) return;

  if (!isTextualBlock(block)) {
    ctx.restore();
    return;
  }

  // Optimization: Skip rendering if cursor block is completely outside viewport
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  let currentY = styles.canvas.paddingTop - viewport.scrollY;
  const visibleBlocks = state.view.visibleBlocks;

  for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
    const visibleBlock = visibleBlocks[visibleIdx];
    if (visibleBlock.originalIndex >= cursorBlockIndex) break;

    const blockHeight = getBlockHeight(
      visibleBlock,
      maxWidth,
      styles,
      visibleIdx === 0,
    );
    currentY += blockHeight;
  }

  const blockHeight = getBlockHeight(
    block,
    maxWidth,
    styles,
    visibleBlocks.length - 1 === cursorBlockIndex,
  );
  if (currentY + blockHeight < 0 || currentY > viewport.height) {
    // Cursor block is not visible in viewport
    ctx.restore();
    return;
  }

  // Get content with composition text injected (if composing in this block)
  const {
    chars: renderChars,
    formats: renderFormats,
    compositionRange,
  } = getContentWithComposition(block, state, cursorBlockIndex);

  // Calculate the target cursor position (original position + composition length if composing)
  let targetCursorIndex = state.document.cursor.position.textIndex;
  if (compositionRange && state.ui.composition?.isComposing) {
    // During composition, cursor appears at the END of composition text
    targetCursorIndex = compositionRange.end;
  }

  // Use shared cursor position calculation
  const cursorPos = calculateCursorPosition(
    { blockIndex: cursorBlockIndex, textIndex: targetCursorIndex },
    block,
    state,
    viewport,
    styles,
    compositionRange,
    renderChars,
    renderFormats,
  );

  if (!cursorPos) {
    ctx.restore();
    return;
  }

  // Draw the cursor
  ctx.fillStyle = styles.cursor.color;
  ctx.fillRect(cursorPos.x, cursorPos.y, styles.cursor.width, cursorPos.height);

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
  objectFit: "cover" | "contain",
  hoveredHandle: "left" | "right" | "bottom" | null,
  styles: EditorStyles,
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
    isHovered: boolean,
  ) => {
    ctx.save();

    // Set opacity based on hover state
    const opacity = isHovered ? vertical.hoverOpacity : vertical.opacity;
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
    hoveredHandle === "left",
  );

  // Right vertical bar (centered vertically with specified length)
  renderBar(
    x + width - vertical.inset - vertical.thickness,
    y + (height - vertical.length) / 2,
    vertical.thickness,
    vertical.length,
    hoveredHandle === "right",
  );

  // Bottom horizontal bar (centered horizontally with specified length)
  // Only render in cover mode
  if (showBottomHandle) {
    renderBar(
      x + (width - horizontal.length) / 2,
      y + height - horizontal.inset - horizontal.thickness,
      horizontal.length,
      horizontal.thickness,
      hoveredHandle === "bottom",
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

/**
 * Get position coordinates for a text position (for selection handles).
 * This is a simplified version of getCursorCoordinates to avoid circular imports.
 */
function getPositionCoordinates(
  position: { blockIndex: number; textIndex: number },
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles,
): { x: number; y: number; height: number } | null {
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  let currentY = styles.canvas.paddingTop - viewport.scrollY;

  // Calculate Y position by summing heights of previous blocks
  const visibleBlocks = state.view.visibleBlocks;

  for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
    const visibleBlock = visibleBlocks[visibleIdx];
    if (visibleBlock.originalIndex >= position.blockIndex) break;

    currentY += getBlockHeight(
      visibleBlock,
      maxWidth,
      styles,
      visibleIdx === 0,
    );
  }

  const block = state.document.page.blocks[position.blockIndex];
  if (!block) return null;
  if (block.deleted) return null;
  if (!isTextualBlock(block)) return null;

  const textStyle = getTextStyle(styles, block.type);
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;

  const fontMetrics = getFontMetrics(
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
  );
  const lineHeight = fontMetrics.fontSize * textStyle.lineHeight;

  const blockVisibleText = getVisibleTextFromRuns(block.charRuns);

  // Detect RTL
  const isRTL =
    blockVisibleText.length > 0 &&
    /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(blockVisibleText);

  // Calculate indent and marker space for list blocks
  let adjustedMaxWidth = maxWidth;
  let baseX = styles.canvas.paddingLeft;

  if (isListBlock(block)) {
    const indent = block.indent || 0;
    const indentOffset = indent * styles.list.indent.size;
    const markerWidth =
      styles.list.numbered.minWidth + styles.list.marker.textGap;

    adjustedMaxWidth = maxWidth - indentOffset - markerWidth;

    if (isRTL) {
      // RTL: indent is on the right side, text starts at left
      baseX = styles.canvas.paddingLeft;
    } else {
      baseX = styles.canvas.paddingLeft + indentOffset + markerWidth;
    }
  }

  // Calculate line wrapping
  const blockChars = charRunsToChars(block.charRuns);
  const lines = wrapCRDTText(
    blockChars,
    block.formats,
    adjustedMaxWidth,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    codePadding,
  );

  let textIndex = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const wrappedLine = lines[lineIndex];
    const line = wrappedLine.text;
    const lineEndIndex = textIndex + line.length;

    if (position.textIndex >= textIndex && position.textIndex <= lineEndIndex) {
      // Calculate X position
      const blockChars = charRunsToChars(block.charRuns);
      const widthFromStart = measureCRDTLineWidth(
        blockChars,
        block.formats,
        textIndex,
        position.textIndex,
        textStyle,
        fontFamily,
        codePadding,
      );

      let x: number;
      if (isRTL) {
        x = baseX + adjustedMaxWidth - widthFromStart;
      } else {
        x = baseX + widthFromStart;
      }

      return {
        x,
        y: currentY,
        height: lineHeight,
      };
    }

    textIndex += line.length;
    if (wrappedLine.consumedSpace) {
      textIndex += 1;
    }
    currentY += lineHeight;
  }

  // Fallback for end of block
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
 * Get selection handle positions for rendering.
 * Returns coordinates for both anchor and focus handles.
 */
function getSelectionHandlePositionsForRender(
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles,
): {
  anchor: { x: number; y: number; height: number; isTop: boolean } | null;
  focus: { x: number; y: number; height: number; isTop: boolean } | null;
} | null {
  const selection = state.document.selection;
  if (!selection || selection.isCollapsed) {
    return null;
  }

  const anchorCoords = getPositionCoordinates(
    selection.anchor,
    state,
    viewport,
    styles,
  );
  const focusCoords = getPositionCoordinates(
    selection.focus,
    state,
    viewport,
    styles,
  );

  if (!anchorCoords || !focusCoords) {
    return null;
  }

  const isForward = selection.isForward;

  return {
    anchor: {
      x: anchorCoords.x,
      y: anchorCoords.y,
      height: anchorCoords.height,
      isTop: isForward,
    },
    focus: {
      x: focusCoords.x,
      y: focusCoords.y,
      height: focusCoords.height,
      isTop: !isForward,
    },
  };
}

/**
 * Render selection handles for mobile text selection.
 * Draws teardrop-shaped handles at the anchor and focus positions.
 * Only renders on touch devices when there's an active selection.
 */
export function renderSelectionHandles(
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles(),
) {
  // Only render handles on touch devices
  if (!isTouchDevice()) {
    return;
  }

  const selection = state.document.selection;
  if (!selection || selection.isCollapsed) {
    return;
  }

  const handlePositions = getSelectionHandlePositionsForRender(
    state,
    viewport,
    styles,
  );

  if (!handlePositions) {
    return;
  }

  const handleStyles = styles.selection.handles;

  // Render anchor handle (at start of selection)
  if (handlePositions.anchor) {
    renderSelectionHandle(
      ctx,
      handlePositions.anchor.x,
      handlePositions.anchor.y,
      handlePositions.anchor.height,
      handlePositions.anchor.isTop,
      handleStyles,
    );
  }

  // Render focus handle (at end of selection)
  if (handlePositions.focus) {
    renderSelectionHandle(
      ctx,
      handlePositions.focus.x,
      handlePositions.focus.y,
      handlePositions.focus.height,
      handlePositions.focus.isTop,
      handleStyles,
    );
  }
}

/**
 * Render a single selection handle (teardrop shape)
 * @param ctx Canvas context
 * @param x X position (cursor position)
 * @param y Y position (top of line)
 * @param lineHeight Height of the text line
 * @param isTop If true, circle is at top (above stem); if false, circle is at bottom
 * @param styles Handle styles
 */
function renderSelectionHandle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  lineHeight: number,
  isTop: boolean,
  styles: {
    size: number;
    color: string;
    stemHeight: number;
    stemWidth: number;
  },
) {
  const { size, color, stemHeight, stemWidth } = styles;
  const radius = size / 2;

  ctx.save();
  ctx.fillStyle = color;

  if (isTop) {
    // Handle at top of selection: circle above, stem going down
    // Circle center is above the line
    const circleY = y - stemHeight - radius;

    // Draw the stem (vertical line from circle to top of line)
    ctx.fillRect(x - stemWidth / 2, y - stemHeight, stemWidth, stemHeight);

    // Draw the circle
    ctx.beginPath();
    ctx.arc(x, circleY, radius, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Handle at bottom of selection: stem going up, circle below
    // Circle center is below the line
    const circleY = y + lineHeight + stemHeight + radius;

    // Draw the stem (vertical line from bottom of line to circle)
    ctx.fillRect(x - stemWidth / 2, y + lineHeight, stemWidth, stemHeight);

    // Draw the circle
    ctx.beginPath();
    ctx.arc(x, circleY, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}
