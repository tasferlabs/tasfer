/**
 * A wide table's sideways scroll: where the offset lives, how it moves, and the
 * scrollbar under the grid.
 *
 * A table wider than the page (see `tableGridWidth`) shows one page-width
 * window onto its grid. How far that window is scrolled is this device's view
 * of the table, not part of the document — the same as the page's own scroll —
 * so it is kept in the block's slot of `ui.nodeViewState`, never syncs, and
 * starts at the left edge whenever the editor opens.
 *
 * The offset is stored as given and clamped on every read, so a table that
 * loses columns (here or from a peer) never shows past its new right edge.
 */

import {
  scrolledTableLayout,
  type TableLayout,
  tableScrollRange,
} from "./geometry";
import type { Point } from "@tasfer/editor/rendering/nodes/Node";
import type { EditorState } from "@tasfer/editor/state-types";

/** The part of a table's view-state slot this module owns. */
interface ScrollViewState {
  scrollX?: number;
}

/** The scrollbar's thickness, and the shortest its thumb gets. */
const SCROLLBAR_THICKNESS = 4;
const SCROLLBAR_MIN_THUMB = 32;

/** How far a table is scrolled sideways, clamped to what `layout` allows. */
export function tableScrollX(
  state: EditorState,
  blockId: string,
  layout: TableLayout,
): number {
  const view = state.ui.nodeViewState[blockId] as ScrollViewState | undefined;
  const stored = view?.scrollX ?? 0;
  return Math.max(0, Math.min(tableScrollRange(layout), stored));
}

/**
 * Store a table's sideways offset, keeping whatever else the block's
 * view-state slot holds (a drag in flight).
 */
export function withTableScrollX(
  state: EditorState,
  blockId: string,
  scrollX: number,
): EditorState {
  const previous = state.ui.nodeViewState[blockId] as
    ScrollViewState | undefined;
  if ((previous?.scrollX ?? 0) === scrollX) return state;
  const next: ScrollViewState = { ...previous, scrollX };
  if (scrollX === 0) delete next.scrollX;
  return {
    ...state,
    ui: {
      ...state.ui,
      nodeViewState: { ...state.ui.nodeViewState, [blockId]: next },
    },
  };
}

/**
 * The layout as this device sees it: scrolled by the table's offset. Rounded
 * to whole pixels so the hairlines stay crisp while a trackpad feeds in
 * fractional steps (the stored offset keeps the fractions, so slow swipes
 * still add up).
 */
export function viewedTableLayout(
  layout: TableLayout,
  state: EditorState,
  blockId: string,
): TableLayout {
  return scrolledTableLayout(
    layout,
    Math.round(tableScrollX(state, blockId, layout)),
  );
}

/**
 * Scroll a table by `deltaX` px. `null` when it does not scroll, or is already
 * at the end it is being pushed toward — the gesture then belongs to the page.
 */
export function scrollTableBy(
  state: EditorState,
  blockId: string,
  layout: TableLayout,
  deltaX: number,
): EditorState | null {
  const range = tableScrollRange(layout);
  if (range <= 0 || deltaX === 0) return null;
  const current = tableScrollX(state, blockId, layout);
  const next = Math.max(0, Math.min(range, current + deltaX));
  if (next === current) return null;
  return withTableScrollX(state, blockId, next);
}

/**
 * Scroll the least distance that shows `left..right` (grid x, unscrolled)
 * inside the page-width window. `null` when it already shows. A span wider than
 * the window is shown from its left end.
 */
export function revealTableSpan(
  state: EditorState,
  blockId: string,
  layout: TableLayout,
  left: number,
  right: number,
): EditorState | null {
  const range = tableScrollRange(layout);
  if (range <= 0) return null;
  const current = tableScrollX(state, blockId, layout);
  let next = current;
  if (left < current) next = left;
  else if (right > current + layout.maxWidth) {
    next = Math.min(left, right - layout.maxWidth);
  }
  next = Math.max(0, Math.min(range, next));
  return next === current ? null : withTableScrollX(state, blockId, next);
}

/** Whether a scrolled layout's grid runs past the window on either side. */
export function tableOverflows(layout: TableLayout): boolean {
  return tableScrollRange(layout) > 0;
}

/** The scrollbar thumb under a wide table, in canvas coordinates. */
export interface TableScrollbar {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Pixels of scroll per pixel the thumb moves. */
  readonly scale: number;
}

/**
 * Where the thumb sits for a scrolled layout (`gridX` carries the offset), or
 * `null` for a table that fits. It runs along the block's bottom margin under
 * the grid, its length the share of the grid in view, the way a page
 * scrollbar's thumb is.
 *
 * Given the viewport's bottom edge (`viewportBottom`, in `origin`'s space), it
 * is sticky: while the grid runs past the bottom of the screen the thumb rides
 * the screen's bottom edge over the rows, so a tall table can be scrolled
 * sideways without first scrolling down to its end. It never rises above the
 * grid's top.
 */
export function tableScrollbar(
  layout: TableLayout,
  origin: Point,
  viewportBottom?: number,
): TableScrollbar | null {
  const range = tableScrollRange(layout);
  if (range <= 0) return null;
  const track = layout.maxWidth;
  const width = Math.min(
    track,
    Math.max(SCROLLBAR_MIN_THUMB, (track * layout.maxWidth) / layout.gridWidth),
  );
  const travel = track - width;
  const progress = Math.max(0, Math.min(1, -layout.gridX / range));
  const gap = Math.max(
    2,
    (layout.style.marginBottom - SCROLLBAR_THICKNESS) / 2,
  );
  const gridTop = origin.y + layout.gridTop;
  let y = gridTop + layout.gridHeight + gap;
  if (viewportBottom !== undefined) {
    const pinned = viewportBottom - gap - SCROLLBAR_THICKNESS;
    y = Math.max(gridTop + gap, Math.min(y, pinned));
  }
  return {
    x: origin.x + progress * travel,
    y,
    width,
    height: SCROLLBAR_THICKNESS,
    scale: travel > 0 ? range / travel : 0,
  };
}
