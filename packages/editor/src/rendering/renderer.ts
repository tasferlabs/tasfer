import {
  type FontFamily,
  getCurrentFontFamily,
  getFontMetrics,
  getFontStack,
  measureTextUpToIndex,
  wrapText,
} from "../fonts";
import { getTextDirection } from "../rtl";
import { isCursorBlinking } from "../selection";
import type { Block, Char, CharRun, FormatSpan } from "../serlization/loadPage";
import { isListBlock } from "../serlization/loadPage";
import type {
  EditorState,
  EditorStyles,
  RenderedBlock,
  TextStyle,
  ViewportState,
} from "../state-types";
import { isTouchDevice } from "../state-utils";
import { getEditorStyles, getTextStyle } from "../styles";
import type { AwarenessState } from "../sync/awareness";
import {
  awarenessCursorToPosition,
  awarenessSelectionToSelection,
} from "../sync/awareness";
import { isTextualBlock } from "../sync/block-registry";
import {
  getCharIdFromRun,
  getVisibleTextFromChars,
  getVisibleTextFromRuns,
  isCharDeleted,
} from "../sync/char-runs";
import type { Operation } from "../sync/sync";
import type { BlockViewRegistry } from "./blocks";
import { getContentWithComposition } from "./blocks";
import { renderScrollbar } from "./scrollbar";

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

// Helper to get or calculate block height, storing it on the block.
// `views` is the per-instance block view registry (from EditorState.blockViews).
export function getBlockHeight(
  views: BlockViewRegistry,
  block: Block,
  maxWidth: number,
  styles: EditorStyles,
  first: boolean,
): number {
  // Calculate the base height (with caching)
  let height: number;
  if (block.cachedHeight !== undefined && block.cachedWidth === maxWidth) {
    height = block.cachedHeight;
  } else {
    height = calculateBlockHeight(views, block, maxWidth, styles);
    block.cachedHeight = height;
    block.cachedWidth = maxWidth;
  }

  // Some blocks (e.g. a first full-width image) bleed into the top padding and
  // therefore advance the flow by less than their drawn height. The per-type
  // rule lives on the block view rather than in a type switch here.
  const view = views.get(block.type);
  if (view?.adjustFlowHeight) {
    return view.adjustFlowHeight(height, {
      block,
      blockIndex: 0,
      maxWidth,
      isFirst: first,
      styles,
    });
  }

  return height;
}

/**
 * Invalidate cache for affected blocks based on CRDT operations.
 */
export function invalidateAffectedBlocks(
  state: EditorState,
  operations: Operation[],
): void {
  const affectedBlockIds = new Set<string>();

  // Collect all affected block IDs
  for (const op of operations) {
    switch (op.op) {
      case "text_insert":
      case "text_delete":
      case "format_set":
      case "block_set":
        affectedBlockIds.add(op.blockId);
        break;
      case "block_insert":
      case "block_delete":
        affectedBlockIds.add(op.blockId);
        break;
    }
  }

  // Invalidate cache for affected blocks
  for (const blockId of affectedBlockIds) {
    const block = state.document.page.blocks.find((b) => b.id === blockId);
    if (block) {
      invalidateBlockCache(block);
    }
  }
}

// Invalidate cache for specific block (when content changes)
export function invalidateBlockCache(block: Block) {
  block.cachedHeight = undefined;
  block.cachedWidth = undefined;
}

// Clear all block caches in a page (for window resize)
export function clearAllBlockCaches(blocks: Block[]) {
  blocks.forEach((block) => invalidateBlockCache(block));
}

// Rendering Functions
// Helper function to measure the width of a portion of CRDT text
// Uses batched measurement to preserve Arabic ligatures
function measureLineWidth(
  chars: Char[],
  formats: FormatSpan[],
  lineStartIndex: number,
  lineEndIndex: number,
  textStyle: TextStyle,
  fontFamily: FontFamily,
  codePadding: number,
): number {
  // Delegate to the shared math-aware measurement so cursor x stays aligned
  // with both wrap and render (atomic inline-math span widths).
  return measureTextUpToIndex(
    chars,
    formats,
    lineStartIndex,
    lineEndIndex,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    codePadding,
  );
}

