/**
 * The "add one here" strips along the grid's outer edges.
 *
 * A row or a column is almost always added at the END of the grid, and the
 * structural menu made that the same three-step gesture as any other edit: put
 * the caret in the last cell, open the grip, pick "Add row below". The strips
 * are the one-click version of exactly that: rest the pointer past the grid's
 * right edge and a band lights up with a plus in it; click, and there is a new
 * column. The bottom edge does the same for rows.
 *
 * Geometry only — where the band sits and where the pointer has to be for it to
 * count. `TableNode` paints it and binds the click, the same split the
 * column-resize bands already use.
 *
 * Only two of the four edges carry a strip, and neither omission is an
 * oversight:
 *
 *   - The LEFT gutter is the block-reorder grab band (see
 *     `BLOCK_DRAG_HANDLE_HIT_WIDTH`), which spans every block's full height. A
 *     strip there would fight the grip for the same pixels on every table.
 *   - There is no ADD strip above the grid because there is nothing for it to
 *     add: GFM writes the first row as the column titles and has no syntax for
 *     a row before them, so `insertRow` refuses that position outright. The top
 *     margin carries the column-move grips instead (`TableNode`'s
 *     `columnMoveRegion`), which is the one thing a band over a column can
 *     usefully mean.
 *
 * Both remaining sides live in space the table already owns — the page's right
 * gutter and the block's own bottom margin — so a strip never displaces text
 * and never covers a cell a click was aimed at.
 *
 * A table wider than the page scrolls sideways, and the strips follow what is
 * on screen: the bottom one spans only the part of the grid in view, and the
 * right one appears once the grid's right edge has been scrolled into view —
 * a strip at the page's edge while more columns hide behind it would add a
 * column somewhere the user cannot see.
 */

import type { TableLayout } from "./geometry";
import type { Point } from "@tasfer/editor/rendering/nodes/Node";

/** Which outer edge a strip sits on, and therefore what it adds. */
export type TableEdge = "right" | "bottom";

/** An axis-aligned box in canvas coordinates. */
export interface TableEdgeBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One edge's strip: the band that paints, and the area that catches a pointer. */
export interface TableEdgeStrip extends TableEdgeBox {
  readonly edge: TableEdge;
  /**
   * The catchment, which is deliberately larger than the band and starts at the
   * grid's own border: a 12px target is a fussy thing to hit, and the space
   * between the grid and the strip is dead pixels the pointer crosses on its
   * way. It never reaches back OVER the grid, so a click aimed at the last
   * column's text is never taken. The right one starts a few pixels out, past
   * the grab band of the grid's right edge, which widens the table.
   */
  readonly hit: TableEdgeBox;
}

/** Space between the grid's border and the painted band. */
const STRIP_GAP = 3;
/** The band's thickness across its short axis. */
const STRIP_THICKNESS = 12;
/** Below this there is no room to draw a band that reads as one. */
const STRIP_MIN_THICKNESS = 8;
/**
 * How far past the grid the pointer still counts as "on the edge". Mirrors the
 * reorder grip's band on the other side, so the two gutters answer to a pointer
 * at the same distance. Capped rather than "the whole gutter" because a narrow
 * page centers its column: the right margin can be hundreds of pixels, and a
 * strip that appeared halfway across the page would read as unrelated to the
 * table.
 */
const STRIP_REACH = 28;
/**
 * How far out from the grid's right edge the right strip's catchment begins:
 * just past the edge's own resize band (4px each side for a mouse), which the
 * strip would otherwise cover, outranking it.
 */
const RIGHT_EDGE_GRAB = 5;

/** Whether `p` is inside `box`. */
export function withinEdgeBox(box: TableEdgeBox, p: Point): boolean {
  return (
    p.x >= box.x &&
    p.x <= box.x + box.width &&
    p.y >= box.y &&
    p.y <= box.y + box.height
  );
}

/**
 * The strips a table at `origin` offers, given the page's right gutter.
 * `layout` is the layout as shown — scrolled, for a table wider than the page.
 *
 * An edge with too little room around it is left out rather than drawn cramped
 * — the bottom margin and the gutter are both theme values a host can shrink,
 * and half a band with a clipped plus in it is worse than no affordance.
 */
export function tableEdgeStrips(
  layout: TableLayout,
  origin: Point,
  gutterRight: number,
): readonly TableEdgeStrip[] {
  if (layout.rows.length === 0 || layout.columns.length === 0) return [];

  const gridTop = origin.y + layout.gridTop;
  const gridBottom = gridTop + layout.gridHeight;
  const gridLeft = origin.x + layout.gridX;
  const gridRight = gridLeft + layout.gridWidth;
  // The page-width window a scrolled table is seen through.
  const windowRight = origin.x + layout.maxWidth;
  const visibleLeft = Math.max(gridLeft, origin.x);
  const visibleWidth = Math.min(gridRight, windowRight) - visibleLeft;
  const strips: TableEdgeStrip[] = [];

  const rightReach = Math.min(gutterRight, STRIP_REACH);
  // A pixel of slack: the scroll offset is rounded when drawn, so a table
  // scrolled all the way can stop a fraction short of the window's edge.
  const rightEdgeInView = gridRight <= windowRight + 1;
  if (rightEdgeInView && rightReach - STRIP_GAP >= STRIP_MIN_THICKNESS) {
    strips.push({
      edge: "right",
      x: gridRight + STRIP_GAP,
      y: gridTop,
      width: Math.min(STRIP_THICKNESS, rightReach - STRIP_GAP),
      height: layout.gridHeight,
      hit: {
        x: gridRight + RIGHT_EDGE_GRAB,
        y: gridTop,
        width: rightReach - RIGHT_EDGE_GRAB,
        height: layout.gridHeight,
      },
    });
  }

  // The bottom strip lives in the block's own outer margin, so the pointer stays
  // inside this block's band — the region walk only offers a node the regions of
  // the block the pointer is over, and a strip past the margin would belong to
  // whatever block comes next.
  const bottomReach = layout.style.marginBottom;
  if (bottomReach - STRIP_GAP >= STRIP_MIN_THICKNESS) {
    strips.push({
      edge: "bottom",
      x: visibleLeft,
      y: gridBottom + STRIP_GAP,
      width: visibleWidth,
      height: Math.min(STRIP_THICKNESS, bottomReach - STRIP_GAP),
      // One pixel clear of the grid's own bottom hairline, which the column
      // resize bands still answer for — this region outranks them, and the
      // corner where the two meet should stay a resize target.
      hit: {
        x: visibleLeft,
        y: gridBottom + 1,
        width: visibleWidth,
        height: bottomReach - 1,
      },
    });
  }

  return strips;
}
