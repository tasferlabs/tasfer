import type {
  IndicatorHitArea,
  InteractionSession,
} from "../events/interaction-session";
import { currentFontFamily, getFontStack } from "../fonts";
import { getTextDirection } from "../rtl";
import { isCursorBlinking } from "../selection";
import type { Block, Char, CharRun, MarkSpan } from "../serlization/loadPage";
import type {
  EditorState,
  EditorStyles,
  NodeOverlay,
  RenderedBlock,
  ViewportState,
} from "../state-types";
import { isTouchDevice } from "../state-utils";
import { getEditorStyles } from "../styles";
import type { AwarenessState } from "../sync/awareness";
import { awarenessCursorToPosition, getColorForPeer } from "../sync/awareness";
import { isTextualBlock } from "../sync/block-registry";
import {
  getCharIdFromRun,
  getVisibleTextFromChars,
  isCharDeleted,
} from "../sync/char-runs";
import type { Operation } from "../sync/sync";
import type { MarkRegistry } from "./marks";
import type { NodeRegionCtx, NodeRegistry } from "./nodes";
import { getContentWithComposition, TextNode, UnknownNode } from "./nodes";
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
// `views` is the per-instance block view registry (from EditorState.nodes).
export function getBlockHeight(
  views: NodeRegistry,
  marks: MarkRegistry,
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
    height = calculateBlockHeight(views, marks, block, maxWidth, styles);
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
      marks,
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
      case "mark_set":
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
      state.nodes,
      state.marks,
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
        visibleIdx === 0,
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
): NodeOverlay[] {
  const overlays: NodeOverlay[] = [];
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  let y = styles.canvas.paddingTop - viewport.scrollY;
  const visibleBlocks = state.view.visibleBlocks;
  for (let i = 0; i < visibleBlocks.length; i++) {
    const block = visibleBlocks[i];
    const height = getBlockHeight(
      state.nodes,
      state.marks,
      block,
      maxWidth,
      styles,
      i === 0,
    );
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
  remoteAwareness?: Map<string, AwarenessState>,
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
      awareness: remoteAwareness,
      requestRedraw,
    });
  }
} // Calculate position from mouse coordinates dynamically

// The image cache lives with the image block (./blocks/ImageNode).
// Re-exported here so existing deep imports from
// `@cypherkit/editor/rendering/renderer` keep resolving.
export { clearFailedImageCache, imageCache } from "../nodes/ImageNode";

// renderLineBlock / renderMathBlock were removed: the `line` and `math` blocks
// now live in rendering/nodes/{LineNode,MathNode}.ts and render via
// the Node registry.