export function renderPage(
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  viewport: ViewportState,
  visibility: { start: number; end: number },
  styles: EditorStyles = getEditorStyles(state),
  remoteAwareness: Map<string, AwarenessState>,
  requestRedraw: () => void,
) {
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
      state.blockViews,
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
        requestRedraw,
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
}

export function renderBlock(
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  block: Block,
  blockIndex: number,
  x: number,
  y: number,
  maxWidth: number,
  styles: EditorStyles = getEditorStyles(state),
  remoteAwareness?: Map<string, AwarenessState>,
  requestRedraw: () => void = () => {},
): RenderedBlock {
  // Blocks ported to the BlockView registry (image, line, …) dispatch here.
  {
    const view = state.blockViews.get(block.type);
    if (view) {
      const layoutCtx = {
        block,
        blockIndex,
        maxWidth,
        isFirst: blockIndex === 0,
        styles,
      };
      const layout = view.layout(layoutCtx);
      return view.paint(layout, {
        ...layoutCtx,
        ctx,
        state,
        origin: { x, y },
        awareness: remoteAwareness,
        requestRedraw,
      });
    }
  }

  // Handle math blocks
  if (block.type === "math") {
    return renderMathBlock(
      ctx,
      state,
      block,
      blockIndex,
      x,
      y,
      maxWidth,
      styles,
      remoteAwareness,
      requestRedraw,
    );
  }

  // No registered view and not a math block: nothing to draw (all block
  // types are currently registered or handled above — this is a safety net).
  return { block, bounds: { x, y, width: maxWidth, height: 0 }, lines: [] };
} // Calculate position from mouse coordinates dynamically

// The image cache lives with the image block (./blocks/ImageBlockView).
// Re-exported here so existing deep imports from
// `@cypherkit/editor/rendering/renderer` keep resolving.
export { clearFailedImageCache, imageCache } from "./blocks/ImageBlockView";

// ── Math block rendering ──

// Cache for rendered math SVG images: key = latex + displayMode
const mathImageCache = new Map<
  string,
  { img: HTMLImageElement | ImageBitmap; width: number; height: number }
>();
const pendingMathRenders = new Set<string>();

function getMathCacheKey(
  latex: string,
  displayMode: boolean,
  dpr: number,
): string {
  return `${displayMode ? "D" : "I"}:${dpr}:${latex}`;
}

