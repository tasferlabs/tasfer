import {
  BLOCK_DRAG_HANDLE_GRIP_HEIGHT,
  BLOCK_DRAG_HANDLE_GRIP_WIDTH,
  BLOCK_DRAG_HANDLE_HIT_WIDTH,
} from "../constants";
import type {
  IndicatorHitArea,
  InteractionSession,
} from "../events/interaction-session";
import { currentFontFamily, getFontStack } from "../fonts";
import type { TextualBlock } from "../nodes/TextNode";
import { getBlockDirection, getTextDirection } from "../rtl";
import {
  isCursorBlinking,
  isNodeSelection,
  selectionHighlightEdge,
} from "../selection";
import type { Block, Char, MarkSpan } from "../serlization/loadPage";
import type {
  EditorState,
  EditorStyles,
  NodeOverlay,
  Position,
  RenderedBlock,
  ViewportState,
  VisibleBlockRange,
} from "../state-types";
import { isTouchDevice } from "../state-utils";
import { isContentSelectionCollapsed } from "../structured-selection";
import { getEditorStyles } from "../styles";
import { findBlock } from "../sync/block-lookup";
import { isTextualBlock } from "../sync/block-registry";
import { getVisibleTextFromChars } from "../sync/char-runs";
import type { Operation } from "../sync/sync";
import type { BlockHeightIndex } from "./block-height-index";
import { caretLandingProgress, caretLandingShape } from "./caret-landing";
import {
  allDecorations,
  type CaretDecoration,
  type LabelIconShape,
  resolveDecorationPoint,
} from "./decorations";
import type { MarkRegistry } from "./marks";
import type { NodeRegionCtx, NodeRegistry } from "./nodes";
import { getContentWithComposition, TextNode, UnknownNode } from "./nodes";
import { renderScrollbar } from "./scrollbar";

// Helper to get a block's flow height. The base height comes from the block's
// layout, which is memoized on the block (see Node.layout / memoizeNodeLayout),
// so repeated height passes / hit-tests don't re-run the expensive layout.
// `views` is the per-instance block view registry (from EditorState.nodes).
export function getBlockHeight(
  views: NodeRegistry,
  marks: MarkRegistry,
  block: Block,
  maxWidth: number,
  styles: EditorStyles,
  first: boolean,
): number {
  const view = views.get(block.type) ?? new UnknownNode();
  const height = view.layout({
    block,
    blockIndex: 0,
    maxWidth,
    isFirst: false,
    styles,
    marks,
  }).height;

  // Some blocks (e.g. a first full-width image) bleed into the top padding and
  // therefore advance the flow by less than their drawn height. The per-type
  // rule lives on the block view rather than in a type switch here.
  if (view.adjustFlowHeight) {
    return view.adjustFlowHeight(height, {
      block,
      blockIndex: 0,
      maxWidth,
      isFirst: first,
      styles,
      marks,
    });
  }

  return height;
}

/**
 * Cheap flow-height estimate supplied by the registered node. The generic
 * engine knows nothing about block types; custom nodes participate by
 * overriding `Node.estimateHeight`.
 */
export function getEstimatedBlockHeight(
  views: NodeRegistry,
  marks: MarkRegistry,
  block: Block,
  blockIndex: number,
  maxWidth: number,
  styles: EditorStyles,
  first: boolean,
): number {
  const view = views.get(block.type) ?? new UnknownNode();
  const ctx = {
    block,
    blockIndex,
    maxWidth,
    isFirst: first,
    styles,
    marks,
  };
  const height = view.estimateHeight(ctx);
  return view.adjustFlowHeight ? view.adjustFlowHeight(height, ctx) : height;
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
      case "mark_set":
      case "block_set":
      case "content_edit":
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
    const block = findBlock(state.document.page, blockId);
    if (block) {
      invalidateBlockCache(block);
    }
  }
}

// Invalidate cache for specific block (when content changes)
export function invalidateBlockCache(block: Block) {
  block.cachedLayout = undefined;
}

// Clear all block caches in a page (for window resize)
export function clearAllBlockCaches(blocks: Block[]) {
  blocks.forEach((block) => invalidateBlockCache(block));
}

// Rendering Functions

