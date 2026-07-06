import { currentFontFamily, measureCharsUpToIndex } from "./fonts";
import {
  getContentWithComposition,
  TextNode,
  type TextNodeLayout,
} from "./nodes/TextNode";
import type { MarkRegistry } from "./rendering/marks";
import type { NodeRegistry } from "./rendering/nodes/Node";
import { getBlockHeight } from "./rendering/renderer";
import { getTextDirection } from "./rtl";
import type { Block, CharRun, MarkSpan } from "./serlization/loadPage";
import type {
  CursorState,
  EditorState,
  EditorStyles,
  PartialSelectionState,
  Position,
  SelectionState,
  ViewportState,
  VisibleBlockRange,
} from "./state-types";
import {
  caretStep,
  caretTokenClamp,
  caretVerticalStep,
  createInitialCursorState,
  getBlockTextContent,
  getBlockTextLength,
  selectionRangeAt,
  transformTypedInput,
} from "./state-utils";
import { getEditorStyles, getTextStyle } from "./styles";
import { isTextualBlock } from "./sync/block-registry";
import { getVisibleTextFromRuns } from "./sync/char-runs";
import {
  findNextVisibleBlockIndex,
  findPreviousVisibleBlockIndex,
} from "./sync/reducer";

// ---------------------------------------------------------------------------
// Geometry coordinator
//
// This module owns NO text geometry of its own. It walks the document to find
// a block's top Y, then delegates caret/selection/hit-test math to the TextNode
// registered for the block (state.nodes), so every pass — paint, caret,
// hit-test, selection — consumes the same canonical layout().
// ---------------------------------------------------------------------------

/** The TextNode registered for this block, or null for non-text blocks. */
function textNodeFor(state: EditorState, block: Block): TextNode | null {
  if (!isTextualBlock(block)) return null;
  const node = state.nodes.get(block.type);
  return node instanceof TextNode ? node : null;
}

/** Canonical layout for a textual block at the current content width. */
function layoutFor(
  node: TextNode,
  block: Block,
  blockIndex: number,
  maxWidth: number,
  styles: EditorStyles,
  marks: MarkRegistry,
): TextNodeLayout {
  return node.layout({
    block,
    blockIndex,
    maxWidth,
    isFirst: false,
    styles,
    marks,
  });
}

/** Top Y of a block in document space (origin at canvas paddingTop). */
function getBlockTopDocument(
  state: EditorState,
  blockIndex: number,
  maxWidth: number,
  styles: EditorStyles,
  viewport?: ViewportState,
  visibility?: VisibleBlockRange,
): number {
  const visibleBlocks = state.view.visibleBlocks;
  const canStartFromPaintedRange =
    !!viewport &&
    !!visibility &&
    visibleBlocks[visibility.start]?.originalIndex <= blockIndex;
  let visibleIdx = canStartFromPaintedRange ? visibility.start : 0;
  let y = canStartFromPaintedRange
    ? visibility.startY + viewport.scrollY
    : styles.canvas.paddingTop;
  for (; visibleIdx < visibleBlocks.length; visibleIdx++) {
    const block = visibleBlocks[visibleIdx];
    if (block.originalIndex >= blockIndex) break;
    y += getBlockHeight(
      state.nodes,
      state.marks,
      block,
      maxWidth,
      styles,
      visibleIdx === 0,
    );
  }
  return y;
}

/** Index of the layout line containing `textIndex` (first match), or -1. */
function lineIndexAt(layout: TextNodeLayout, textIndex: number): number {
  for (let i = 0; i < layout.lines.length; i++) {
    const line = layout.lines[i];
    if (textIndex >= line.startIndex && textIndex <= line.endIndex) return i;
  }
  return -1;
}

/**
 * The "column" to preserve when moving the caret between lines. For LTR text
 * this is the logical offset within the line; for RTL it is the measured x
 * offset from the line start (visual column), matching
 * getTextIndexAtRelativePosition's RTL handling.
 */
function relativeColumn(
  block: { charRuns: CharRun[]; formats: MarkSpan[] },
  layout: TextNodeLayout,
  lineStartIndex: number,
  textIndex: number,
): number {
  if (!layout.isRTL) return textIndex - lineStartIndex;
  return measureCharsUpToIndex(
    block.charRuns,
    block.formats,
    lineStartIndex,
    textIndex,
    layout.textStyle.fontSize,
    layout.textStyle.fontWeight,
    layout.fontFamily,
    layout.fonts,
    layout.codePadding,
    layout.marks,
    layout.replCharWidths,
  );
}

/**
 * Get the text index at a relative position within a line
 * Used to maintain horizontal position when moving up/down between lines
 */
export function getTextIndexAtRelativePosition(
  lineStartIndex: number,
  lineEndIndex: number,
  relativePosition: number,
  block?: Block,
  maxWidth?: number,
  styles?: EditorStyles,
  nodes?: NodeRegistry,
  marks?: MarkRegistry,
): number {
  // If no block info provided, use simple logical positioning
  if (!block || !maxWidth || !styles || !nodes) {
    const lineLength = lineEndIndex - lineStartIndex;
    const targetIndex = lineStartIndex + Math.min(relativePosition, lineLength);
    return targetIndex;
  }

  if (!isTextualBlock(block)) {
    const lineLength = lineEndIndex - lineStartIndex;
    return lineStartIndex + Math.min(relativePosition, lineLength);
  }

  // Check if this is RTL text
  const isRTL =
    getTextDirection(getVisibleTextFromRuns(block.charRuns)) === "rtl";

  if (!isRTL) {
    // LTR: simple logical positioning
    const lineLength = lineEndIndex - lineStartIndex;
    const targetIndex = lineStartIndex + Math.min(relativePosition, lineLength);
    return targetIndex;
  }

  // RTL: find the text index that corresponds to the visual position
  const textStyle = getTextStyle(styles, nodes, block);
  const fontFamily = currentFontFamily(styles);
  const codePadding = styles.textFormats.code.padding;

  // Find the character position that has the target visual position
  // For RTL: relativePosition is widthFromStart (distance from line start)
  // We need to find the charIndex where widthFromStart matches relativePosition
  let bestIndex = lineStartIndex;
  let minDistance = Infinity;

  const lineLength = lineEndIndex - lineStartIndex;
  for (let i = 0; i <= lineLength; i++) {
    const charIndex = lineStartIndex + i;

    // Measure from line start to this character position
    const widthFromStart = measureCharsUpToIndex(
      block.charRuns,
      block.formats,
      lineStartIndex,
      charIndex,
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily,
      styles.fonts,
      codePadding,
      marks,
    );

    const distance = Math.abs(widthFromStart - relativePosition);

    if (distance < minDistance) {
      minDistance = distance;
      bestIndex = charIndex;
    }
  }

  return bestIndex;
}

