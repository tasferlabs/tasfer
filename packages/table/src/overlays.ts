/**
 * The table's host-UI attachment point.
 *
 * A table's structural edits — add a row, drop a column, align one — are
 * relative to the cell the caret is in, so their controls belong beside that
 * cell rather than in a dialog the user has to open, act in, and dismiss. The
 * node cannot draw React chrome itself, so it declares WHERE the controls go and
 * WHAT they would act on; the host maps the key to a component.
 *
 * Geometry and identity only, the same contract `CodeNode`'s language chip uses.
 * No behaviour here, and nothing about how the controls look.
 */

import { tableShapeAt, type TableShape } from "./commands";
import type { TableLayout } from "./geometry";
import { getTableDocument } from "./structured";
import type { NodeOverlay } from "@tasfer/editor/state-types";
import type { ContentTextPoint } from "@tasfer/editor/structured-selection";
import type { NodeRegionCtx } from "@tasfer/editor/rendering/nodes/Node";

/** Overlay key for the table's inline structural controls. */
export const TABLE_TOOLS_OVERLAY = "table-tools";

/** What the host component needs to render and act. */
export interface TableToolsOverlayData {
  /** The grid at the caret — which row/column, how many there are, its align. */
  readonly shape: TableShape;
  /**
   * The whole grid's box, so the controls can clamp themselves to the table
   * instead of drifting off its edge next to a cell in the last column.
   */
  readonly grid: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/**
 * The controls' anchor: the active cell's box, or `null` when nothing should
 * show — a read-only editor, a caret outside this table, or a hole (a column
 * this row has no cell for, which owns no caret and no commands).
 *
 * `layout` is the layout as shown. For a table wider than the page, both boxes
 * are cut to the page-width window it is seen through, and a cell scrolled
 * wholly out of it shows no controls — they would float beside nothing.
 */
export function tableToolsOverlay(
  layout: TableLayout,
  c: NodeRegionCtx,
): NodeOverlay | null {
  if (c.state.ui.isReadonlyBase) return null;
  const focus = c.state.document.contentSelection?.focus;
  if (!focus || focus.kind !== "text" || focus.blockId !== c.block.id) {
    return null;
  }
  const document = getTableDocument(c.block);
  if (!document) return null;
  const shape = tableShapeAt(document, focus as ContentTextPoint);
  if (!shape) return null;
  const cell = layout.cells.find(
    (candidate) =>
      candidate.rowIndex === shape.rowIndex &&
      candidate.columnIndex === shape.columnIndex,
  );
  if (!cell) return null;
  const cellSpan = visibleSpan(cell.x, cell.width, layout.maxWidth);
  if (!cellSpan) return null;
  const gridSpan = visibleSpan(layout.gridX, layout.gridWidth, layout.maxWidth);
  if (!gridSpan) return null;

  return {
    key: TABLE_TOOLS_OVERLAY,
    blockId: c.block.id,
    rect: {
      x: c.origin.x + cellSpan.x,
      y: c.origin.y + cell.y,
      width: cellSpan.width,
      height: cell.height,
    },
    data: {
      shape,
      grid: {
        x: c.origin.x + gridSpan.x,
        y: c.origin.y + layout.gridTop,
        width: gridSpan.width,
        height: layout.gridHeight,
      },
    } satisfies TableToolsOverlayData,
  };
}

/** The part of `x..x + width` inside the `0..windowWidth` window, if any. */
function visibleSpan(
  x: number,
  width: number,
  windowWidth: number,
): { readonly x: number; readonly width: number } | null {
  const left = Math.max(0, x);
  const right = Math.min(windowWidth, x + width);
  return right > left ? { x: left, width: right - left } : null;
}
