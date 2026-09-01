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
   * column's text is never taken.
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
  const gridRight = origin.x + layout.gridWidth;
  const strips: TableEdgeStrip[] = [];

  const rightReach = Math.min(gutterRight, STRIP_REACH);
  if (rightReach - STRIP_GAP >= STRIP_MIN_THICKNESS) {
    strips.push({
      edge: "right",
      x: gridRight + STRIP_GAP,
      y: gridTop,
      width: Math.min(STRIP_THICKNESS, rightReach - STRIP_GAP),
      height: layout.gridHeight,
      hit: {
        x: gridRight,
        y: gridTop,
        width: rightReach,
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
      x: origin.x,
      y: gridBottom + STRIP_GAP,
      width: layout.gridWidth,
      height: Math.min(STRIP_THICKNESS, bottomReach - STRIP_GAP),
      // One pixel clear of the grid's own bottom hairline, which the column
      // resize bands still answer for — this region outranks them, and the
      // corner where the two meet should stay a resize target.
      hit: {
        x: origin.x,
        y: gridBottom + 1,
        width: layout.gridWidth,
        height: bottomReach - 1,
      },
    });
  }

  return strips;
}