export function renderPage(
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  viewport: ViewportState,
  visibility: VisibleBlockRange,
  styles: EditorStyles = getEditorStyles(state),
  requestRedraw: () => void,
  heightIndex?: BlockHeightIndex,
  // Auto-height surfaces grow the canvas to fit their content, so there is never
  // a scroll region — skip the scrollbar (and its minimap markers) entirely.
  autoHeight = false,
) {
  // Save context state
  ctx.save();

  // Enable text antialiasing for better quality on high-DPI screens
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Clear canvas (background color is handled by CSS on the canvas element)
  // Note: Context is already scaled by DPR in layers.ts, so use CSS pixels here
  ctx.clearRect(0, 0, viewport.width, viewport.height);

  const renderedBlocks: RenderedBlock[] = [];
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  // Render each visible block
  const visibleBlocks = state.view.visibleBlocks;
  let foundVisibleBlock = false;
  const startIndex =
    heightIndex && visibleBlocks.length > 0
      ? Math.max(
          0,
          heightIndex.visibleIndexAtOffset(
            viewport.scrollY - styles.canvas.paddingTop,
          ) - 1,
        )
      : 0;
  let currentY =
    styles.canvas.paddingTop -
    viewport.scrollY +
    (heightIndex?.offsetOfVisibleIndex(startIndex) ?? 0);
  visibility.start = startIndex;
  visibility.end = startIndex;
  visibility.startY = currentY;
  // Stamp the scroll this snapshot is valid for, so hit-testing against a later
  // (scrolled-but-not-yet-repainted) viewport can re-base `startY`.
  visibility.scrollY = viewport.scrollY;

  for (
    let visibleIdx = startIndex;
    visibleIdx < visibleBlocks.length;
    visibleIdx++
  ) {
    const block = visibleBlocks[visibleIdx];

    // Get or calculate block height (cached on the block itself)
    const blockHeight = getBlockHeight(
      state.nodes,
      state.marks,
      block,
      maxWidth,
      styles,
      visibleIdx === 0,
    );
    heightIndex?.setExactHeight(visibleIdx, blockHeight);

    // Only render if block is visible in viewport
    if (isBlockVisible(currentY, blockHeight, viewport)) {
      if (!foundVisibleBlock) {
        visibility.start = visibleIdx;
        visibility.startY = currentY;
        foundVisibleBlock = true;
      }
      visibility.end = visibleIdx;

      const renderedBlock = renderBlock(
        ctx,
        state,
        block,
        block.originalIndex,
        visibleIdx === 0,
        styles.canvas.paddingLeft,
        currentY,
        maxWidth,
        styles,
        requestRedraw,
      );
      renderedBlocks.push(renderedBlock);
    } else if (foundVisibleBlock) {
      // We've passed the visible range, no need to continue
      break;
    }
    currentY += blockHeight;
  }

  const documentHeight = heightIndex
    ? styles.canvas.paddingTop +
      heightIndex.totalHeight() +
      styles.canvas.paddingBottom
    : viewport.documentHeight;

  // Add extra padding on mobile devices for keyboard space
  // documentHeight += styles.canvas.paddingBottom;

  // Render selection handles for mobile (after selection rendering, before
  // scrollbar). Pass the height index so the handles anchor on the same painted
  // flow as the highlight and caret rather than an exact walk from block 0.
  renderSelectionHandles(ctx, state, viewport, styles, heightIndex);

  // Render scrollbar (skipped for auto-height surfaces, which never scroll)
  if (!autoHeight) {
    renderScrollbar(
      ctx,
      viewport,
      documentHeight,
      state,
      undefined,
      heightIndex,
    );
  }

  // Block reorder chrome: gutter grip on the hovered block + insertion line
  // while a reorder drag is active. Painted last so it sits above content.
  // Anchored to the same `visibility` snapshot the content paint just produced
  // so the grip/line line up with the blocks rather than the (estimate-based)
  // flow walked from block 0.
  renderBlockDrag(ctx, state, viewport, styles, visibility);

  // Restore context state (undo scaling)
  ctx.restore();

  return documentHeight;
  // console.log(viewport.visibleBlocksStartIndex, viewport.visibleBlocksEndIndex);
}

/**
 * Collect the host-rendered overlay descriptors for the currently on-screen
 * blocks. Walks the same block flow as `renderPage` (so an overlay's `rect`
 * matches the painted layout), asking each block's node for its overlays at the
 * block's on-screen origin. Coordinates come back in container/viewport space
 * (scroll already applied), ready for the host to mount portals at.
 *
 * Framework-free: the engine never renders these — it only locates them and
 * hands the host `{ key, rect, … }`. See {@link NodeOverlay} and `Node.overlays`.
 */
export function collectOverlays(
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
  heightIndex?: BlockHeightIndex,
): NodeOverlay[] {
  const overlays: NodeOverlay[] = [];
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  const visibleBlocks = state.view.visibleBlocks;
  const startIndex =
    heightIndex && visibleBlocks.length > 0
      ? Math.max(
          0,
          heightIndex.visibleIndexAtOffset(
            viewport.scrollY - styles.canvas.paddingTop,
          ) - 1,
        )
      : 0;
  let y =
    styles.canvas.paddingTop -
    viewport.scrollY +
    (heightIndex?.offsetOfVisibleIndex(startIndex) ?? 0);
  for (let i = startIndex; i < visibleBlocks.length; i++) {
    const block = visibleBlocks[i];
    const height = getBlockHeight(
      state.nodes,
      state.marks,
      block,
      maxWidth,
      styles,
      i === 0,
    );
    heightIndex?.setExactHeight(i, height);
    const node = state.nodes.get(block.type);
    // Only ask blocks that are actually within the viewport — an off-screen
    // overlay would mount a portal nobody can see.
    if (node?.overlays && y + height >= 0 && y <= viewport.height) {
      const regionCtx: NodeRegionCtx = {
        block,
        blockIndex: block.originalIndex,
        maxWidth,
        isFirst: i === 0,
        styles,
        marks: state.marks,
        state,
        viewport,
        origin: { x: styles.canvas.paddingLeft, y },
      };
      for (const o of node.overlays(regionCtx))
        overlays.push(normalizeOverlay(o));
    }
    y += height;
    if (y > viewport.height) break;
  }
  // Inline marks declare overlays too (e.g. inline-math's editor). A mark isn't
  // tied to one block, so each registered mark is consulted once; it reads the
  // run's block/range/position off the active menu in `state`.
  for (const mark of state.marks.markList()) {
    if (mark.overlays) {
      for (const o of mark.overlays({ state, viewport, styles })) {
        overlays.push(normalizeOverlay(o));
      }
    }
  }
  return overlays;
}