export function getCursorDocumentCoords(
  position: Position,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
  visibility?: VisibleBlockRange,
): { x: number; y: number; height: number } | null {
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  const block = state.document.page.blocks[position.blockIndex];
  if (!block) return null;

  const node = textNodeFor(state, block);
  if (!node) return null;

  const layout = layoutFor(
    node,
    block,
    position.blockIndex,
    maxWidth,
    styles,
    state.marks,
  );
  const blockTop = getBlockTopDocument(
    state,
    position.blockIndex,
    maxWidth,
    styles,
    viewport,
    visibility,
  );
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
 * The vertical span + edge x a selection HANDLE must hug at one endpoint, read
 * from the SAME highlight rects `paint` fills — never from `caretRect`. `which`
 * is the selection's `"start"` (topmost row, its LEFT edge) or `"end"`
 * (bottommost row, its RIGHT edge).
 *
 * Handles key off the painted band, not the caret, because the two disagree
 * inside a tall construct: a boundary caret beside a `\sqrt{…}`/matrix spans the
 * whole formula height, while the green highlight hugs just the selected glyphs.
 * Sizing the handle from the caret then left its stem and ball dangling below the
 * band. Reading the band's own rect keeps the stem flush and the ball at the
 * corner for every node type (plain text is unaffected — there the line rect and
 * the caret already coincide). Returns null when the block paints no highlight,
 * so the caller can fall back to the caret rect.
 */
export function selectionHighlightEdge(
  node: TextNode,
  layout: TextNodeLayout,
  selection: { anchor: Position; focus: Position; isForward: boolean },
  blockIndex: number,
  originX: number,
  blockTop: number,
  which: "start" | "end",
): { x: number; y: number; height: number } | null {
  const rects = node.selectionRects(
    layout,
    selection,
    blockIndex,
    originX,
    blockTop,
  );
  if (rects.length === 0) return null;
  // Rects arrive per visual row; the selection's start sits on the topmost row
  // (leftmost on a tie), its end on the bottommost (rightmost on a tie).
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const r = which === "start" ? sorted[0] : sorted[sorted.length - 1];
  return which === "start"
    ? { x: r.x, y: r.y, height: r.height }
    : { x: r.x + r.width, y: r.y, height: r.height };
}

/**
 * Document-space coordinates of a selection HANDLE at one endpoint: the edge of
 * the painted highlight (see {@link selectionHighlightEdge}), falling back to the
 * caret rect for a block that paints no band. The handle analogue of
 * {@link getCursorDocumentCoords}, so its stem/ball land on the green highlight
 * rather than a boundary caret's full height.
 */
export function getSelectionHandleCoords(
  position: Position,
  which: "start" | "end",
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
  visibility?: VisibleBlockRange,
): { x: number; y: number; height: number } | null {
  const selection = state.document.selection;
  if (!selection) return null;

  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  const block = state.document.page.blocks[position.blockIndex];
  if (!block) return null;
  const node = textNodeFor(state, block);
  if (!node) return null;

  const layout = layoutFor(
    node,
    block,
    position.blockIndex,
    maxWidth,
    styles,
    state.marks,
  );
  const blockTop = getBlockTopDocument(
    state,
    position.blockIndex,
    maxWidth,
    styles,
    viewport,
    visibility,
  );
  const edge = selectionHighlightEdge(
    node,
    layout,
    selection,
    position.blockIndex,
    styles.canvas.paddingLeft,
    blockTop,
    which,
  );
  if (edge) return edge;
  return node.caretRect(
    layout,
    position.textIndex,
    styles.canvas.paddingLeft,
    blockTop,
    state,
    block.id,
    which,
  );
}

/**
 * Get cursor coordinates accounting for composition text.
 * When composing, this returns the position at the END of the composition text
 * which may be on a different line if the text wrapped.
 */
export function getCursorCoordinatesWithComposition(
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
): { x: number; y: number; height: number } | null {
  if (!state.document.cursor) return null;

  const position = state.document.cursor.position;
  const block = state.document.page.blocks[position.blockIndex];
  if (!block || block.deleted) return null;
  if (!isTextualBlock(block)) return null;

  const node = textNodeFor(state, block);
  if (!node) return null;

  if (!state.ui.composition?.isComposing || !state.ui.composition.text) {
    return getCursorDocumentCoords(position, state, viewport, styles);
  }

  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  // Fold the active composition into the layout exactly as paint() does, then
  // place the caret at the END of the injected preview. The preview goes through
  // the same node/mark transform as the commit (see getContentWithComposition),
  // so in math a CJK burst injects as `\text{…}` — the caret must land after that
  // wrapper, not `text.length` past the raw caret. Mirror that transform here.
  const transform = transformTypedInput(
    state,
    block,
    position.textIndex,
    state.ui.composition.text,
  );
  const previewText = transform?.input ?? state.ui.composition.text;
  const insertAt = transform?.insertAt ?? position.textIndex;
  const content = getContentWithComposition(block, state, position.blockIndex);
  const layout = node.computeLayout(block, maxWidth, styles, content);
  const blockTop = getBlockTopDocument(
    state,
    position.blockIndex,
    maxWidth,
    styles,
  );
  return node.caretRect(
    layout,
    insertAt + previewText.length,
    styles.canvas.paddingLeft,
    blockTop,
  );
}

export function getCursorYPosition(
  position: Position,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
  visibility?: VisibleBlockRange,
): { top: number; bottom: number } | null {
  const coords = getCursorDocumentCoords(
    position,
    state,
    viewport,
    styles,
    visibility,
  );
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
  styles: EditorStyles = getEditorStyles(state),
  visibility?: VisibleBlockRange,
): number | null {
  const cursorPos = getCursorYPosition(
    position,
    state,
    viewport,
    styles,
    visibility,
  );
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
  styles: EditorStyles,
  visibility?: VisibleBlockRange,
): Position | null {
  let currentY = visibility?.startY ?? startY;

  const visibleBlocks = state.view.visibleBlocks;

  const startIndex = visibility?.start ?? 0;
  for (
    let visibleIdx = startIndex;
    visibleIdx < visibleBlocks.length;
    visibleIdx++
  ) {
    const block = visibleBlocks[visibleIdx];
    const blockHeight = getBlockHeight(
      state.nodes,
      state.marks,
      block,
      maxWidth,
      styles,
      visibleIdx === 0,
    );

    // Check if click is within this block's Y bounds
    if (y >= currentY && y < currentY + blockHeight) {
      const node = textNodeFor(state, block);
      if (!node) {
        return { blockIndex: block.originalIndex, textIndex: 0 };
      }

      const layout = layoutFor(
        node,
        block,
        block.originalIndex,
        maxWidth,
        styles,
        state.marks,
      );

      // LTR: left → start, right → end. RTL: left → end, right → start.
      const pick = (line: { startIndex: number; endIndex: number }): number =>
        isLeftPadding === layout.isRTL ? line.endIndex : line.startIndex;

      for (const line of layout.lines) {
        const lineY = currentY + layout.insetY + line.y;
        if (y >= lineY && y < lineY + line.height) {
          return { blockIndex: block.originalIndex, textIndex: pick(line) };
        }
      }

      // Click is in the block's bottom padding — use the last line.
      if (layout.lines.length > 0) {
        const last = layout.lines[layout.lines.length - 1];
        return { blockIndex: block.originalIndex, textIndex: pick(last) };
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
      (b) => b.id === lastVisibleBlock.id,
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

/**
 * Options for resolving a viewport point to a caret position.
 */
export interface ViewportHitOptions {
  /**
   * Finger-drag resolution — used by the mobile magnifier caret-drag. Over
   * inline/block math the caret follows the finger to its nearest stop with row
   * hysteresis, so a vertical drag descends smoothly between a fraction's
   * numerator and denominator instead of flickering out to the construct's
   * boundary or twitching between the tightly-stacked rows. A precise tap omits
   * this and uses the vertical-band hit-test.
   */
  readonly drag?: boolean;
  /**
   * The caret's current position — the hysteresis anchor for `drag`. Passed to
   * the node's hit-test only when it lands in the same block, so a drag WITHIN a
   * math construct is stable; a drag that crosses into another block starts
   * fresh.
   */
  readonly prev?: Position | null;
}

export function getTextPositionFromViewport(
  x: number,
  y: number,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
  visibility?: VisibleBlockRange,
  opts?: ViewportHitOptions,
): Position | null {
  let currentY =
    visibility?.startY ?? styles.canvas.paddingTop - viewport.scrollY;
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
      styles,
      visibility,
    );
  }

  // We need to iterate through blocks from the start to get correct Y positions
  // (same as renderPage does), but we can break early once we pass the visible area
  const visibleBlocks = state.view.visibleBlocks;
  const allBlocks = state.document.page.blocks;

  const startIndex = visibility?.start ?? 0;
  // The last block the walk actually visited, and whether it stopped early
  // because it passed the bottom of the viewport (more content continues below
  // the fold) rather than reaching the document's final block.
  let lastWalkedOriginalIndex = -1;
  let brokeEarly = false;
  for (
    let visibleIdx = startIndex;
    visibleIdx < visibleBlocks.length;
    visibleIdx++
  ) {
    const block = visibleBlocks[visibleIdx];
    const blockHeight = getBlockHeight(
      state.nodes,
      state.marks,
      block,
      maxWidth,
      styles,
      visibleIdx === 0,
    );

    // Check if click is within this block's Y bounds
    if (y >= currentY && y < currentY + blockHeight) {
      const node = textNodeFor(state, block);
      if (!node || !isTextualBlock(block)) {
        return { blockIndex: block.originalIndex, textIndex: 0 };
      }

      const layout = layoutFor(
        node,
        block,
        block.originalIndex,
        maxWidth,
        styles,
        state.marks,
      );
      // The hysteresis anchor only applies when the current caret is in THIS
      // block; a drag that crossed block boundaries has no prior row here.
      const prevIndex =
        opts?.prev && opts.prev.blockIndex === block.originalIndex
          ? opts.prev.textIndex
          : null;
      const textIndex = node.positionFromPoint(
        block,
        layout,
        x,
        y,
        styles.canvas.paddingLeft,
        currentY,
        opts?.drag ?? false,
        prevIndex,
      );
      return { blockIndex: block.originalIndex, textIndex };
    }

    lastWalkedOriginalIndex = block.originalIndex;

    // Break early if we've passed the visible area (click can only be in visible area)
    if (currentY > viewport.height) {
      brokeEarly = true;
      break;
    }

    currentY += blockHeight;
  }

  // Point is below everything the walk reached. When it stopped early at the
  // bottom edge (a long document scrolled above its end), clamp to the last
  // block walked rather than the document's final block: without this, dragging
  // a selection — or holding it at the bottom for edge auto-scroll — past the
  // viewport bottom snaps the focus straight to the end of the document and
  // selects everything below the fold at once. Clamping keeps the focus at the
  // fold so auto-scroll reveals the rest one step at a time. Only when the walk
  // genuinely reached the final block is the point truly below all content.
  if (y >= currentY && visibleBlocks.length > 0) {
    const targetOriginalIndex = brokeEarly
      ? lastWalkedOriginalIndex
      : visibleBlocks[visibleBlocks.length - 1].originalIndex;
    const targetBlock = allBlocks[targetOriginalIndex];
    const content = getBlockTextContent(targetBlock);

    return {
      blockIndex: targetOriginalIndex,
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
 * The word/token RANGE a double-click / double-tap at `(x, y)` selects, asked of
 * the block's node directly from the point (see {@link TextNode.wordRangeFromPoint}).
 * A node that has no point-based word selection — every plain-text block —
 * returns null, so the caller falls back to the offset-based word selection. Only
 * a direct block hit resolves a range; a tap in padding / below the content
 * (where there is no word) returns null too. Shares the visible-block Y walk with
 * {@link getTextPositionFromViewport} so the geometry matches the painted flow.
 */
export function getWordRangeFromViewport(
  x: number,
  y: number,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
  visibility?: VisibleBlockRange,
): { blockIndex: number; start: number; end: number } | null {
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  if (
    x < styles.canvas.paddingLeft ||
    x > styles.canvas.paddingLeft + maxWidth
  ) {
    return null;
  }
  let currentY =
    visibility?.startY ?? styles.canvas.paddingTop - viewport.scrollY;
  const visibleBlocks = state.view.visibleBlocks;
  const startIndex = visibility?.start ?? 0;
  for (
    let visibleIdx = startIndex;
    visibleIdx < visibleBlocks.length;
    visibleIdx++
  ) {
    const block = visibleBlocks[visibleIdx];
    const blockHeight = getBlockHeight(
      state.nodes,
      state.marks,
      block,
      maxWidth,
      styles,
      visibleIdx === 0,
    );
    if (y >= currentY && y < currentY + blockHeight) {
      const node = textNodeFor(state, block);
      if (!node || !isTextualBlock(block)) return null;
      const layout = layoutFor(
        node,
        block,
        block.originalIndex,
        maxWidth,
        styles,
        state.marks,
      );
      const range = node.wordRangeFromPoint(
        layout,
        x,
        y,
        styles.canvas.paddingLeft,
        currentY,
      );
      return range
        ? {
            blockIndex: block.originalIndex,
            start: range.start,
            end: range.end,
          }
        : null;
    }
    if (currentY > viewport.height) break;
    currentY += blockHeight;
  }
  return null;
}

/**
 * The `originalIndex` of the visible block whose vertical bounds contain canvas-y
 * `y`, or `null` when `y` is above the first block or below the last. Unlike
 * {@link getTextPositionFromViewport}, this does NOT clamp to the nearest block —
 * used for hover affordances that must switch OFF in the empty space below the
 * last block (e.g. the math-block backdrop).
 */
export function getBlockIndexAtPoint(
  y: number,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
  visibility?: VisibleBlockRange,
): number | null {
  let currentY =
    visibility?.startY ?? styles.canvas.paddingTop - viewport.scrollY;
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  const visibleBlocks = state.view.visibleBlocks;

  const startIndex = visibility?.start ?? 0;
  for (let i = startIndex; i < visibleBlocks.length; i++) {
    const block = visibleBlocks[i];
    const blockHeight = getBlockHeight(
      state.nodes,
      state.marks,
      block,
      maxWidth,
      styles,
      i === 0,
    );
    if (y >= currentY && y < currentY + blockHeight) {
      return block.originalIndex;
    }
    if (currentY > viewport.height) break;
    currentY += blockHeight;
  }
  return null;
}

/**
 * The insertion index in `[0..N]` (N = `state.view.visibleBlocks.length`) where a
 * block dragged to canvas-y `y` would land, choosing the gap nearest `y` by
 * comparing against each block's vertical midpoint: `k` means "between
 * `visibleBlocks[k-1]` and `visibleBlocks[k]`". `0` is the head of the document,
 * `N` is the tail. Used by the block-reorder drag to derive the `afterBlockId`
 * argument for {@link import("./actions/edit-actions").MOVE_BLOCK}
 * (`k === 0` → `null`, else `visibleBlocks[k-1].id`).
 *
 * Walks from the on-screen window down to the tail so the index stays correct
 * for drops past the fold; heights come from the shared per-block cache via
 * `getBlockHeight`, so the walk is cheap.
 *
 * The walk is anchored at the latest content paint's `visibility` snapshot
 * (`startY`/`start`) rather than the document top. On-screen blocks are laid out
 * from `visibility.startY` using the height index, which carries *estimates* for
 * the off-screen blocks above the fold; summing exact heights from block 0 would
 * drift from the painted positions and pick the gap under the wrong block. This
 * mirrors {@link getBlockIndexAtPoint}, which the hover hit-test already anchors
 * the same way. Without a snapshot it falls back to the document-top walk.
 */
export function dropIndexAtPoint(
  y: number,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
  visibility?: VisibleBlockRange,
): number {
  const visibleBlocks = state.view.visibleBlocks;
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  const startIndex = visibility?.start ?? 0;
  let currentY =
    visibility?.startY ?? styles.canvas.paddingTop - viewport.scrollY;

  for (let i = startIndex; i < visibleBlocks.length; i++) {
    const blockHeight = getBlockHeight(
      state.nodes,
      state.marks,
      visibleBlocks[i],
      maxWidth,
      styles,
      i === 0,
    );
    // Nearest gap: y above this block's midpoint inserts before it.
    if (y < currentY + blockHeight / 2) return i;
    currentY += blockHeight;
  }
  return visibleBlocks.length;
}

/**
 * Whether canvas-y `y` lands in the empty area *below* the last visible block
 * (not merely below the fold). Used to distinguish a click in the trailing
 * whitespace from a click on the block's own last line — only the former
 * escapes a self-contained block into a fresh paragraph. Returns `false` when
 * there are no visible blocks.
 */
export function isPointBelowContent(
  y: number,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
): boolean {
  const visibleBlocks = state.view.visibleBlocks;
  if (visibleBlocks.length === 0) return false;

  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  let currentY = styles.canvas.paddingTop - viewport.scrollY;
  for (let i = 0; i < visibleBlocks.length; i++) {
    currentY += getBlockHeight(
      state.nodes,
      state.marks,
      visibleBlocks[i],
      maxWidth,
      styles,
      i === 0,
    );
  }
  return y >= currentY;
}

/**
 * Whether canvas-y `y` lands in the empty area *above* the first block (the top
 * padding). Mirror of {@link isPointBelowContent} for the upward escape — only a
 * click above the content escapes a self-contained first block into a paragraph
 * above. Returns `false` when there are no visible blocks.
 */
export function isPointAboveContent(
  y: number,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
): boolean {
  if (state.view.visibleBlocks.length === 0) return false;
  return y < styles.canvas.paddingTop - viewport.scrollY;
}

/**
 * Get selection handle positions for mobile selection dragging.
 * Returns coordinates for both anchor and focus handles.
 * The anchor handle appears at the start of selection, focus at the end.
 */
export function getSelectionHandlePositions(
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
): {
  anchor: { x: number; y: number; height: number; isTop: boolean } | null;
  focus: { x: number; y: number; height: number; isTop: boolean } | null;
} | null {
  const selection = state.document.selection;
  if (!selection || selection.isCollapsed || isNodeSelection(selection)) {
    return null;
  }

  // isTop: true means the handle circle is above the stem (at top of selection).
  // The anchor sits at the selection's start when forward, its end when backward
  // (and vice-versa for the focus). Each handle hugs the painted highlight's
  // start/end edge so its stem lands on the green band, not a boundary caret.
  const isForward = selection.isForward;
  const anchorCoords = getSelectionHandleCoords(
    selection.anchor,
    isForward ? "start" : "end",
    state,
    viewport,
    styles,
  );
  const focusCoords = getSelectionHandleCoords(
    selection.focus,
    isForward ? "end" : "start",
    state,
    viewport,
    styles,
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
 * Check if pixel coordinates (x, y) fall within the actual visual selection rectangles.
 * This accounts for text wrapping and only returns true if the point is on highlighted text.
 * Used for mobile tap detection to avoid clearing selection when tapping empty space.
 */
export function isPointWithinSelectionRects(
  x: number,
  y: number,
  state: EditorState,
  viewport: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
  visibility?: VisibleBlockRange,
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
  // Anchor at the painted-visibility snapshot when given (the same basis as the
  // content paint), so a scrolled document with off-screen blocks whose
  // estimated height ≠ exact height — e.g. wrapped list/todo items — still maps
  // the point onto the highlighted rectangles instead of a flow walked exactly
  // from block 0.
  let currentY =
    visibility?.startY ?? styles.canvas.paddingTop - viewport.scrollY;

  // Iterate through blocks that are part of the selection (only visible blocks)
  const visibleBlocks = state.view.visibleBlocks;

  for (
    let visibleIdx = visibility?.start ?? 0;
    visibleIdx < visibleBlocks.length;
    visibleIdx++
  ) {
    const block = visibleBlocks[visibleIdx];
    const blockHeight = getBlockHeight(
      state.nodes,
      state.marks,
      block,
      maxWidth,
      styles,
      visibleIdx === 0,
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

    const node = textNodeFor(state, block);
    if (node) {
      const layout = layoutFor(
        node,
        block,
        block.originalIndex,
        maxWidth,
        styles,
        state.marks,
      );
      // Use the same continuous ribbon the local selection paints, so a tap in
      // the trailing space of a line or the gap between two selected blocks
      // counts as touching the selection (and won't dismiss it).
      const rects = node.selectionRects(
        layout,
        selection,
        block.originalIndex,
        styles.canvas.paddingLeft,
        currentY,
        true,
        // Hit-test rects: a whole selected inline-math chip reports its full
        // atomic box, so a tap anywhere on it counts as touching the selection.
        true,
      );
      for (const r of rects) {
        if (x >= r.x && x <= r.x + r.width && y >= r.y && y < r.y + r.height) {
          return true;
        }
      }
    }

    currentY += blockHeight;
  }

  return false;
}

/**
 * Whether the document has a highlighted selection rather than a plain collapsed
 * caret — either a non-empty text range or a visual/atomic block selection (a
 * collapsed selection that sits on a non-textual block, e.g. a selected image or
 * divider). A normal caret on textual content (or no selection at all) is not
 * "active" here.
 *
 * The magnifier loupe is a caret-repositioning tool, so it only engages when
 * there is a caret to move; this gate keeps a long-hold from popping it while a
 * selection is up.
 */
export function hasActiveSelectionHighlight(state: EditorState): boolean {
  const sel = state.document.selection;
  if (!sel) return false;
  if (!sel.isCollapsed) return true;
  const block = state.document.page.blocks[sel.anchor.blockIndex];
  return !!block && !block.deleted && !isTextualBlock(block);
}

/**
 * Index of the block currently held in a *visual block selection* (a selected
 * image/divider/math block), or `null` when the selection is a text caret/range
 * or absent. A visual block selection is encoded as a non-collapsed selection
 * whose anchor and focus sit at the same position on a non-textual block (see
 * `SELECT_VISUAL_BLOCK` / `TAP_SELECT_VISUAL_BLOCK`). Callers — e.g. the click
 * handlers that clear it and the image node that renders resize handles for it —
 * share this one detector instead of re-deriving the shape.
 */
export function getVisualBlockSelectionIndex(
  state: EditorState,
): number | null {
  const sel = state.document.selection;
  if (!sel || sel.isCollapsed) return null;
  if (
    sel.anchor.blockIndex !== sel.focus.blockIndex ||
    sel.anchor.textIndex !== sel.focus.textIndex
  ) {
    return null;
  }
  const block = state.document.page.blocks[sel.anchor.blockIndex];
  if (!block || block.deleted || isTextualBlock(block)) return null;
  return sel.anchor.blockIndex;
}

/**
 * Whether a vertical arrow is *extending an existing range selection* (Shift+Arrow
 * over a non-collapsed selection), as opposed to making the first step of one or
 * moving a bare caret. In that state vertical movement is block/line-granular:
 * intra-block row navigation (a formula's stacked slots — a fraction's halves, a
 * script, an inline chip's rows) must be skipped so the focus leaves the block via
 * ordinary line nav.
 *
 * Descending into those rows while a range is being extended is both pointless and
 * broken: {@link snapSelectionToConstructs} forbids a selection from partially
 * covering a construct, so the interior offset the row-step lands on is immediately
 * snapped back to the construct's (or block's) edge — the focus then oscillates on
 * that edge, press after press, never advancing past the equation (the reported
 * "Shift+Arrow gets stuck at a math block"). Because the first Shift step runs off
 * a still-collapsed selection it descends once (selecting the whole construct via
 * that same snap); every step after is block-granular and escapes cleanly.
 *
 * Plain caret movement clears the selection first, so this is false there and a
 * lone caret still navigates a formula's rows. See {@link moveCursorUp} /
 * {@link moveCursorDown}.
 */
function extendingRangeSelection(state: EditorState): boolean {
  const sel = state.document.selection;
  if (!sel) return false;
  return (
    sel.anchor.blockIndex !== sel.focus.blockIndex ||
    sel.anchor.textIndex !== sel.focus.textIndex
  );
}

/**
 * Move cursor up by one line (not block)
 * If on the first line of a block, moves to the last line of the previous block
 */

export function moveCursorUp(
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
): EditorState {
  if (!state.document.cursor) return createInitialCursorState(state);

  const { blockIndex: blockIndex, textIndex } = state.document.cursor.position;
  const currentBlock = state.document.page.blocks[blockIndex];

  if (!currentBlock || currentBlock.deleted) return state;

  // Handle visual blocks (image/line) - move to previous block
  if (!isTextualBlock(currentBlock)) {
    const prevBlockIndex = findPreviousVisibleBlockIndex(
      state.document.page.blocks,
      blockIndex,
    );
    if (prevBlockIndex !== null) {
      const prevBlock = state.document.page.blocks[prevBlockIndex];
      if (!isTextualBlock(prevBlock)) {
        // Move to previous visual block
        return moveCursorToPosition(state, prevBlockIndex, 0);
      }
      // Move to end of previous text block
      return moveCursorToPosition(
        state,
        prevBlockIndex,
        getBlockTextLength(prevBlock),
      );
    }
    return state;
  }

  // In-block vertical navigation (e.g. inside a formula): a node/mark whose
  // content stacks rows first moves between those rows; only when there is no row
  // above does it fall through to changing text lines. Skipped while extending a
  // range selection — see {@link extendingRangeSelection}.
  if (!extendingRangeSelection(state)) {
    const vUp = caretVerticalStep(state, currentBlock, textIndex, "up");
    if (vUp !== null) return moveCursorToPosition(state, blockIndex, vUp);
  }

  const node = textNodeFor(state, currentBlock);
  if (!node) return state;

  // Calculate maxWidth from viewport or use a default
  const maxWidth = viewport
    ? viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight)
    : 800; // Default fallback

  const layout = layoutFor(
    node,
    currentBlock,
    blockIndex,
    maxWidth,
    styles,
    state.marks,
  );
  const lineIdx = lineIndexAt(layout, textIndex);
  if (lineIdx === -1) return state;

  const line = layout.lines[lineIdx];
  const relativePosition = relativeColumn(
    currentBlock,
    layout,
    line.startIndex,
    textIndex,
  );

  // If not on the first line of the block, move to the previous line within the same block
  if (lineIdx > 0) {
    const prevLine = layout.lines[lineIdx - 1];
    const targetTextIndex = getTextIndexAtRelativePosition(
      prevLine.startIndex,
      prevLine.endIndex,
      relativePosition,
      currentBlock,
      maxWidth,
      styles,
      state.nodes,
      state.marks,
    );
    return moveCursorToPosition(state, blockIndex, targetTextIndex);
  }

  // On the first line of the block, move to the previous block's last line
  const prevBlockIndex = findPreviousVisibleBlockIndex(
    state.document.page.blocks,
    blockIndex,
  );
  if (prevBlockIndex !== null) {
    const prevBlock = state.document.page.blocks[prevBlockIndex];

    // Handle visual blocks (image/line) - position cursor at start of the block
    if (!isTextualBlock(prevBlock)) {
      return moveCursorToPosition(state, prevBlockIndex, 0);
    }

    const prevNode = textNodeFor(state, prevBlock);
    if (!prevNode) {
      return moveCursorToPosition(state, prevBlockIndex, 0);
    }

    const prevLayout = layoutFor(
      prevNode,
      prevBlock,
      prevBlockIndex,
      maxWidth,
      styles,
      state.marks,
    );
    if (prevLayout.lines.length > 0) {
      const lastLine = prevLayout.lines[prevLayout.lines.length - 1];
      const targetTextIndex = getTextIndexAtRelativePosition(
        lastLine.startIndex,
        lastLine.endIndex,
        relativePosition,
        prevBlock,
        maxWidth,
        styles,
        state.nodes,
        state.marks,
      );
      return moveCursorToPosition(state, prevBlockIndex, targetTextIndex);
    }

    // If previous block is empty, just go to its start
    return moveCursorToPosition(state, prevBlockIndex, 0);
  }

  // Already at the first line of the first block, move to start
  return moveCursorToPosition(state, blockIndex, 0);
}
/**
 * Move cursor down by one line (not block)
 * If on the last line of a block, moves to the first line of the next block
 */

export function moveCursorDown(
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
): EditorState {
  if (!state.document.cursor) return createInitialCursorState(state);

  const { blockIndex: blockIndex, textIndex } = state.document.cursor.position;
  const currentBlock = state.document.page.blocks[blockIndex];

  if (!currentBlock || currentBlock.deleted) return state;

  // Handle visual blocks (image/line) - move to next block
  if (!isTextualBlock(currentBlock)) {
    const nextBlockIndex = findNextVisibleBlockIndex(
      state.document.page.blocks,
      blockIndex,
    );
    if (nextBlockIndex !== null) {
      // Visual or text block alike: move to its start
      return moveCursorToPosition(state, nextBlockIndex, 0);
    }
    return state;
  }

  // In-block vertical navigation (e.g. inside a formula): a node/mark whose
  // content stacks rows first moves between those rows; only when there is no row
  // below does it fall through to changing text lines. Skipped while extending a
  // range selection — see {@link extendingRangeSelection}.
  if (!extendingRangeSelection(state)) {
    const vDown = caretVerticalStep(state, currentBlock, textIndex, "down");
    if (vDown !== null) return moveCursorToPosition(state, blockIndex, vDown);
  }

  const node = textNodeFor(state, currentBlock);
  if (!node) return state;

  // Calculate maxWidth from viewport or use a default
  const maxWidth = viewport
    ? viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight)
    : 800; // Default fallback

  const layout = layoutFor(
    node,
    currentBlock,
    blockIndex,
    maxWidth,
    styles,
    state.marks,
  );
  const lineIdx = lineIndexAt(layout, textIndex);
  if (lineIdx === -1) return state;

  const line = layout.lines[lineIdx];
  const relativePosition = relativeColumn(
    currentBlock,
    layout,
    line.startIndex,
    textIndex,
  );

  // If not on the last line of the block, move to the next line within the same block
  if (lineIdx < layout.lines.length - 1) {
    const nextLine = layout.lines[lineIdx + 1];
    const targetTextIndex = getTextIndexAtRelativePosition(
      nextLine.startIndex,
      nextLine.endIndex,
      relativePosition,
      currentBlock,
      maxWidth,
      styles,
      state.nodes,
      state.marks,
    );
    return moveCursorToPosition(state, blockIndex, targetTextIndex);
  }

  // On the last line of the block, move to the next block's first line
  const nextBlockIndex = findNextVisibleBlockIndex(
    state.document.page.blocks,
    blockIndex,
  );
  if (nextBlockIndex !== null) {
    const nextBlock = state.document.page.blocks[nextBlockIndex];

    // Handle visual blocks (image/line) - position cursor at start of the block
    if (!isTextualBlock(nextBlock)) {
      return moveCursorToPosition(state, nextBlockIndex, 0);
    }

    const nextNode = textNodeFor(state, nextBlock);
    if (!nextNode) {
      return moveCursorToPosition(state, nextBlockIndex, 0);
    }

    const nextLayout = layoutFor(
      nextNode,
      nextBlock,
      nextBlockIndex,
      maxWidth,
      styles,
      state.marks,
    );
    if (nextLayout.lines.length > 0) {
      const firstLine = nextLayout.lines[0];
      const targetTextIndex = getTextIndexAtRelativePosition(
        firstLine.startIndex,
        firstLine.endIndex,
        relativePosition,
        nextBlock,
        maxWidth,
        styles,
        state.nodes,
        state.marks,
      );
      return moveCursorToPosition(state, nextBlockIndex, targetTextIndex);
    }

    // If next block is empty, just go to its start
    return moveCursorToPosition(state, nextBlockIndex, 0);
  }

  // Already at the last line of the last block, move to end
  return moveCursorToPosition(
    state,
    blockIndex,
    getBlockTextLength(currentBlock),
  );
}

/**
 * Whether the caret sits on the last visual line of its (textual) block, so a
 * downward move would leave the block. Mirrors {@link moveCursorDown}'s last-line
 * test: an in-block vertical step (e.g. a formula row below) or any line below
 * the caret's line means it is not yet at the bottom. Non-textual blocks have no
 * line concept and report `false` (their escape is driven by the visual-block
 * branch instead). Used to gate "escape into a trailing paragraph" at the
 * document edge for self-contained blocks (code / math / quote).
 */
export function caretAtBlockBottom(
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
): boolean {
  if (!state.document.cursor) return false;

  const { blockIndex, textIndex } = state.document.cursor.position;
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) return false;

  // A row below within the block's own content (e.g. inside a formula) means the
  // caret can still descend without leaving the block.
  if (caretVerticalStep(state, block, textIndex, "down") !== null) return false;

  const node = textNodeFor(state, block);
  if (!node) return true;

  const maxWidth = viewport
    ? viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight)
    : 800;
  const layout = layoutFor(
    node,
    block,
    blockIndex,
    maxWidth,
    styles,
    state.marks,
  );
  const lineIdx = lineIndexAt(layout, textIndex);
  if (lineIdx === -1) return true;
  return lineIdx >= layout.lines.length - 1;
}

/**
 * Mirror of {@link caretAtBlockBottom} for upward moves: whether the caret sits
 * on the *first* visual line of its (textual) block, so an upward move would
 * leave the block. A row above within the block's own content (e.g. a formula
 * row) or any line above the caret's line means it is not yet at the top.
 * Non-textual blocks report `false`. Used to gate "escape into a paragraph
 * above" at the document start for self-contained blocks (code / math / quote).
 */
export function caretAtBlockTop(
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
): boolean {
  if (!state.document.cursor) return false;

  const { blockIndex, textIndex } = state.document.cursor.position;
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) return false;

  // A row above within the block's own content means the caret can still ascend
  // without leaving the block.
  if (caretVerticalStep(state, block, textIndex, "up") !== null) return false;

  const node = textNodeFor(state, block);
  if (!node) return true;

  const maxWidth = viewport
    ? viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight)
    : 800;
  const layout = layoutFor(
    node,
    block,
    blockIndex,
    maxWidth,
    styles,
    state.marks,
  );
  const lineIdx = lineIndexAt(layout, textIndex);
  return lineIdx <= 0;
}
/**
 * Move cursor up by one page
 * Moves the cursor up by approximately one viewport height
 */

export function moveCursorPageUp(
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
): EditorState {
  if (!state.document.cursor || !viewport) return state;

  // Move up by viewport height worth of lines
  // Estimate ~10-20 lines per page depending on font size
  const linesToMove = Math.floor(viewport.height / 30); // Approximate line height

  let newState = state;
  for (let i = 0; i < linesToMove && newState.document.cursor; i++) {
    newState = moveCursorUp(newState, viewport, styles);
  }

  return newState;
}
/**
 * Move cursor down by one page
 * Moves the cursor down by approximately one viewport height
 */

export function moveCursorPageDown(
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles(state),
): EditorState {
  if (!state.document.cursor || !viewport) return state;

  // Move down by viewport height worth of lines
  // Estimate ~10-20 lines per page depending on font size
  const linesToMove = Math.floor(viewport.height / 30); // Approximate line height

  let newState = state;
  for (let i = 0; i < linesToMove && newState.document.cursor; i++) {
    newState = moveCursorDown(newState, viewport, styles);
  }

  return newState;
}
// Selection Functions

export function startSelection(
  state: EditorState,
  position: Position,
): EditorState {
  // Clear active formats when starting a selection
  let newState = state;
  if (state.ui.activeMarksMode.type === "explicit") {
    newState = {
      ...state,
      ui: {
        ...state.ui,
        activeMarksMode: { type: "inherit" },
      },
    };
  }

  return updateSelection(newState, {
    anchor: position,
    focus: position,
    isForward: true,
    isCollapsed: true,
  });
}

/** −1 if `to` is before `from` in document order, +1 if after, 0 if the same. */
function positionDelta(from: Position, to: Position): number {
  if (to.blockIndex !== from.blockIndex)
    return Math.sign(to.blockIndex - from.blockIndex);
  return Math.sign(to.textIndex - from.textIndex);
}

/**
 * Snap one endpoint of a CROSS-block selection within its own block. Everything
 * from the endpoint to the block edge facing the other endpoint is selected, so
 * that edge is the in-block pivot — the node/mark then widens the endpoint out of
 * any construct it sits in (level-aware; against a block edge that means the
 * top-level construct). `role` says which side of the resolved pair to read back.
 */
function snapCrossBlockEndpoint(
  state: EditorState,
  pos: Position,
  otherIsAfter: boolean,
  role: "anchor" | "focus",
  focusEdge: "start" | "end",
): Position {
  const block = state.document.page.blocks[pos.blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) return pos;
  const pivot = otherIsAfter ? getBlockTextLength(block) : 0;
  const [a, f] =
    role === "anchor" ? [pos.textIndex, pivot] : [pivot, pos.textIndex];
  const snapped = selectionRangeAt(state, block, a, f, focusEdge);
  if (!snapped) return pos;
  return {
    ...pos,
    textIndex: role === "anchor" ? snapped.anchor : snapped.focus,
  };
}

/**
 * Snap a selection's endpoints so it never partially covers a connected math
 * construct, LEVEL-AWARELY (see {@link CaretModel.selectionRange}). The moving
 * `focus` snaps in its direction of travel — right/down to take a construct in,
 * left/up to drop it (this is what makes "select less" work) — while the fixed
 * `anchor` widens outward. `prevFocus` supplies the travel direction; absent or
 * unmoved it defaults to the range's own orientation. A collapsed selection is a
 * bare caret — legal inside a construct for editing — so it passes through.
 */
export function snapSelectionToConstructs(
  state: EditorState,
  anchor: Position,
  focus: Position,
  prevFocus: Position | undefined,
): { anchor: Position; focus: Position } {
  if (isCollapsedSelection({ anchor, focus })) return { anchor, focus };
  const forward = isForwardSelection({ anchor, focus });
  const travel = prevFocus ? positionDelta(prevFocus, focus) : 0;
  const focusEdge: "start" | "end" =
    travel > 0 ? "end" : travel < 0 ? "start" : forward ? "end" : "start";

  if (anchor.blockIndex === focus.blockIndex) {
    const block = state.document.page.blocks[anchor.blockIndex];
    if (!block || block.deleted || !isTextualBlock(block)) {
      return { anchor, focus };
    }
    const snapped = selectionRangeAt(
      state,
      block,
      anchor.textIndex,
      focus.textIndex,
      focusEdge,
    );
    if (!snapped) return { anchor, focus };
    return {
      anchor: { ...anchor, textIndex: snapped.anchor },
      focus: { ...focus, textIndex: snapped.focus },
    };
  }

  // Cross-block: snap each endpoint within its own block against the far edge.
  const focusIsAfter = focus.blockIndex > anchor.blockIndex;
  return {
    anchor: snapCrossBlockEndpoint(
      state,
      anchor,
      focusIsAfter,
      "anchor",
      focusEdge,
    ),
    focus: snapCrossBlockEndpoint(
      state,
      focus,
      !focusIsAfter,
      "focus",
      focusEdge,
    ),
  };
}

export function updateSelectionFocus(
  state: EditorState,
  position: Position,
): EditorState {
  if (!state.document.selection) {
    return startSelection(state, position);
  }

  // If we have an initial boundary (from double/triple-click), adjust anchor based on drag direction
  if (state.document.selection.initialBoundary) {
    const { start, end } = state.document.selection.initialBoundary;

    // Determine if the new focus is before start or after end
    const isFocusBeforeStart =
      position.blockIndex < start.blockIndex ||
      (position.blockIndex === start.blockIndex &&
        position.textIndex < start.textIndex);

    const isFocusAfterEnd =
      position.blockIndex > end.blockIndex ||
      (position.blockIndex === end.blockIndex &&
        position.textIndex > end.textIndex);

    let newAnchor: Position;
    let newFocus: Position;

    if (isFocusBeforeStart) {
      // Dragging backward (before start): anchor at end, focus at new position
      newAnchor = end;
      newFocus = position;
    } else if (isFocusAfterEnd) {
      // Dragging forward (after end): anchor at start, focus at new position
      newAnchor = start;
      newFocus = position;
    } else {
      // Focus is within the initial boundary: keep the entire word/block selected
      // Determine which boundary is closer to position to decide which end to anchor
      const distanceToStart =
        Math.abs(position.blockIndex - start.blockIndex) * 10000 +
        Math.abs(position.textIndex - start.textIndex);
      const distanceToEnd =
        Math.abs(position.blockIndex - end.blockIndex) * 10000 +
        Math.abs(position.textIndex - end.textIndex);

      // Keep full selection: if closer to start, set focus at start and anchor at end (and vice versa)
      if (distanceToStart < distanceToEnd) {
        newAnchor = end;
        newFocus = start;
      } else {
        newAnchor = start;
        newFocus = end;
      }
    }

    return commitSelectionFocus(
      state,
      newAnchor,
      newFocus,
      state.document.selection.initialBoundary,
    );
  }

  return commitSelectionFocus(state, state.document.selection.anchor, position);
}

/**
 * Snap a selection's endpoints out of any construct they fall inside, write the
 * selection, and park the caret on the snapped focus. Keeping the caret on the
 * focus (not the raw interior stop a move/hit-test landed on) is what lets the
 * NEXT Shift+Arrow or drag step resume from the construct's edge — otherwise
 * crossing an atomic construct costs one keystroke per interior caret stop it
 * snapped over (it looks "stuck", selecting the same whole construct each press).
 */
function commitSelectionFocus(
  state: EditorState,
  anchor: Position,
  focus: Position,
  initialBoundary?: SelectionState["initialBoundary"],
): EditorState {
  const snapped = snapSelectionToConstructs(
    state,
    anchor,
    focus,
    state.document.selection?.focus,
  );
  const next = updateSelection(state, {
    anchor: snapped.anchor,
    focus: snapped.focus,
    ...(initialBoundary ? { initialBoundary } : {}),
  });
  return next.document.cursor ? updateCursor(next, snapped.focus) : next;
}

export function clearSelection(state: EditorState): EditorState {
  return {
    ...state,
    document: {
      ...state.document,
      selection: null,
    },
  };
}

// State Update Functions (Pure Functions)

export function updateCursor(
  state: EditorState,
  position: Position | null,
): EditorState {
  // Any caret move invalidates caret-anchored node/mark scratch (e.g. math's
  // in-progress command rendering, `\in`→∈): clear it so a finished value never
  // lingers once the caret leaves the spot that armed it. The owning node/mark
  // re-arms it after its own edit when still warranted (in its `TEXT_INPUTTED`
  // observer).
  const ui = state.ui.caretScratch
    ? { ...state.ui, caretScratch: null }
    : state.ui;
  return {
    ...state,
    ui,
    document: {
      ...state.document,
      cursor: position
        ? {
            position,
            lastUpdate: Date.now(),
          }
        : null,
    },
  };
}
export function updateSelection(
  state: EditorState,
  updates: PartialSelectionState | null,
): EditorState {
  return {
    ...state,
    document: {
      ...state.document,
      selection: !!updates
        ? {
            anchor: updates.anchor,
            focus: updates.focus,
            isForward: isForwardSelection(updates),
            isCollapsed: isCollapsedSelection(updates),
            lastUpdate: Date.now(),
            // Only preserve initialBoundary if explicitly provided in updates
            // This prevents unintentional preservation of gesture boundaries in programmatic selections
            ...("initialBoundary" in updates && updates.initialBoundary !== null
              ? { initialBoundary: updates.initialBoundary }
              : {}),
          }
        : null,
    },
  };
}
export function isForwardSelection(selection: PartialSelectionState): boolean {
  return (
    selection.anchor.blockIndex < selection.focus.blockIndex ||
    (selection.anchor.blockIndex === selection.focus.blockIndex &&
      selection.anchor.textIndex <= selection.focus.textIndex)
  );
}

export function isCollapsedSelection(
  selection: PartialSelectionState,
): boolean {
  return (
    selection.anchor.blockIndex === selection.focus.blockIndex &&
    selection.anchor.textIndex === selection.focus.textIndex
  );
}

/**
 * Whether `selection` is a *node selection* — a whole block held as an atomic
 * unit (an image or divider, or a math / code block selected whole) rather than
 * a text range. Encoded as a non-collapsed selection whose anchor and focus
 * share one position; see {@link getVisualBlockSelectionIndex} and the
 * whole-block branch of `deleteSelectedText`. Such a selection has no draggable
 * text endpoints, so the mobile selection-handle passes skip it and the block
 * paints its own selected state.
 */
export function isNodeSelection(selection: SelectionState | null): boolean {
  return (
    selection !== null &&
    !selection.isCollapsed &&
    isCollapsedSelection(selection)
  );
}
export function updateFocus(
  state: EditorState,
  isFocused: boolean,
): EditorState {
  const newState: EditorState = {
    ...state,
    view: { ...state.view, isFocused },
  };

  // When losing focus, cancel any active composition
  if (!isFocused && state.ui.composition) {
    return {
      ...newState,
      ui: {
        ...newState.ui,
        composition: null,
      },
    };
  }

  return newState;
}
export function isCursorBlinking(cursor: CursorState, styles: EditorStyles) {
  const now = Date.now();

  // If the cursor was recently updated (within one blink interval), always show it
  if (now - cursor.lastUpdate < styles.cursor.blinkInterval) {
    return false;
  }

  // Otherwise, blink based on time (alternating every blinkInterval)
  return Math.floor(now / styles.cursor.blinkInterval) % 2 !== 0;
} // Cursor Movement Functions

export function moveCursorToPosition(
  state: EditorState,
  blockIndex: number,
  textIndex: number,
  preserveActiveFormats: boolean = false,
): EditorState {
  const allBlocks = state.document.page.blocks;
  if (allBlocks.length === 0) return state;

  let clampedBlockIndex = Math.max(
    0,
    Math.min(blockIndex, allBlocks.length - 1),
  );
  let block = allBlocks[clampedBlockIndex];

  // `page.blocks` keeps tombstones, so index arithmetic (blockIndex ± 1) can
  // land on a deleted block. The cursor must always rest on visible content:
  // resolve to the nearest visible block — forward first (the caller aimed
  // past the target), then backward. Silently keeping the old cursor here hid
  // real bugs ("Enter inserts a line but the caret stays behind").
  if (!block || block.deleted) {
    let resolved = -1;
    for (let i = clampedBlockIndex + 1; i < allBlocks.length; i++) {
      if (!allBlocks[i].deleted) {
        resolved = i;
        break;
      }
    }
    if (resolved === -1) {
      for (let i = clampedBlockIndex - 1; i >= 0; i--) {
        if (!allBlocks[i].deleted) {
          resolved = i;
          break;
        }
      }
    }
    if (resolved === -1) return state;
    clampedBlockIndex = resolved;
    block = allBlocks[clampedBlockIndex];
  }

  const maxTextIndex = getBlockTextLength(block);
  const clampedTextIndex = Math.max(0, Math.min(textIndex, maxTextIndex));

  let newState = updateCursor(state, {
    blockIndex: clampedBlockIndex,
    textIndex: clampedTextIndex,
  });

  // Clear active formats when cursor moves (unless explicitly preserving them, e.g., during typing)
  if (
    !preserveActiveFormats &&
    newState.ui.activeMarksMode.type === "explicit"
  ) {
    newState = {
      ...newState,
      ui: {
        ...newState.ui,
        activeMarksMode: { type: "inherit" },
      },
    };
  }

  return newState;
}

export function moveCursorLeft(state: EditorState): EditorState {
  if (!state.document.cursor) return createInitialCursorState(state);

  const { blockIndex: blockIndex, textIndex } = state.document.cursor.position;
  const currentBlock = state.document.page.blocks[blockIndex];

  if (!currentBlock || currentBlock.deleted) return state;

  // Handle visual blocks (image/line) - move to previous block
  if (!isTextualBlock(currentBlock)) {
    const prevBlockIndex = findPreviousVisibleBlockIndex(
      state.document.page.blocks,
      blockIndex,
    );
    if (prevBlockIndex !== null) {
      const prevBlock = state.document.page.blocks[prevBlockIndex];
      if (!isTextualBlock(prevBlock)) {
        return moveCursorToPosition(state, prevBlockIndex, 0);
      } else if (isTextualBlock(prevBlock)) {
        const prevBlockLength = getBlockTextLength(prevBlock);
        return moveCursorToPosition(state, prevBlockIndex, prevBlockLength);
      }
    }
    return state;
  }

  if (!isTextualBlock(currentBlock)) {
    return state;
  }

  // Check if current block is RTL
  const isRTL =
    getTextDirection(getVisibleTextFromRuns(currentBlock.charRuns)) === "rtl";

  if (isRTL) {
    // In RTL text, visual left is logical forward (increment)
    const currentBlockLength = getBlockTextLength(currentBlock);

    if (textIndex < currentBlockLength) {
      // Logical forward; clamp out of any atomic inline token (e.g. a math chip).
      const target = textIndex + 1;
      const snapped = caretTokenClamp(state, currentBlock, target, "right");
      return moveCursorToPosition(state, blockIndex, snapped ?? target);
    } else {
      // Moving to next visible block
      const nextBlockIndex = findNextVisibleBlockIndex(
        state.document.page.blocks,
        blockIndex,
      );
      if (nextBlockIndex !== null) {
        const nextBlock = state.document.page.blocks[nextBlockIndex];

        // Handle visual blocks (image/line) - move to the block
        if (!isTextualBlock(nextBlock)) {
          return moveCursorToPosition(state, nextBlockIndex, 0);
        }

        if (!isTextualBlock(nextBlock)) {
          return state;
        }
        const nextIsRTL =
          getTextDirection(getVisibleTextFromRuns(nextBlock.charRuns)) ===
          "rtl";

        if (nextIsRTL) {
          // Next block is RTL, position at start (visual right edge)
          return moveCursorToPosition(state, nextBlockIndex, 0);
        } else {
          // Next block is LTR, position at start (visual left edge)
          return moveCursorToPosition(state, nextBlockIndex, 0);
        }
      }
    }
  } else {
    // LTR text: visual left is logical backward (decrement)
    if (textIndex > 0) {
      // Step one position left. In atomic inline content (a math command/
      // construct) the caret snaps to the previous legal stop rather than landing
      // inside `\int`; in plain text it's a normal one-character step.
      const snapped = caretStep(state, currentBlock, textIndex, "left");
      return moveCursorToPosition(state, blockIndex, snapped ?? textIndex - 1);
    } else {
      // Moving to previous visible block
      const prevBlockIndex = findPreviousVisibleBlockIndex(
        state.document.page.blocks,
        blockIndex,
      );
      if (prevBlockIndex !== null) {
        const prevBlock = state.document.page.blocks[prevBlockIndex];

        // Handle visual blocks (image/line) - move to the block
        if (!isTextualBlock(prevBlock)) {
          return moveCursorToPosition(state, prevBlockIndex, 0);
        }

        if (!isTextualBlock(prevBlock)) {
          return state;
        }
        const prevBlockLength = getBlockTextLength(prevBlock);
        const prevIsRTL =
          getTextDirection(getVisibleTextFromRuns(prevBlock.charRuns)) ===
          "rtl";

        if (prevIsRTL) {
          // Previous block is RTL, position at end (visual left edge)
          return moveCursorToPosition(state, prevBlockIndex, prevBlockLength);
        } else {
          // Previous block is LTR, position at end (visual right edge)
          return moveCursorToPosition(state, prevBlockIndex, prevBlockLength);
        }
      }
    }
  }

  return state;
}

export function moveCursorRight(state: EditorState): EditorState {
  if (!state.document.cursor) return createInitialCursorState(state);

  const { blockIndex: blockIndex, textIndex } = state.document.cursor.position;
  const currentBlock = state.document.page.blocks[blockIndex];

  if (!currentBlock || currentBlock.deleted) return state;

  // Handle visual blocks (image/line) - move to next block
  if (!isTextualBlock(currentBlock)) {
    const nextBlockIndex = findNextVisibleBlockIndex(
      state.document.page.blocks,
      blockIndex,
    );
    if (nextBlockIndex !== null) {
      const nextBlock = state.document.page.blocks[nextBlockIndex];
      if (!isTextualBlock(nextBlock)) {
        return moveCursorToPosition(state, nextBlockIndex, 0);
      } else if (isTextualBlock(nextBlock)) {
        return moveCursorToPosition(state, nextBlockIndex, 0);
      }
    }
    return state;
  }

  if (!isTextualBlock(currentBlock)) {
    return state;
  }

  const currentBlockLength = getBlockTextLength(currentBlock);

  // Check if current block is RTL
  const isRTL =
    getTextDirection(getVisibleTextFromRuns(currentBlock.charRuns)) === "rtl";

  if (isRTL) {
    // In RTL text, visual right is logical backward (decrement)
    if (textIndex > 0) {
      // Logical backward; clamp out of any atomic inline token (e.g. a math chip).
      const target = textIndex - 1;
      const snapped = caretTokenClamp(state, currentBlock, target, "left");
      return moveCursorToPosition(state, blockIndex, snapped ?? target);
    } else {
      // Moving to previous visible block
      const prevBlockIndex = findPreviousVisibleBlockIndex(
        state.document.page.blocks,
        blockIndex,
      );
      if (prevBlockIndex !== null) {
        const prevBlock = state.document.page.blocks[prevBlockIndex];

        // Handle visual blocks (image/line) - move to the block
        if (!isTextualBlock(prevBlock)) {
          return moveCursorToPosition(state, prevBlockIndex, 0);
        }

        if (!isTextualBlock(prevBlock)) {
          return state;
        }
        const prevBlockLength = getBlockTextLength(prevBlock);
        const prevIsRTL =
          getTextDirection(getVisibleTextFromRuns(prevBlock.charRuns)) ===
          "rtl";

        if (prevIsRTL) {
          // Previous block is RTL, position at end (visual left edge)
          return moveCursorToPosition(state, prevBlockIndex, prevBlockLength);
        } else {
          // Previous block is LTR, position at end (visual right edge)
          return moveCursorToPosition(state, prevBlockIndex, prevBlockLength);
        }
      }
    }
  } else {
    // LTR text: visual right is logical forward (increment)
    if (textIndex < currentBlockLength) {
      // Step one position right. In atomic inline content (a math command/
      // construct) the caret snaps to the next legal stop rather than landing
      // inside `\int`; in plain text it's a normal one-character step.
      const snapped = caretStep(state, currentBlock, textIndex, "right");
      return moveCursorToPosition(state, blockIndex, snapped ?? textIndex + 1);
    } else {
      // Moving to next visible block
      const nextBlockIndex = findNextVisibleBlockIndex(
        state.document.page.blocks,
        blockIndex,
      );
      if (nextBlockIndex !== null) {
        const nextBlock = state.document.page.blocks[nextBlockIndex];

        // Handle visual blocks (image/line) - move to the block
        if (!isTextualBlock(nextBlock)) {
          return moveCursorToPosition(state, nextBlockIndex, 0);
        }

        if (!isTextualBlock(nextBlock)) {
          return state;
        }
        const nextIsRTL =
          getTextDirection(getVisibleTextFromRuns(nextBlock.charRuns)) ===
          "rtl";

        if (nextIsRTL) {
          // Next block is RTL, position at start (visual right edge)
          return moveCursorToPosition(state, nextBlockIndex, 0);
        } else {
          // Next block is LTR, position at start (visual left edge)
          return moveCursorToPosition(state, nextBlockIndex, 0);
        }
      }
    }
  }

  return state;
}