// Calculate block height dynamically based on content and max width
export function calculateBlockHeight(
  views: NodeRegistry,
  marks: MarkRegistry,
  block: Block,
  maxWidth: number,
  styles: EditorStyles,
): number {
  // The height pass reuses the same layout() the painter uses, so
  // wrapping/sizing never drifts. Unknown types fall back to the placeholder
  // node so they reserve their on-screen space in the document flow.
  const view = views.get(block.type) ?? new UnknownNode();
  return view.layout({
    block,
    blockIndex: 0,
    maxWidth,
    isFirst: false,
    styles,
    marks,
  }).height;
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
 * Top Y of a block in viewport space (canvas paddingTop minus scroll).
 * Shared by the cursor layer and the selection-handle pass.
 */
function getBlockTopViewport(
  state: EditorState,
  blockIndex: number,
  maxWidth: number,
  viewport: ViewportState,
  styles: EditorStyles,
): number {
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
  // on); draw it verbatim. Otherwise the caret is ascent+descent tall (text
  // height) anchored at the line top, not full line height.
  return {
    x: rect.x,
    y: rect.y,
    height: rect.exact
      ? rect.height
      : layout.fontMetrics.ascent + layout.fontMetrics.descent,
  };
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
  topOffset: number = 0,
) {
  const abovePeers = peers.filter((p) => p.direction === "above");
  const belowPeers = peers.filter((p) => p.direction === "below");

  const pillHeight = 24;
  const pillPadding = 8;
  const fontSize = 12;
  const chevronSize = 6;
  const gap = 8;

  // Clear previous hit areas (mutate in place — callers hold this same array)
  hitAreas.length = 0;

  ctx.font = `600 ${fontSize}px ${getFontStack(currentFontFamily(styles), styles.fonts)}`;

  // Render indicators for peers above viewport
  abovePeers.forEach((peer, i) => {
    const initial = peer.awareness.user.name?.charAt(0).toUpperCase() || "?";
    const textWidth = ctx.measureText(initial).width;
    const pillWidth = textWidth + pillPadding * 2;

    const x = pillPadding + i * (pillWidth + gap);
    const y = topOffset + pillPadding + chevronSize;

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
    ctx.fillStyle =
      peer.awareness.user.color ||
      getColorForPeer(peer.awareness.user.peerId, styles.remoteCursor.palette);
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
    hitAreas.push({
      x,
      y,
      width: pillWidth,
      height: pillHeight + chevronSize,
      blockIndex: peer.blockIndex,
      textIndex: peer.textIndex,
    });

    // Draw pill background
    ctx.fillStyle =
      peer.awareness.user.color ||
      getColorForPeer(peer.awareness.user.peerId, styles.remoteCursor.palette);
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
  session: InteractionSession,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles,
  remoteAwareness: Map<string, AwarenessState>,
) {
  const outOfViewPeers: OutOfViewPeer[] = [];

  for (const [peerId, awareness] of remoteAwareness) {
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

    // Draw the remote cursor with the peer's color (falling back to the themed
    // palette when the peer supplied none).
    const peerColor =
      awareness.user.color ||
      getColorForPeer(peerId, styles.remoteCursor.palette);
    ctx.fillStyle = peerColor;
    ctx.fillRect(
      cursorPos.x,
      cursorPos.y,
      styles.cursor.width,
      cursorPos.height,
    );

    // Optionally draw a name label above the cursor
    if (awareness.user.name) {
      const labelPadding = styles.remoteCursor.labelPadding;
      const labelFontSize = styles.remoteCursor.labelFontSize;
      ctx.font = `${labelFontSize}px ${getFontStack(currentFontFamily(styles), styles.fonts)}`;
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
      ctx.fillStyle = peerColor;
      ctx.beginPath();
      ctx.roundRect(
        labelX,
        labelY,
        labelWidth,
        labelHeight,
        styles.remoteCursor.labelBorderRadius,
      );
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
      session.outOfViewIndicatorHitAreas,
      outOfViewPeers,
      viewport,
      styles,
      styles.canvas.paddingTop,
    );
  } else {
    session.outOfViewIndicatorHitAreas.length = 0;
  }
}

/**
 * Render only the cursor on a separate layer (for blink animation).
 * This is much faster than re-rendering the entire page.
 */
export function renderCursorLayer(
  ctx: CanvasRenderingContext2D,
  session: InteractionSession,
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
    renderRemoteCursors(ctx, session, state, viewport, styles, remoteAwareness);
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
      state.nodes,
      state.marks,
      visibleBlock,
      maxWidth,
      styles,
      visibleIdx === 0,
    );
    currentY += blockHeight;
  }

  const blockHeight = getBlockHeight(
    state.nodes,
    state.marks,
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
): { x: number; y: number; height: number } | null {
  const block = state.document.page.blocks[position.blockIndex];
  if (!block || block.deleted) return null;
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
  );
  const layout = node.layout({
    block,
    blockIndex: position.blockIndex,
    maxWidth,
    isFirst: false,
    styles,
    marks: state.marks,
  });
  return node.caretRect(
    layout,
    position.textIndex,
    styles.canvas.paddingLeft,
    blockTop,
    state,
    block.id,
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