/**
 * Fill a declared overlay's optional `rect.width`/`rect.height` with `1` (a
 * point anchor) so every collected overlay carries concrete dimensions the host
 * can use directly.
 */
function normalizeOverlay(o: NodeOverlay): NodeOverlay {
  const { x, y, width = 1, height = 1 } = o.rect;
  return { ...o, rect: { x, y, width, height } };
}

export function renderBlock(
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  block: Block,
  blockIndex: number,
  isFirst: boolean,
  x: number,
  y: number,
  maxWidth: number,
  styles: EditorStyles = getEditorStyles(state),
  requestRedraw: () => void = () => {},
): RenderedBlock {
  // Blocks dispatch to their registered node. A block type with no registered
  // node (a custom/newer type this build doesn't know) falls back to an
  // `UnknownNode`, which paints a labeled placeholder so the content is
  // visible and keeps its place rather than silently vanishing.
  {
    const view = state.nodes.get(block.type) ?? new UnknownNode();
    const layoutCtx = {
      block,
      blockIndex,
      maxWidth,
      // `isFirst` is the block's position among *visible* blocks (the first one
      // rendered at the top of the document), NOT `blockIndex === 0`. `blockIndex`
      // is `originalIndex`, which counts leading tombstones — so deriving the flag
      // from it desyncs the bleed of a first full-width image from the flow-height,
      // overlay, and hit-test paths (all of which key off the visible position),
      // painting the image too low and floating its overlay/hit box too high.
      isFirst,
      styles,
      marks: state.marks,
    };
    const layout = view.layout(layoutCtx);
    return view.paint(layout, {
      ...layoutCtx,
      ctx,
      state,
      origin: { x, y },
      requestRedraw,
    });
  }
} // Calculate position from mouse coordinates dynamically

// The image cache lives with the image block (./nodes/ImageNode). Re-exported
// here so `@cypherkit/editor/internal` can surface it for hosts.
export { clearFailedImageCache, imageCache } from "../nodes/ImageNode";

// renderLineBlock / renderMathBlock were removed: the `line` and `math` blocks
// now live in rendering/nodes/{LineNode,MathNode}.ts and render via
// the Node registry.

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
 * Top Y of a block in viewport space (canvas paddingTop minus scroll).
 * Shared by the cursor layer and the selection-handle pass.
 */
function getBlockTopViewport(
  state: EditorState,
  blockIndex: number,
  maxWidth: number,
  viewport: ViewportState,
  styles: EditorStyles,
  heightIndex?: BlockHeightIndex,
): number {
  const indexedOffset = heightIndex?.offsetOfOriginalIndex(blockIndex);
  if (indexedOffset !== undefined && indexedOffset !== null) {
    return styles.canvas.paddingTop - viewport.scrollY + indexedOffset;
  }
  let y = styles.canvas.paddingTop - viewport.scrollY;
  const visibleBlocks = state.view.visibleBlocks;
  for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
    const visibleBlock = visibleBlocks[visibleIdx];
    if (visibleBlock.originalIndex >= blockIndex) break;
    y += getBlockHeight(
      state.nodes,
      state.marks,
      visibleBlock,
      maxWidth,
      styles,
      visibleIdx === 0,
    );
  }
  return y;
}

/**
 * Core cursor position calculation logic shared between local and remote
 * cursors. Delegates all text geometry to the block's registered TextNode so
 * the caret can never drift from the painted text.
 */
function calculateCursorPosition(
  position: { blockIndex: number; textIndex: number },
  block: Block,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles,
  compositionRange: { start: number; end: number } | null = null,
  renderChars?: Char[],
  renderFormats?: MarkSpan[],
  heightIndex?: BlockHeightIndex,
): { x: number; y: number; height: number } | null {
  if (!isTextualBlock(block)) return null;
  const node = state.nodes.get(block.type);
  if (!(node instanceof TextNode)) return null;

  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  const blockTop = getBlockTopViewport(
    state,
    position.blockIndex,
    maxWidth,
    viewport,
    styles,
    heightIndex,
  );

  // With composition content the layout is recomputed from the injected chars
  // (exactly as paint() does); otherwise the canonical layout is used.
  const layout = renderChars
    ? node.computeLayout(
        block,
        maxWidth,
        styles,
        {
          chars: renderChars,
          formats: renderFormats ?? block.formats,
          compositionRange,
        },
        state.marks,
      )
    : node.layout({
        block,
        blockIndex: position.blockIndex,
        maxWidth,
        isFirst: false,
        styles,
        marks: state.marks,
      });

  const targetCursorIndex = Math.min(
    position.textIndex,
    getVisibleTextFromChars(layout.chars).length,
  );
  const rect = node.caretRect(
    layout,
    targetCursorIndex,
    styles.canvas.paddingLeft,
    blockTop,
    state,
    block.id,
  );

  // A caret inside a math chip carries its exact box (sized to the row it sits
  // on, already floored to a legible minimum by the tex caret model); draw it
  // verbatim. Otherwise the caret is ascent+descent tall (text height) anchored
  // at the line top, not full line height.
  return {
    x: rect.x,
    y: rect.y,
    height: rect.exact
      ? rect.height
      : layout.fontMetrics.ascent + layout.fontMetrics.descent,
  };
}