function renderMathToImage(
  latex: string,
  displayMode: boolean,
  _maxWidth: number,
  onReady: () => void,
): void {
  const dpr = window.devicePixelRatio || 1;
  const cacheKey = getMathCacheKey(latex, displayMode, dpr);
  if (mathImageCache.has(cacheKey) || pendingMathRenders.has(cacheKey)) return;

  pendingMathRenders.add(cacheKey);

  // Lazy import MathJax renderer
  import("../math").then(({ renderToSVG }) => {
    try {
      const svgString = renderToSVG(latex, displayMode);
      const color = getEditorStyles().blocks.paragraph.color;

      // Strip the mjx-container wrapper so we can manipulate the inner <svg>
      const coloredSvg = svgString.replace(
        /^<mjx-container[^>]*>([\s\S]*)<\/mjx-container>$/,
        "$1",
      );

      // Parse SVG to get its intrinsic dimensions
      const parser = new DOMParser();
      const svgDoc = parser.parseFromString(coloredSvg, "image/svg+xml");
      const svgEl = svgDoc.querySelector("svg");
      if (!svgEl) {
        pendingMathRenders.delete(cacheKey);
        return;
      }

      // Set fill color on the SVG root
      svgEl.setAttribute("color", color);
      svgEl.style.color = color;

      // Fix MathJax error background rects: they inherit fill="currentColor"
      // from the parent <g>, making error backgrounds the same color as text.
      // Set them to a semi-transparent color instead.
      for (const rect of svgEl.querySelectorAll("rect[data-background]")) {
        rect.setAttribute("fill", "rgba(128,128,128,0.15)");
      }

      // Scale up: MathJax uses ex units, we want ~20px font equivalent
      const scaleFactor = 2.2;
      const viewBox = svgEl.getAttribute("viewBox");
      const widthAttr = svgEl.getAttribute("width");
      const heightAttr = svgEl.getAttribute("height");

      // Logical (CSS-pixel) dimensions
      let w: number;
      let h: number;

      if (viewBox) {
        const parts = viewBox.split(/\s+/).map(Number);
        // viewBox is in MathJax internal units (1000 units per ex)
        w = Math.ceil((parts[2] / 1000) * 8.5 * scaleFactor) + 4;
        h = Math.ceil((parts[3] / 1000) * 8.5 * scaleFactor) + 4;
      } else {
        w = Math.ceil(parseFloat(widthAttr || "100") * scaleFactor);
        h = Math.ceil(parseFloat(heightAttr || "40") * scaleFactor);
      }

      // Physical-pixel dimensions for rasterization. Render at 2x the screen
      // DPR so glyph edges stay sharp even after downscale, and to compensate
      // for browsers that rasterize SVG <img> at lower-than-requested density.
      const renderScale = dpr * 2;
      const pxW = Math.max(1, Math.ceil(w * renderScale));
      const pxH = Math.max(1, Math.ceil(h * renderScale));

      // Set SVG natural size to integer physical pixels
      svgEl.setAttribute("width", String(pxW));
      svgEl.setAttribute("height", String(pxH));
      svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");

      const finalSvg = new XMLSerializer().serializeToString(svgEl);
      const svgBlob = new Blob([finalSvg], {
        type: "image/svg+xml;charset=utf-8",
      });
      const url = URL.createObjectURL(svgBlob);

      const img = new Image();
      img.decoding = "sync";
      img.width = pxW;
      img.height = pxH;
      const finalize = () => {
        const offscreen = document.createElement("canvas");
        offscreen.width = pxW;
        offscreen.height = pxH;
        const offCtx = offscreen.getContext("2d")!;
        offCtx.imageSmoothingEnabled = true;
        offCtx.imageSmoothingQuality = "high";
        offCtx.drawImage(img, 0, 0, pxW, pxH);
        URL.revokeObjectURL(url);

        createImageBitmap(offscreen)
          .then((bitmap) => {
            // Store both the physical-pixel bitmap size and the logical CSS size
            mathImageCache.set(cacheKey, { img: bitmap, width: w, height: h });
            pendingMathRenders.delete(cacheKey);
            onReady();
          })
          .catch(() => {
            pendingMathRenders.delete(cacheKey);
          });
      };
      img.onload = finalize;
      img.onerror = () => {
        pendingMathRenders.delete(cacheKey);
        URL.revokeObjectURL(url);
      };
      img.src = url;
    } catch {
      pendingMathRenders.delete(cacheKey);
    }
  });
}

// Render math block on canvas
function renderMathBlock(
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  block: Block,
  blockIndex: number,
  x: number,
  y: number,
  maxWidth: number,
  styles: EditorStyles,
  remoteAwareness: Map<string, AwarenessState> | undefined,
  requestRedraw: () => void,
): RenderedBlock {
  if (block.type !== "math") {
    throw new Error("renderMathBlock called on non-math block");
  }

  const mathStyles = styles.blocks.math;
  const contentY = y + mathStyles.paddingTop;
  const cachedContentHeight =
    block.cachedHeight !== undefined
      ? block.cachedHeight - mathStyles.paddingTop - mathStyles.paddingBottom
      : mathStyles.minHeight;
  const contentHeight = Math.max(mathStyles.minHeight, cachedContentHeight);
  // const totalHeight = contentHeight + mathStyles.paddingTop + mathStyles.paddingBottom;

  // Hover backdrop for the entire math block — signals it is clickable.
  if (state.ui.hoveredMathBlockIndex === blockIndex && block.latex) {
    const totalHeight =
      contentHeight + mathStyles.paddingTop + mathStyles.paddingBottom;
    ctx.save();
    ctx.fillStyle = mathStyles.hoverBackgroundColor;
    ctx.beginPath();
    ctx.roundRect(x, y, maxWidth, totalHeight, mathStyles.hoverBorderRadius);
    ctx.fill();
    ctx.restore();
  }

  if (block.latex) {
    const dpr = window.devicePixelRatio || 1;
    const cacheKey = getMathCacheKey(block.latex, block.displayMode, dpr);
    const cached = mathImageCache.get(cacheKey);

    if (cached) {
      // Draw the rendered math centered, snapping to the physical pixel grid
      // to avoid bilinear interpolation blur on high-DPI canvases.
      const rawX = x + Math.max(0, (maxWidth - cached.width) / 2);
      const rawY = contentY + Math.max(0, (contentHeight - cached.height) / 2);
      const drawX = Math.round(rawX * dpr) / dpr;
      const drawY = Math.round(rawY * dpr) / dpr;
      const drawW = Math.round(cached.width * dpr) / dpr;
      const drawH = Math.round(cached.height * dpr) / dpr;
      ctx.drawImage(cached.img, drawX, drawY, drawW, drawH);
    } else {
      // Trigger rendering and show placeholder
      renderMathToImage(
        block.latex,
        block.displayMode,
        maxWidth,
        requestRedraw,
      );

      // Draw loading placeholder
      ctx.save();
      ctx.fillStyle = mathStyles.placeholder.textColor;
      ctx.font = "14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.globalAlpha = 0.5;
      ctx.fillText(
        "Rendering...",
        x + maxWidth / 2,
        contentY + contentHeight / 2,
      );
      ctx.restore();
    }
  } else {
    // Empty math block - draw placeholder
    ctx.save();
    ctx.fillStyle = mathStyles.placeholder.backgroundColor;
    ctx.beginPath();
    ctx.roundRect(x, contentY, maxWidth, contentHeight, 6);
    ctx.fill();

    ctx.fillStyle = mathStyles.placeholder.textColor;
    ctx.font = "14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      mathStyles.placeholder.text,
      x + maxWidth / 2,
      contentY + contentHeight / 2,
    );
    ctx.restore();
  }

  // Render remote selection overlays
  if (remoteAwareness && remoteAwareness.size > 0) {
    for (const [_peerId, awareness] of remoteAwareness) {
      if (!awareness.selection) continue;
      const selection = awarenessSelectionToSelection(
        awareness.selection,
        state.document.page,
      );
      if (!selection) continue;

      const isVisualBlockSelected =
        selection.anchor.blockIndex === blockIndex &&
        selection.focus.blockIndex === blockIndex;

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
        ctx.globalAlpha = 0.2;
        ctx.beginPath();
        ctx.roundRect(x, contentY, maxWidth, contentHeight, 6);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  // Recalculate the actual layout height to ensure highlight matches layout
  const layoutHeight = getBlockHeight(
    state.blockViews,
    block,
    maxWidth,
    styles,
    false,
  );

  // Render local selection overlay
  if (state.document.selection && !state.document.selection.isCollapsed) {
    const { anchor, focus } = state.document.selection;
    const start = anchor.blockIndex <= focus.blockIndex ? anchor : focus;
    const end = anchor.blockIndex <= focus.blockIndex ? focus : anchor;

    if (blockIndex >= start.blockIndex && blockIndex <= end.blockIndex) {
      ctx.save();
      ctx.fillStyle = styles.selection.backgroundColor;
      ctx.globalAlpha = styles.selection.opacity;
      ctx.beginPath();
      ctx.roundRect(x, y, maxWidth, layoutHeight, 6);
      ctx.fill();
      ctx.restore();
    }
  }

  return {
    block,
    bounds: { x, y, width: maxWidth, height: layoutHeight },
    lines: [],
  };
}

// renderLineBlock was removed: the `line` block now lives in
// rendering/blocks/LineBlockView.ts and renders via the BlockView registry.

// Calculate block height dynamically based on content and max width
export function calculateBlockHeight(
  views: BlockViewRegistry,
  block: Block,
  maxWidth: number,
  styles: EditorStyles,
): number {
  // Blocks ported to the BlockView registry (image, line, …). The height pass
  // reuses the same layout() the painter uses, so wrapping/sizing never drifts.
  {
    const view = views.get(block.type);
    if (view) {
      return view.layout({
        block,
        blockIndex: 0,
        maxWidth,
        isFirst: false,
        styles,
      }).height;
    }
  }

  // Handle math blocks
  if (block.type === "math") {
    const mathStyles = styles.blocks.math;
    if (block.latex) {
      const dpr = window.devicePixelRatio || 1;
      const cacheKey = getMathCacheKey(block.latex, block.displayMode, dpr);
      const cached = mathImageCache.get(cacheKey);
      if (cached) {
        return (
          Math.max(mathStyles.minHeight, cached.height) +
          mathStyles.paddingTop +
          mathStyles.paddingBottom
        );
      }
    }
    return (
      mathStyles.minHeight + mathStyles.paddingTop + mathStyles.paddingBottom
    );
  }

  return 0;
}

// Check if a block is visible in the viewport
function isBlockVisible(
  blockY: number,
  blockHeight: number,
  viewport: { scrollY: number; height: number },
): boolean {
  const blockTop = blockY;
  const blockBottom = blockY + blockHeight;
  // Buffer not needed anymore because we use canvas based scrolling
  const buffer = 0;
  return (
    // blockY is relative to canvas (already offset by scrollY), so viewport top is 0
    blockBottom >= -buffer && blockTop <= viewport.height + buffer
  );
}

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
      state.blockViews,
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

  const lines = wrapText(
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
  const isRTL = getTextDirection(visibleText) === "rtl";

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
        const widthFromStart = measureLineWidth(
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
          measureLineWidth(
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
  blockIndex: number;
  textIndex: number;
}

// Stored hit areas for out-of-view peer indicators (populated each render)
interface IndicatorHitArea {
  x: number;
  y: number;
  width: number;
  height: number;
  blockIndex: number;
  textIndex: number;
}

let outOfViewIndicatorHitAreas: IndicatorHitArea[] = [];

export function getOutOfViewIndicatorAtPoint(
  canvasX: number,
  canvasY: number,
): { blockIndex: number; textIndex: number } | null {
  for (const area of outOfViewIndicatorHitAreas) {
    if (
      canvasX >= area.x &&
      canvasX <= area.x + area.width &&
      canvasY >= area.y &&
      canvasY <= area.y + area.height
    ) {
      return { blockIndex: area.blockIndex, textIndex: area.textIndex };
    }
  }
  return null;
}

function renderOutOfViewIndicators(
  ctx: CanvasRenderingContext2D,
  peers: OutOfViewPeer[],
  viewport: ViewportState,
  styles: EditorStyles,
  topOffset: number = 0,
) {
  const abovePeers = peers.filter((p) => p.direction === "above");
  const belowPeers = peers.filter((p) => p.direction === "below");

  const pillHeight = 24;
  const pillPadding = 8;
  const fontSize = 12;
  const chevronSize = 6;
  const gap = 8;

  // Clear previous hit areas
  outOfViewIndicatorHitAreas = [];

  ctx.font = `600 ${fontSize}px ${getFontStack(getCurrentFontFamily())}`;

  // Render indicators for peers above viewport
  abovePeers.forEach((peer, i) => {
    const initial = peer.awareness.user.name?.charAt(0).toUpperCase() || "?";
    const textWidth = ctx.measureText(initial).width;
    const pillWidth = textWidth + pillPadding * 2;

    const x = pillPadding + i * (pillWidth + gap);
    const y = topOffset + pillPadding + chevronSize;

    // Store hit area (includes chevron)
    outOfViewIndicatorHitAreas.push({
      x,
      y: y - chevronSize,
      width: pillWidth,
      height: pillHeight + chevronSize,
      blockIndex: peer.blockIndex,
      textIndex: peer.textIndex,
    });

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

    // Draw initial with correct direction for the character
    const initialDirection = getTextDirection(initial);
    ctx.fillStyle = styles.remoteCursor.labelTextColor;
    ctx.textBaseline = "middle";
    ctx.direction = initialDirection;
    ctx.textAlign = "center";
    ctx.fillText(initial, x + pillWidth / 2, y + pillHeight / 2);
    ctx.textAlign = "start";
    ctx.direction = "ltr";
  });

  // Render indicators for peers below viewport
  belowPeers.forEach((peer, i) => {
    const initial = peer.awareness.user.name?.charAt(0).toUpperCase() || "?";
    const textWidth = ctx.measureText(initial).width;
    const pillWidth = textWidth + pillPadding * 2;

    const x = pillPadding + i * (pillWidth + gap);
    const y = viewport.height - pillPadding - pillHeight - chevronSize;

    // Store hit area (includes chevron)
    outOfViewIndicatorHitAreas.push({
      x,
      y,
      width: pillWidth,
      height: pillHeight + chevronSize,
      blockIndex: peer.blockIndex,
      textIndex: peer.textIndex,
    });

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

    // Draw initial with correct direction for the character
    const initialDirection = getTextDirection(initial);
    ctx.fillStyle = styles.remoteCursor.labelTextColor;
    ctx.textBaseline = "middle";
    ctx.direction = initialDirection;
    ctx.textAlign = "center";
    ctx.fillText(initial, x + pillWidth / 2, y + pillHeight / 2);
    ctx.textAlign = "start";
    ctx.direction = "ltr";
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
      outOfViewPeers.push({
        awareness,
        direction: "above",
        x: cursorPos.x,
        blockIndex: position.blockIndex,
        textIndex: position.textIndex,
      });
      continue;
    }
    if (cursorPos.y > viewport.height) {
      outOfViewPeers.push({
        awareness,
        direction: "below",
        x: cursorPos.x,
        blockIndex: position.blockIndex,
        textIndex: position.textIndex,
      });
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
      ctx.font = `${labelFontSize}px ${getFontStack(getCurrentFontFamily())}`;
      const labelWidth =
        ctx.measureText(awareness.user.name).width + labelPadding * 2;
      const labelHeight = labelFontSize + labelPadding * 2;

      // Detect RTL to position label on the correct side of cursor
      const blockChars = charRunsToChars(block.charRuns);
      const blockText = getVisibleTextFromChars(blockChars);
      const isCursorRTL = getTextDirection(blockText) === "rtl";

      // In RTL, label extends to the left of cursor; in LTR, to the right
      let labelX = isCursorRTL ? cursorPos.x - labelWidth : cursorPos.x;
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
      ctx.roundRect(labelX, labelY, labelWidth, labelHeight, 2);
      ctx.fill();

      // Draw label text with correct direction
      const nameDirection = getTextDirection(awareness.user.name);
      ctx.fillStyle = styles.remoteCursor.labelTextColor;
      ctx.direction = nameDirection;
      ctx.fillText(
        awareness.user.name,
        nameDirection === "rtl"
          ? labelX + labelWidth - labelPadding
          : labelX + labelPadding,
        labelY + labelFontSize + labelPadding - 2,
      );
      ctx.direction = "ltr";
    }
  }

  // Render out-of-view indicators (offset above indicators below the tags area)
  if (outOfViewPeers.length > 0) {
    renderOutOfViewIndicators(
      ctx,
      outOfViewPeers,
      viewport,
      styles,
      styles.canvas.paddingTop,
    );
  } else {
    outOfViewIndicatorHitAreas = [];
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
  styles: EditorStyles = getEditorStyles(state),
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
      state.blockViews,
      visibleBlock,
      maxWidth,
      styles,
      visibleIdx === 0,
    );
    currentY += blockHeight;
  }

  const blockHeight = getBlockHeight(
    state.blockViews,
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

  // Calculate the target cursor position (original position + composition offset if composing)
  let targetCursorIndex = state.document.cursor.position.textIndex;
  if (compositionRange && state.ui.composition?.isComposing) {
    const offset = Math.max(
      0,
      Math.min(
        state.ui.composition.cursorOffset,
        compositionRange.end - compositionRange.start,
      ),
    );
    targetCursorIndex = compositionRange.start + offset;
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

  // Draw cursor drag handle on touch devices (small circle below cursor)
  if (isTouchDevice()) {
    const handleRadius = 5;
    const handleStemHeight = 3;
    const handleY =
      cursorPos.y + cursorPos.height + handleStemHeight + handleRadius;

    // Draw stem (same x and width as cursor so they align)
    ctx.fillRect(
      cursorPos.x,
      cursorPos.y + cursorPos.height,
      styles.cursor.width,
      handleStemHeight,
    );

    // Draw circle
    ctx.beginPath();
    ctx.arc(
      cursorPos.x + styles.cursor.width / 2,
      handleY,
      handleRadius,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  // Restore context state
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
      state.blockViews,
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
  const isRTL = getTextDirection(blockVisibleText) === "rtl";

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
  const lines = wrapText(
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
      const widthFromStart = measureLineWidth(
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
  styles: EditorStyles = getEditorStyles(state),
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