/**
 * Resolve caret coordinates using indexed prefix heights. Only the target block
 * is laid out exactly; blocks before it remain cheap estimates.
 */
export function getIndexedCursorViewportCoords(
  position: Position,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles,
  heightIndex: BlockHeightIndex,
): { x: number; y: number; height: number } | null {
  const block = state.document.page.blocks[position.blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) return null;
  const visibleIndex = heightIndex.visibleIndexOfOriginal(position.blockIndex);
  if (visibleIndex === null) return null;
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  heightIndex.setExactHeight(
    visibleIndex,
    getBlockHeight(
      state.nodes,
      state.marks,
      block,
      maxWidth,
      styles,
      visibleIndex === 0,
    ),
  );
  return calculateCursorPosition(
    position,
    block,
    state,
    viewport,
    styles,
    null,
    undefined,
    undefined,
    heightIndex,
  );
}

/**
 * A caret decoration resolved to a live position — the internal currency the
 * caret-decoration renderer works in. Built from {@link CaretDecoration}s on
 * `state.ui.decorations` (remote peer cursors are just caret decorations a host
 * or provider feeds in); the renderer itself knows nothing about "peers".
 */
interface ResolvedCaret {
  decoration: CaretDecoration;
  position: Position;
  block: TextualBlock;
}

/** Resolve every caret decoration to a paintable position in a textual block. */
function collectCaretDecorations(state: EditorState): ResolvedCaret[] {
  const out: ResolvedCaret[] = [];
  for (const deco of allDecorations(state.ui.decorations)) {
    if (deco.kind !== "caret") continue;
    const position = resolveDecorationPoint(deco.point, state.document.page);
    if (!position) continue;
    const block = state.document.page.blocks[position.blockIndex];
    if (!block || block.deleted || !isTextualBlock(block)) continue;
    out.push({ decoration: deco, position, block });
  }
  return out;
}

interface OutOfViewPeer {
  caret: ResolvedCaret;
  direction: "above" | "below";
  x: number;
  blockIndex: number;
  textIndex: number;
}

// Hit areas for out-of-view peer indicators live on the per-instance session
// (InteractionSession.outOfViewIndicatorHitAreas), populated each render below.

export function getOutOfViewIndicatorAtPoint(
  session: InteractionSession,
  canvasX: number,
  canvasY: number,
): { blockIndex: number; textIndex: number } | null {
  for (const area of session.outOfViewIndicatorHitAreas) {
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
  hitAreas: IndicatorHitArea[],
  peers: OutOfViewPeer[],
  viewport: ViewportState,
  styles: EditorStyles,
) {
  const abovePeers = peers.filter((p) => p.direction === "above");
  const belowPeers = peers.filter((p) => p.direction === "below");

  // All pill geometry — including the per-edge insets a host uses to clear
  // platform chrome (a mobile safe area) — comes from the theme. Defaults
  // reproduce the historical look (insets 0).
  const {
    insetInlineStart,
    insetTop,
    insetBottom,
    pillHeight,
    pillPadding,
    fontSize,
    chevronSize,
    gap,
    edgeMargin,
    initialFontWeight,
  } = styles.remoteCursor.outOfViewIndicator;

  // Clear previous hit areas (mutate in place — callers hold this same array)
  hitAreas.length = 0;

  ctx.font = `${initialFontWeight} ${fontSize}px ${getFontStack(currentFontFamily(styles), styles.fonts)}`;

  // The indicators live in the left margin, just outside the reading column, so
  // they never sit on top of the text. `paddingLeft` is the content's left edge
  // (it grows for the centered "narrow" page width); we right-align the row to
  // it and let each extra peer step further into the gutter. The safe-area inset
  // is the hard left limit (mobile notch / very tight gutters).
  const contentLeft = Math.max(insetInlineStart, styles.canvas.paddingLeft);

  // Render indicators for peers above viewport
  let aboveX = contentLeft;
  abovePeers.forEach((peer) => {
    const initial =
      peer.caret.decoration.label?.text.charAt(0).toUpperCase() || "?";
    const textWidth = ctx.measureText(initial).width;
    // A single initial should read as a circle: never let the pill be narrower
    // than it is tall. A longer label (rare) still grows into a stadium.
    const pillWidth = Math.max(textWidth + pillPadding * 2, pillHeight);

    aboveX -= pillWidth + gap;
    const x = Math.max(insetInlineStart, aboveX);
    // Hug the top edge. This is deliberately independent of the canvas top
    // padding: a host may reserve that padding for chrome (e.g. a schedule tag)
    // that sits in the content column, which the gutter-placed pill clears.
    const y = insetTop + edgeMargin + chevronSize;

    // Store hit area (includes chevron)
    hitAreas.push({
      x,
      y: y - chevronSize,
      width: pillWidth,
      height: pillHeight + chevronSize,
      blockIndex: peer.blockIndex,
      textIndex: peer.textIndex,
    });

    // Draw chevron pointing up
    ctx.fillStyle = peer.caret.decoration.color;
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
  let belowX = contentLeft;
  belowPeers.forEach((peer) => {
    const initial =
      peer.caret.decoration.label?.text.charAt(0).toUpperCase() || "?";
    const textWidth = ctx.measureText(initial).width;
    const pillWidth = Math.max(textWidth + pillPadding * 2, pillHeight);

    belowX -= pillWidth + gap;
    const x = Math.max(insetInlineStart, belowX);
    // Hug the bottom edge (chevron tip on the bottom inset line).
    const y =
      viewport.height - insetBottom - edgeMargin - pillHeight - chevronSize;

    // Store hit area (includes chevron)
    hitAreas.push({
      x,
      y,
      width: pillWidth,
      height: pillHeight + chevronSize,
      blockIndex: peer.blockIndex,
      textIndex: peer.textIndex,
    });

    // Draw pill background
    ctx.fillStyle = peer.caret.decoration.color;
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

/**
 * Stroke an icon expressed as 24×24-viewBox primitives (the lucide convention)
 * into a `size`×`size` box at (`x`, `y`). The renderer stays icon-agnostic — it
 * draws whatever primitives it's handed. Stroke width is the lucide default (2
 * viewBox units), so it scales proportionally with `size`.
 */
function drawLabelIcon(
  ctx: CanvasRenderingContext2D,
  shapes: readonly LabelIconShape[],
  x: number,
  y: number,
  size: number,
  color: string,
) {
  const VIEWBOX = 24;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / VIEWBOX, size / VIEWBOX);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of shapes) {
    if (s.shape === "path") {
      ctx.stroke(new Path2D(s.d));
    } else if (s.shape === "rect") {
      ctx.beginPath();
      ctx.roundRect(s.x, s.y, s.width, s.height, s.rx ?? 0);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function renderCaretDecorations(
  ctx: CanvasRenderingContext2D,
  session: InteractionSession,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles,
  carets: ResolvedCaret[],
  heightIndex?: BlockHeightIndex,
) {
  const outOfViewPeers: OutOfViewPeer[] = [];

  for (const caret of carets) {
    const { position, block, decoration } = caret;
    const caretColor = decoration.color;

    const cursorPos = calculateCursorPosition(
      position,
      block,
      state,
      viewport,
      styles,
      null,
      undefined,
      undefined,
      heightIndex,
    );
    if (!cursorPos) continue;

    // Check if cursor is out of viewport (account for top padding where tags may overlay)
    if (cursorPos.y + cursorPos.height < styles.canvas.paddingTop) {
      outOfViewPeers.push({
        caret,
        direction: "above",
        x: cursorPos.x,
        blockIndex: position.blockIndex,
        textIndex: position.textIndex,
      });
      continue;
    }
    if (cursorPos.y > viewport.height) {
      outOfViewPeers.push({
        caret,
        direction: "below",
        x: cursorPos.x,
        blockIndex: position.blockIndex,
        textIndex: position.textIndex,
      });
      continue;
    }

    // Draw the caret in the decoration's color. Peer carets use their own
    // themed width, independent of the local caret.
    ctx.fillStyle = caretColor;
    ctx.fillRect(
      cursorPos.x,
      cursorPos.y,
      styles.remoteCursor.caretWidth,
      cursorPos.height,
    );

    // Optionally draw a name label above the cursor
    const labelText = decoration.label?.text;
    if (labelText) {
      const labelPadding = styles.remoteCursor.labelPadding;
      const labelFontSize = styles.remoteCursor.labelFontSize;
      ctx.font = `${labelFontSize}px ${getFontStack(currentFontFamily(styles), styles.fonts)}`;
      const textWidth = ctx.measureText(labelText).width;

      // An optional glyph (e.g. a device hint) sits on the label's leading side.
      const iconShapes = decoration.label?.icon;
      const hasIcon = !!iconShapes && iconShapes.length > 0;
      const iconSize = styles.remoteCursor.labelIconSize;
      const iconSpace = hasIcon
        ? iconSize + styles.remoteCursor.labelIconGap
        : 0;

      const contentHeight = Math.max(labelFontSize, hasIcon ? iconSize : 0);
      const labelWidth = textWidth + iconSpace + labelPadding * 2;
      const labelHeight = contentHeight + labelPadding * 2;

      // Detect RTL to position label on the correct side of cursor. Uses the
      // block direction (inline-math source excluded), matching how the block
      // itself lays out, so the label sits on the same side as the caret.
      const isCursorRTL = getBlockDirection(block, state.marks) === "rtl";

      // In RTL, label extends to the left of cursor; in LTR, to the right
      let labelX = isCursorRTL ? cursorPos.x - labelWidth : cursorPos.x;
      let labelY = cursorPos.y - labelHeight - styles.remoteCursor.labelGap;

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
      ctx.fillStyle = caretColor;
      ctx.beginPath();
      ctx.roundRect(
        labelX,
        labelY,
        labelWidth,
        labelHeight,
        styles.remoteCursor.labelBorderRadius,
      );
      ctx.fill();

      // The glyph leads the name (left in LTR, right in RTL); the text then
      // occupies the remaining width on the trailing side.
      const nameDirection = getTextDirection(labelText);
      const labelTextColor = styles.remoteCursor.labelTextColor;

      if (hasIcon) {
        const iconX =
          nameDirection === "rtl"
            ? labelX + labelWidth - labelPadding - iconSize
            : labelX + labelPadding;
        const iconY = labelY + (labelHeight - iconSize) / 2;
        drawLabelIcon(ctx, iconShapes, iconX, iconY, iconSize, labelTextColor);
      }

      // Draw label text with correct direction, centered on the content height.
      const textBaselineY = labelY + (labelHeight + labelFontSize) / 2 - 2;
      ctx.fillStyle = labelTextColor;
      ctx.direction = nameDirection;
      ctx.fillText(
        labelText,
        nameDirection === "rtl"
          ? labelX + labelWidth - labelPadding - iconSpace
          : labelX + labelPadding + iconSpace,
        textBaselineY,
      );
      ctx.direction = "ltr";
    }
  }

  // Render out-of-view peer indicators in the left margin, pinned to the
  // viewport edges.
  if (outOfViewPeers.length > 0) {
    renderOutOfViewIndicators(
      ctx,
      session.outOfViewIndicatorHitAreas,
      outOfViewPeers,
      viewport,
      styles,
    );
  } else {
    session.outOfViewIndicatorHitAreas.length = 0;
  }
}

/**
 * Render only the cursor on a separate layer (for blink animation).
 * This is much faster than re-rendering the entire page.
 */
/**
 * Paint the local caret. When `landingStartedAt` marks a recent navigation, the
 * caret is drawn mid-morph — a circle that squishes into the bar — otherwise as
 * the plain vertical bar. Sets `fillStyle` to the cursor color either way.
 */
function drawCaret(
  ctx: CanvasRenderingContext2D,
  cursorPos: { x: number; y: number; height: number },
  styles: EditorStyles,
  landingStartedAt?: number | null,
) {
  ctx.fillStyle = styles.cursor.color;

  const duration = styles.cursor.landingDuration;
  const progress =
    landingStartedAt != null
      ? caretLandingProgress(Date.now(), landingStartedAt, duration)
      : 1;

  if (progress >= 1) {
    ctx.fillRect(
      cursorPos.x,
      cursorPos.y,
      styles.cursor.width,
      cursorPos.height,
    );
    return;
  }

  const shape = caretLandingShape(
    progress,
    styles.cursor.width,
    cursorPos.height,
    styles.cursor.landingRadius,
  );
  const cx = cursorPos.x + styles.cursor.width / 2;
  const cy = cursorPos.y + cursorPos.height / 2;
  ctx.beginPath();
  ctx.roundRect(
    cx - shape.halfWidth,
    cy - shape.halfHeight,
    shape.halfWidth * 2,
    shape.halfHeight * 2,
    shape.cornerRadius,
  );
  ctx.fill();
}

export function renderCursorLayer(
  ctx: CanvasRenderingContext2D,
  session: InteractionSession,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
  heightIndex?: BlockHeightIndex,
  /**
   * Timestamp (`Date.now()`-relative) at which the local caret last navigated to
   * a new position, or `null` when no landing morph is in flight. Drives the
   * circle-to-bar flourish; the surface keeps this layer repainting until the
   * morph finishes.
   */
  caretLandingStartedAt?: number | null,
) {
  // Save context state
  ctx.save();

  // Clear the cursor layer
  // Note: Context is already scaled by DPR in layers.ts, so use CSS pixels here
  ctx.clearRect(0, 0, viewport.width, viewport.height);

  // Render caret decorations (e.g. remote peer cursors) first, so they appear
  // behind the local cursor.
  const carets = collectCaretDecorations(state);
  if (carets.length > 0) {
    renderCaretDecorations(
      ctx,
      session,
      state,
      viewport,
      styles,
      carets,
      heightIndex,
    );
  }

  const flatCursor = state.document.cursor;
  const contentSelection = state.document.contentSelection;
  const activeCaret =
    flatCursor ??
    (contentSelection
      ? {
          position: { blockIndex: 0, textIndex: 0 },
          lastUpdate: contentSelection.lastUpdate ?? 0,
        }
      : null);

  // Only render if one caret currency exists, the editor is focused, and the
  // caret is visible (not blinking).
  // Don't render cursor in a readonly document. Gate on `isReadonlyBase` (not
  // `mode === "readonly"`) so the caret stays hidden while a readonly editor is
  // in `select` mode during a drag-selection.
  // While a cursor drag (the loupe/magnifier gesture) is active, force the caret
  // solid: the magnifier composites this layer, and a paused finger that stops
  // refreshing the caret would otherwise let it enter its blink-off phase and
  // vanish from the loupe.
  const isCursorDragging = session.touch?.isCursorDrag === true;
  if (
    !activeCaret ||
    !state.view.isFocused ||
    state.ui.mode === "readonly" ||
    state.ui.isReadonlyBase ||
    (!isCursorDragging && isCursorBlinking(activeCaret, styles))
  ) {
    ctx.restore();
    return;
  }

  // Don't show cursor when there's an active selection
  const hasActiveSelection =
    (state.document.selection && !state.document.selection.isCollapsed) ||
    (contentSelection && !isContentSelectionCollapsed(contentSelection));
  if (hasActiveSelection) {
    ctx.restore();
    return;
  }

  const cursorBlockIndex = flatCursor
    ? flatCursor.position.blockIndex
    : state.document.page.blocks.findIndex(
        (candidate) => candidate.id === contentSelection!.focus.blockId,
      );
  if (cursorBlockIndex < 0) {
    ctx.restore();
    return;
  }
  const block = state.document.page.blocks[cursorBlockIndex];
  if (!block || block.deleted) return;

  if (!isTextualBlock(block)) {
    ctx.restore();
    return;
  }

  // Optimization: Skip rendering if cursor block is completely outside viewport
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  const visibleBlocks = state.view.visibleBlocks;
  const cursorVisibleIndex =
    heightIndex?.visibleIndexOfOriginal(cursorBlockIndex) ??
    visibleBlocks.findIndex(
      (visibleBlock) => visibleBlock.originalIndex === cursorBlockIndex,
    );
  let currentY =
    styles.canvas.paddingTop -
    viewport.scrollY +
    (heightIndex && cursorVisibleIndex >= 0
      ? heightIndex.offsetOfVisibleIndex(cursorVisibleIndex)
      : 0);
  if (!heightIndex) {
    for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
      const visibleBlock = visibleBlocks[visibleIdx];
      if (visibleBlock.originalIndex >= cursorBlockIndex) break;
      currentY += getBlockHeight(
        state.nodes,
        state.marks,
        visibleBlock,
        maxWidth,
        styles,
        visibleIdx === 0,
      );
    }
  }

  const blockHeight = getBlockHeight(
    state.nodes,
    state.marks,
    block,
    maxWidth,
    styles,
    cursorVisibleIndex === 0,
  );
  if (cursorVisibleIndex >= 0) {
    heightIndex?.setExactHeight(cursorVisibleIndex, blockHeight);
  }
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
  let targetCursorIndex = flatCursor?.position.textIndex ?? 0;
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
    heightIndex,
  );

  if (!cursorPos) {
    ctx.restore();
    return;
  }

  // Draw the caret — as a plain bar, or mid-"landing" morph if it just moved
  // here. Leaves fillStyle set to the cursor color for the touch handle below.
  drawCaret(ctx, cursorPos, styles, caretLandingStartedAt);

  // Draw cursor drag handle on touch devices (small circle below cursor)
  if (isTouchDevice()) {
    const handleRadius = styles.cursor.handleRadius;
    const handleStemHeight = styles.cursor.handleStemHeight;
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
 * Delegates to the block's TextNode (same geometry as the caret + selection).
 */
function getPositionCoordinates(
  position: { blockIndex: number; textIndex: number },
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles,
  heightIndex?: BlockHeightIndex,
  edge?: "start" | "end",
): { x: number; y: number; height: number } | null {
  const block = state.document.page.blocks[position.blockIndex];
  if (!block || block.deleted) return null;
  if (!isTextualBlock(block)) return null;
  const node = state.nodes.get(block.type);
  if (!(node instanceof TextNode)) return null;

  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  // Anchor the block top on the same prefix-height index the content paint and
  // caret use. Without it this walks exact heights from block 0, which drifts
  // from the (estimate-anchored) painted flow for any off-screen block whose
  // estimate ≠ exact height — e.g. wrapped list/todo items — so the handles land
  // away from the highlighted text on a long, scrolled document.
  const blockTop = getBlockTopViewport(
    state,
    position.blockIndex,
    maxWidth,
    viewport,
    styles,
    heightIndex,
  );
  const layout = node.layout({
    block,
    blockIndex: position.blockIndex,
    maxWidth,
    isFirst: false,
    styles,
    marks: state.marks,
  });
  // A handle (edge given) hugs the painted highlight's start/end rect so its stem
  // and ball sit flush with the green band — inside a tall formula a boundary
  // caret would instead span the whole height and dangle. Fall back to the caret
  // rect for a block that paints no band, or for a plain caret (no edge).
  const selection = state.document.selection;
  if (edge && selection) {
    const band = selectionHighlightEdge(
      node,
      layout,
      selection,
      position.blockIndex,
      styles.canvas.paddingLeft,
      blockTop,
      edge,
    );
    if (band) return band;
  }
  return node.caretRect(
    layout,
    position.textIndex,
    styles.canvas.paddingLeft,
    blockTop,
    state,
    block.id,
    edge,
  );
}

/**
 * Get selection handle positions for rendering.
 * Returns coordinates for both anchor and focus handles.
 */
function getSelectionHandlePositionsForRender(
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles,
  heightIndex?: BlockHeightIndex,
): {
  anchor: { x: number; y: number; height: number; isTop: boolean } | null;
  focus: { x: number; y: number; height: number; isTop: boolean } | null;
} | null {
  const selection = state.document.selection;
  if (!selection || selection.isCollapsed || isNodeSelection(selection)) {
    return null;
  }

  const isForward = selection.isForward;

  // Each handle hugs the SELECTED side of its offset: the document-start handle
  // faces its content to the right, the document-end handle to the left. Without
  // this a handle on an operator (`+`, `=`) — whose edges share their source
  // offset with the surrounding math space and any neighbouring construct's
  // boundary — drifts out past the operator, so the pair brackets more than the
  // green highlight covers. (Forward: anchor is the start, focus the end.)
  const anchorCoords = getPositionCoordinates(
    selection.anchor,
    state,
    viewport,
    styles,
    heightIndex,
    isForward ? "start" : "end",
  );
  const focusCoords = getPositionCoordinates(
    selection.focus,
    state,
    viewport,
    styles,
    heightIndex,
    isForward ? "end" : "start",
  );

  if (!anchorCoords || !focusCoords) {
    return null;
  }

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
/**
 * Paint the block-reorder affordances: the left-gutter grip on the hovered
 * block, and — while a reorder drag is active — the insertion line at the drop
 * gap. Both are ephemeral chrome derived from `ui.hoveredDragHandleBlockId` /
 * `ui.blockDrag`; neither is document content. No-ops when neither is set (e.g.
 * on touch devices, which have no hover).
 */
function renderBlockDrag(
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles,
  visibility?: VisibleBlockRange,
) {
  const hoveredId = state.ui.hoveredDragHandleBlockId;
  const drag = state.ui.blockDrag;
  // An external drag (dropped image file) shows the same insertion line, but has
  // no source block — so no gutter grip, only the line.
  const externalDropIndex = state.ui.externalDropIndex;
  if (!hoveredId && !drag && externalDropIndex == null) return;

  const visibleBlocks = state.view.visibleBlocks;
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  const activeDropIndex = drag ? drag.dropIndex : externalDropIndex;
  const dropIndex =
    activeDropIndex != null
      ? Math.max(0, Math.min(activeDropIndex, visibleBlocks.length))
      : -1;

  // One top-to-bottom walk: record the hovered block's box and the y of the drop
  // gap (`dropIndex` is an insertion index, so the gap before block `i`). Both
  // targets are on-screen during a mouse interaction, so we can stop once both
  // are resolved and we've passed the fold.
  //
  // Anchor the walk at the content paint's `visibility` snapshot rather than the
  // document top. The on-screen flow is laid out from `visibility.startY` using
  // the height index (which carries *estimates* for the off-screen blocks above
  // the fold); re-deriving y by summing exact heights from block 0 would drift
  // from the painted positions and land the grip/line on the wrong block.
  const startIndex = visibility?.start ?? 0;
  let currentY =
    visibility?.startY ?? styles.canvas.paddingTop - viewport.scrollY;
  let hoveredTop: number | null = null;
  let hoveredAnchorY = 0;
  let lineY: number | null = null;

  for (let i = startIndex; i <= visibleBlocks.length; i++) {
    if (i === dropIndex) lineY = currentY;
    if (i === visibleBlocks.length) break;
    const block = visibleBlocks[i];
    const blockHeight = getBlockHeight(
      state.nodes,
      state.marks,
      block,
      maxWidth,
      styles,
      i === 0,
    );
    if (block.id === hoveredId) {
      hoveredTop = currentY;
      // Align the grip with the block's first content, not its box top — the
      // node knows where that is (past a heading's space-above, a card's outer
      // margin). Layout is memoized, so this re-reads the cached geometry.
      const view = state.nodes.get(block.type) ?? new UnknownNode();
      hoveredAnchorY = view.gutterAnchorY({
        block,
        blockIndex: i,
        maxWidth,
        isFirst: i === 0,
        styles,
        marks: state.marks,
      });
    }
    currentY += blockHeight;
    if (
      currentY > viewport.height &&
      (hoveredId === null || hoveredTop !== null) &&
      (dropIndex < 0 || lineY !== null)
    ) {
      break;
    }
  }

  const color = styles.cursor.color;
  ctx.save();

  if (hoveredTop !== null) {
    renderDragGrip(
      ctx,
      styles.canvas.paddingLeft,
      hoveredTop + hoveredAnchorY,
      color,
    );
  }

  if (lineY !== null) {
    const left = styles.canvas.paddingLeft;
    const right = viewport.width - styles.canvas.paddingRight;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(left, lineY);
    ctx.lineTo(right, lineY);
    ctx.stroke();
    // Left end-cap dot so the line reads as an insertion marker.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(left, lineY, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * The "grip" dots (2 columns × 3 rows) painted in the gutter band of the
 * hovered block, centered horizontally in the hit band and vertically on `cy`
 * (the block's `gutterAnchorY` — its first content line).
 */
function renderDragGrip(
  ctx: CanvasRenderingContext2D,
  gutterRight: number,
  cy: number,
  color: string,
) {
  const cx = gutterRight - BLOCK_DRAG_HANDLE_HIT_WIDTH / 2;
  const colGap = BLOCK_DRAG_HANDLE_GRIP_WIDTH / 3;
  const rowGap = BLOCK_DRAG_HANDLE_GRIP_HEIGHT / 3;
  const dotRadius = 1.6;

  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.55;
  for (let col = 0; col < 2; col++) {
    for (let row = 0; row < 3; row++) {
      ctx.beginPath();
      ctx.arc(
        cx + (col - 0.5) * colGap,
        cy + (row - 1) * rowGap,
        dotRadius,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }
  ctx.restore();
}

export function renderSelectionHandles(
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
  heightIndex?: BlockHeightIndex,
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
    heightIndex,
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
    // Handle at top of selection: circle above, stem spanning down the line.
    // Circle center is above the line.
    const circleY = y - stemHeight - radius;

    // Draw the stem: a vertical bar from the circle down the full text height,
    // so the edge marker spans the line rather than only tipping it.
    ctx.fillRect(
      x - stemWidth / 2,
      y - stemHeight,
      stemWidth,
      stemHeight + lineHeight,
    );

    // Draw the circle
    ctx.beginPath();
    ctx.arc(x, circleY, radius, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Handle at bottom of selection: stem spanning up the line, circle below.
    // Circle center is below the line.
    const circleY = y + lineHeight + stemHeight + radius;

    // Draw the stem: a vertical bar from the top of the line down to the
    // circle, spanning the full text height.
    ctx.fillRect(x - stemWidth / 2, y, stemWidth, lineHeight + stemHeight);

    // Draw the circle
    ctx.beginPath();
    ctx.arc(x, circleY, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}
