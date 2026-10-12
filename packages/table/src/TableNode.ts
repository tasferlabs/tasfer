/**
 * TableNode — the on-canvas table: grid layout, painting, and the caret inside
 * a cell.
 *
 * A table block stores nothing flat. Its columns, rows and the rich text of
 * every cell live in one structured CRDT attachment (see `./structured`), so
 * this node never asks the block for characters — it lays out the attachment
 * (`./geometry`) and addresses the caret by cell identity (`./selection`).
 * That is also why it extends {@link Node} directly rather than TextNode: there
 * is no single text flow here to be a specialization of.
 *
 * Cells are ordinary prose, so their glyphs are drawn through the engine's own
 * marked-text line painter (`paintTextRun`). A table's bold, links and inline
 * code are therefore the same marks, resolved the same way, as everywhere else.
 */

import { registerTableActions } from "./actions";
import {
  registerTableCommands,
  setColumnWidths,
  setTableWidth,
  TABLE_INSERT_COLUMN,
  TABLE_INSERT_ROW,
  TABLE_MOVE_COLUMN,
  TABLE_SELECT_COLUMN,
} from "./commands";
import {
  activeTableContext,
  commitTableEdits,
  withTableDocument,
} from "./context";
import { tableBlockNodeCodec } from "./data";
import {
  type TableEdge,
  type TableEdgeStrip,
  tableEdgeStrips,
  withinEdgeBox,
} from "./edge-adders";
import {
  layoutTable,
  previewColumnMove,
  type TableCellLayout,
  type TableComposition,
  tableGridWidth,
  type TableLayout,
  type TableLayoutCtx,
} from "./geometry";
import { registerTableInputActions } from "./input";
import { tableToolsOverlay } from "./overlays";
import {
  revealTableSpan,
  scrollTableBy,
  tableOverflows,
  type TableScrollbar,
  tableScrollbar,
  tableScrollX,
  viewedTableLayout,
  withTableScrollX,
} from "./scroll";
import {
  cellCaretHeight,
  cellCaretX,
  cellFromPoint,
  cellLineAtOffset,
  cellOffsetFromPoint,
  cellRangeRects,
  coveredCellIds,
  type TableCaret,
  tableCaretFromContentPoint,
  tableCaretToContentSelection,
} from "./selection";
import {
  cellText,
  columnWidth,
  getTableDocument,
  MAX_TABLE_WIDTH,
  readTable,
  tableWidth,
} from "./structured";
import type { ActionBus } from "@tasfer/editor/action-bus";
import {
  SCROLLBAR_HOLD_DURATION,
  SCROLLBAR_TOUCH_BUFFER,
} from "@tasfer/editor/constants";
import { withStoppedMomentum } from "@tasfer/editor/events/interaction-session";
import type { RegionCtx } from "@tasfer/editor/events/regions";
import { currentFontFamily } from "@tasfer/editor/fonts";
import { memoizeNodeLayout } from "@tasfer/editor/node-shared";
import { paintTextRun } from "@tasfer/editor/nodes/TextNode";
import {
  boxDecorationRect,
  type DecorationRect,
  decorationsForBlock,
  paintDecorationRects,
  type RangeDecorationPaint,
  rangeDecorationToContentSelection,
  rangeDecorationToSelection,
} from "@tasfer/editor/rendering/decorations";
import {
  type BlockRuntimeState,
  hitRegion,
  Node,
  type NodeCaretRect,
  type NodeContentCaretCtx,
  type NodeContentHitCtx,
  type NodeContentHitOptions,
  type NodeContentSelectionGeometry,
  type NodeHitRegion,
  type NodeLayout,
  type NodeLayoutCtx,
  type NodePaintCtx,
  type NodeRegionCtx,
  type NodeScrollCtx,
  type Point,
} from "@tasfer/editor/rendering/nodes/Node";
import type {
  EditorState,
  EditorStyles,
  NodeOverlay,
  Operation,
  RenderedBlock,
  RenderedLine,
  TableBlockStyle,
  TextStyle,
} from "@tasfer/editor/state-types";
import type {
  ContentPoint,
  ContentSelection,
} from "@tasfer/editor/structured-selection";
import { recordUndoOps } from "@tasfer/editor/sync/crdt-undo";
import {
  applyStructuredEdits,
  type StructuredDocument,
  type StructuredEdit,
} from "@tasfer/editor/sync/structured-content";
import { compositionRects } from "@tasfer/editor/text-layout";

/** Stroke width of the composition underline, matching the paragraph's. */
const COMPOSITION_UNDERLINE_WIDTH = 1.5;

/** Gap between the text baseline and the composition underline. */
const COMPOSITION_UNDERLINE_GAP = 2;

/** The id the column-resize grab bands are registered (and hit) under. */
const COLUMN_RESIZE_REGION = "table-column-resize";

/** Separator between the block and the edge index in a hover target name. */
const COLUMN_EDGE_TARGET = ":column-edge:";

/** The id the column-move grab band above the grid is registered (and hit) under. */
const COLUMN_MOVE_REGION = "table-column-move";

/** Separator between the block and the column index in a hover target name. */
const COLUMN_MOVE_TARGET = ":column-move:";

/** The id the outer-edge "add a row/column" strips are registered (and hit) under. */
const EDGE_ADD_REGION = "table-edge-add";

/** Separator between the block and the edge name in a hover target name. */
const EDGE_ADD_TARGET = ":edge-add:";

/** A table block: a bare identity whose content is its structured attachment. */
export interface TableBlock extends BlockRuntimeState {
  readonly type: "table";
}

/**
 * What a nested range covers in a table's layout: a character span inside one
 * cell, or whole cells when it spans several. `null` for a collapsed range, a
 * range in another block, or one whose ends no longer resolve.
 */
function tableContentBand(
  layout: TableLayout,
  block: Parameters<typeof getTableDocument>[0],
  selection: ContentSelection,
):
  | {
      kind: "text";
      cell: TableCellLayout;
      from: number;
      to: number;
      isForward: boolean;
    }
  | { kind: "cells"; cells: TableCellLayout[]; isForward: boolean }
  | null {
  if (selection.focus.blockId !== block.id) return null;
  if (selection.anchor.kind !== "text" || selection.focus.kind !== "text") {
    return null;
  }
  const document = getTableDocument(block);
  if (!document) return null;
  const anchor = tableCaretFromContentPoint(document, selection.anchor);
  const focus = tableCaretFromContentPoint(document, selection.focus);
  if (!anchor || !focus) return null;
  if (anchor.cellId === focus.cellId && anchor.offset === focus.offset) {
    return null;
  }

  if (anchor.cellId === focus.cellId) {
    const cell = layout.cells.find(
      (candidate) => candidate.cellId === anchor.cellId,
    );
    if (!cell) return null;
    return {
      kind: "text",
      cell,
      from: Math.min(anchor.offset, focus.offset),
      to: Math.max(anchor.offset, focus.offset),
      isForward: anchor.offset <= focus.offset,
    };
  }

  // The rectangle the two ends span — the same cells copy, paste and delete
  // take (see `coveredCellIds`).
  const covered = new Set(coveredCellIds(document, anchor, focus));
  if (covered.size === 0) return null;
  const order = layout.cells.filter((cell) => cell.cellId !== null);
  const from = order.findIndex((cell) => cell.cellId === anchor.cellId);
  const to = order.findIndex((cell) => cell.cellId === focus.cellId);
  if (from < 0 || to < 0) return null;
  return {
    kind: "cells",
    cells: order.filter(
      (cell) => covered.has(cell.cellId!) && cell.width > 0 && cell.height > 0,
    ),
    isForward: from <= to,
  };
}

/** The resolved table style, with the paragraph metrics as a safety net. */
function tableStyle(styles: EditorStyles): TableBlockStyle {
  return styles.blocks.table;
}

export class TableNode extends Node<TableBlock> {
  readonly type = "table" as const;
  readonly types: readonly string[] = ["table"];

  // ── Layout ────────────────────────────────────────────────────────────────

  layout(c: NodeLayoutCtx): TableLayout {
    return memoizeNodeLayout(c.block, c.maxWidth, () =>
      layoutTable(getTableDocument(c.block), tableLayoutCtx(c)),
    );
  }

  /**
   * A table's height comes from wrapping every cell, which is the expensive
   * part — it needs canvas text metrics for every character in the grid. The
   * estimate instead counts characters against an average glyph width, the same
   * trade `TextNode.estimateHeight` makes, so a row with a paragraph in one cell
   * is reported multiple lines tall without measuring anything.
   *
   * Assuming one line per row instead is not a cheaper approximation but a wrong
   * one: the height index seeds every off-screen block with this number, so a
   * table of wrapped cells claimed less flow height than it draws and the
   * document below it shifted when the row was finally measured.
   */
  estimateHeight(c: NodeLayoutCtx): number {
    const document = getTableDocument(c.block);
    if (!document) return 0;
    const style = tableStyle(c.styles);
    const view = readTable(document);
    if (view.rows.length === 0) return 0;

    // Nominal column widths: a pinned column takes its stored fraction of the
    // grid, and the rest share what is left. The fitter reaches a different
    // answer from real text metrics — this only has to be close enough to get
    // the line COUNT right.
    const gridWidth = tableGridWidth(
      view.columns.length,
      c.maxWidth,
      style,
      tableWidth(view.root),
    );
    const pinned = view.columns.map((column) => columnWidth(column));
    const pinnedWidth = pinned.reduce<number>(
      (total, fraction) => total + (fraction ?? 0) * gridWidth,
      0,
    );
    const autoCount = pinned.filter((fraction) => fraction === null).length;
    const autoWidth =
      autoCount > 0 ? Math.max(0, gridWidth - pinnedWidth) / autoCount : 0;

    // Average glyph width as a fraction of the font size, matching TextNode's
    // own estimate so a table and a paragraph guess alike.
    const averageGlyph = style.fontSize * 0.55;
    const lineHeight = style.fontSize * style.lineHeight;

    let height = 0;
    for (let row = 0; row < view.rows.length; row++) {
      let lines = 1;
      for (let column = 0; column < view.columns.length; column++) {
        const cell = view.rows[row].cells[column];
        if (!cell) continue;
        const width =
          pinned[column] !== null ? pinned[column]! * gridWidth : autoWidth;
        const perLine = Math.max(
          1,
          Math.floor((width - style.cellPaddingX * 2) / averageGlyph),
        );
        const length = cellText(document, cell).length;
        lines = Math.max(lines, Math.ceil(length / perLine));
      }
      height += Math.round(lines * lineHeight + style.cellPaddingY * 2);
    }
    return height + style.marginTop + style.marginBottom;
  }

  /** Line the drag grip up with the first row, not the outer flow margin. */
  gutterAnchorY(c: NodeLayoutCtx): number {
    const layout = this.layout(c);
    const first = layout.rows[0];
    return first ? first.y + first.height / 2 : layout.height / 2;
  }

  /** Every cell is ordinary prose — no row is styled apart from the rest. */
  textStyle(styles: EditorStyles): TextStyle {
    return styles.blocks.table;
  }

  // ── Paint ─────────────────────────────────────────────────────────────────

  paint(passedLayout: NodeLayout, c: NodePaintCtx): RenderedBlock {
    // While a column-move drag is held, everything is drawn from the previewed
    // order — the grid shows where the column would land, and the document is
    // untouched until the release says so. Text being composed through an IME
    // is drawn in its cell the same way, before it commits. A table wider than
    // the page is drawn scrolled to wherever this device has it.
    const layout = shownLayout(passedLayout, c);
    const { ctx } = c;
    const style = layout.style;
    const x = c.origin.x;
    const y = c.origin.y;

    if (layout.rows.length === 0) {
      return {
        block: c.block,
        bounds: this.bounds(c, layout.height),
        lines: [],
      };
    }

    const gridTop = y + layout.gridTop;
    const gridHeight = layout.gridHeight;
    const overflows = tableOverflows(layout);

    // A table wider than the page is seen through a page-wide window: every
    // part of the grid is cut at its sides, and the columns past them are
    // reached by scrolling.
    ctx.save();
    if (overflows) {
      ctx.beginPath();
      ctx.rect(x, y, layout.maxWidth, layout.height);
      ctx.clip();
    }

    // The cell washes are clipped to the grid's rounded outline so none of them
    // can bleed past its corners.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(
      x + layout.gridX,
      gridTop,
      layout.gridWidth,
      gridHeight,
      style.borderRadius,
    );
    ctx.clip();

    this.paintActiveCell(layout, c, x, y);
    this.paintDecorations(layout, c, x, y);
    this.paintSelection(layout, c, x, y);
    this.paintBlockSelection(layout, c, x, y);
    ctx.restore();

    this.paintCells(layout, c, x, y);
    this.paintGrid(
      layout,
      ctx,
      x,
      y,
      resizingColumnEdge(c.state, c.block.id) ??
        hoveredColumnEdge(c.state, c.block.id),
    );
    this.paintColumnMove(layout, c, x, y);
    ctx.restore();

    if (overflows) {
      this.paintEdgeFades(layout, c, x, y);
      this.paintScrollbar(layout, c);
    }
    this.paintEdgeAdder(layout, c, x, y);

    return {
      block: c.block,
      bounds: this.bounds(c, layout.height),
      lines: layout.lines.map((line): RenderedLine => ({
        ...line,
        x: x + line.x,
        y: y + line.y,
      })),
    };
  }

  /**
   * The wash marking the table as selected WHOLE — held as one object rather
   * than edited in a cell.
   *
   * This is the same affordance `AtomicNode` gives every void block; a table
   * extends {@link Node} directly, so it has to draw its own. The test is the
   * flat block range, not `isNodeSelection`, because a node selection is only
   * its degenerate one-block case — writing it this way also lights the table up
   * when a select-all sweeps across it, which used to leave it the one blank
   * block in an otherwise highlighted document.
   *
   * The caller has already clipped to the grid's rounded outline, so a plain
   * `fillRect` picks up the corners and cannot bleed into the outer margins.
   */
  private paintBlockSelection(
    layout: TableLayout,
    c: NodePaintCtx,
    x: number,
    y: number,
  ): void {
    const selection = c.state.document.selection;
    if (!selection || selection.isCollapsed) return;
    const start = Math.min(
      selection.anchor.blockIndex,
      selection.focus.blockIndex,
    );
    const end = Math.max(
      selection.anchor.blockIndex,
      selection.focus.blockIndex,
    );
    if (c.blockIndex < start || c.blockIndex > end) return;

    this.fillGrid(
      layout,
      c,
      x,
      y,
      c.styles.selection.backgroundColor,
      layout.style.selectionOpacity,
    );
  }

  /** The whole-grid wash — a table held as one object, by anyone. */
  private fillGrid(
    layout: TableLayout,
    c: NodePaintCtx,
    x: number,
    y: number,
    color: string,
    opacity: number,
  ): void {
    const { ctx } = c;
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = opacity;
    ctx.fillRect(
      x + layout.gridX,
      y + layout.gridTop,
      layout.gridWidth,
      layout.gridHeight,
    );
    ctx.restore();
  }

  /**
   * Remote peers' cursors and selections — the engine's generic decoration
   * overlay, which a table has to paint for itself the way every other node
   * does (see `TextNode.paint` / `AtomicNode.paintRangeDecorations`).
   *
   * A peer working in a cell publishes a structured range, so it paints through
   * the same band the local selection uses — characters inside one cell,
   * cell-wise across several — in that peer's own color. A peer whose selection
   * merely sweeps ACROSS the table publishes a flat block range, and a peer
   * holding it as one object publishes a block decoration; both wash the whole
   * grid, matching what the local selection does in each case.
   *
   * The peer's CARET is not drawn here: core draws every caret decoration
   * centrally, asking this node for the rect through `contentCaretRect`.
   */
  private paintDecorations(
    layout: TableLayout,
    c: NodePaintCtx,
    x: number,
    y: number,
  ): void {
    const { state, styles } = c;
    for (const deco of decorationsForBlock(state.ui.decorations, c.block.id)) {
      if (deco.kind === "caret") continue;

      if (deco.kind === "block") {
        if (deco.block !== c.block.id) continue;
        this.fillGrid(
          layout,
          c,
          x,
          y,
          deco.color,
          deco.opacity ?? styles.selection.remoteOpacity,
        );
        continue;
      }

      const content = rangeDecorationToContentSelection(deco.range);
      if (content) {
        this.paintContentBand(layout, c, x, y, content, deco);
        continue;
      }

      const flat = rangeDecorationToSelection(deco.range, state.document.page);
      if (!flat || flat.isCollapsed) continue;
      const start = Math.min(flat.anchor.blockIndex, flat.focus.blockIndex);
      const end = Math.max(flat.anchor.blockIndex, flat.focus.blockIndex);
      if (c.blockIndex < start || c.blockIndex > end) continue;
      this.paintGridDecoration(layout, c, x, y, deco);
    }
  }

  /**
   * A range decoration over the whole grid: a fill is the plain wash
   * `fillGrid` draws; an underline runs along the grid's bottom edge — a
   * table swept across has no single baseline to hang from.
   */
  private paintGridDecoration(
    layout: TableLayout,
    c: NodePaintCtx,
    x: number,
    y: number,
    deco: RangeDecorationPaint,
  ): void {
    if (!deco.style || deco.style.type === "fill") {
      this.fillGrid(
        layout,
        c,
        x,
        y,
        deco.color,
        deco.opacity ?? c.styles.selection.remoteOpacity,
      );
      return;
    }
    const box = {
      x: x + layout.gridX,
      y: y + layout.gridTop,
      width: layout.gridWidth,
      height: layout.gridHeight,
    };
    paintDecorationRects(c.ctx, [boxDecorationRect(box, deco)], deco, c.styles);
  }

  /** A soft wash behind the cell the caret is in, so the active cell reads. */
  private paintActiveCell(
    layout: TableLayout,
    c: NodePaintCtx,
    x: number,
    y: number,
  ): void {
    const selection = c.state.document.contentSelection;
    if (!selection || selection.focus.blockId !== c.block.id) return;
    const { anchor, focus } = selection;
    if (anchor.kind !== "text" || focus.kind !== "text") return;
    if (anchor.nodeId !== focus.nodeId) return;
    const cell = layout.cells.find(
      (candidate) => candidate.cellId === focus.nodeId,
    );
    if (!cell || cell.rowIndex === 0) return;
    c.ctx.fillStyle = layout.style.activeCellBackgroundColor;
    c.ctx.fillRect(x + cell.x, y + cell.y, cell.width, cell.height);
  }

  /**
   * The selection band.
   *
   * A range inside ONE cell highlights just the characters it covers, exactly
   * as prose does. A range spanning cells highlights each covered cell whole:
   * a partial band across a grid reads as a rendering error, and cell-wise is
   * also the unit the clipboard and the structural commands work in.
   */
  private paintSelection(
    layout: TableLayout,
    c: NodePaintCtx,
    x: number,
    y: number,
  ): void {
    const selection = c.state.document.contentSelection;
    if (!selection) return;
    // A composition's preview already stands in for the range it will replace,
    // as it does in a paragraph, where the selection is removed as it starts.
    if (tableComposition(c.state, c.block.id)) return;
    this.paintContentBand(layout, c, x, y, selection, {
      color: c.styles.selection.backgroundColor,
      opacity: c.styles.selection.opacity,
    });
  }

  /**
   * The band for one range inside this table, in a given paint — the local
   * selection and a remote peer's are the same picture drawn in different
   * paint, so they share the geometry rather than each deriving it. The paint
   * is a range decoration's channels: a fill, or an underline (which hangs
   * from each covered line's baseline inside one cell, and along a covered
   * cell's bottom edge cell-wise).
   */
  private paintContentBand(
    layout: TableLayout,
    c: NodePaintCtx,
    x: number,
    y: number,
    selection: ContentSelection,
    deco: RangeDecorationPaint,
  ): void {
    const band = tableContentBand(layout, c.block, selection);
    if (!band) return;

    // Same fill, opacity and corner rounding prose uses, so a selection that
    // starts in a paragraph and a selection inside a cell look like one thing.
    const rects: DecorationRect[] =
      band.kind === "text"
        ? cellRangeRects(band.cell, band.from, band.to).map((rect) => ({
            ...rect,
            x: x + rect.x,
            y: y + rect.y,
            baseline: y + rect.baseline,
          }))
        : band.cells.map((cell) =>
            boxDecorationRect(
              {
                x: x + cell.x,
                y: y + cell.y,
                width: cell.width,
                height: cell.height,
              },
              deco,
            ),
          );
    paintDecorationRects(c.ctx, rects, deco, c.styles);
  }

  /** Every cell's text, through the engine's own marked-line renderer. */
  private paintCells(
    layout: TableLayout,
    c: NodePaintCtx,
    x: number,
    y: number,
  ): void {
    const style = layout.style;
    for (const cell of layout.cells) {
      if (cell.chars.length === 0) continue;
      const isRTL = cell.direction === "rtl";
      // A line can still be wider than its cell when a column is narrower than
      // wrapping can help — a single glyph is unbreakable, and a dragged column
      // keeps the width it was given. Clip those cells to their own box so the
      // overflow stops at the hairline instead of painting across the
      // neighbour. Clipped to the full cell, not the text area, so an italic or
      // descender overhang inside the padding still shows; and skipped entirely
      // for the ordinary table that fits, which pays no per-cell clip.
      const overflows = cell.lines.some((line) => line.width > cell.textWidth);
      if (overflows) {
        c.ctx.save();
        c.ctx.beginPath();
        c.ctx.rect(x + cell.x, y + cell.y, cell.width, cell.height);
        c.ctx.clip();
      }
      this.paintCompositionUnderline(cell, c, x, y);
      for (const line of cell.lines) {
        if (line.text.length === 0) continue;
        paintTextRun({
          ctx: c.ctx,
          chars: cell.chars,
          formats: cell.marks,
          startIndex: line.startIndex,
          endIndex: line.endIndex,
          // The painter draws from the run's start edge, which is the right
          // edge of the line box in right-to-left text.
          x: x + (isRTL ? line.x + line.width : line.x),
          baselineY: y + line.y + (line.baselineOffset ?? 0),
          textStyle: style,
          fontFamily: layout.fontFamily,
          styles: c.styles,
          marks: c.marks,
          isRTL,
          requestRedraw: c.requestRedraw,
        });
      }
      if (overflows) c.ctx.restore();
    }
  }

  /**
   * The underline marking text still being composed, the way the OS and a
   * paragraph mark it. Drawn from the engine's range rects, so it follows the
   * preview across a wrap and through mixed-direction text.
   */
  private paintCompositionUnderline(
    cell: TableCellLayout,
    c: NodePaintCtx,
    x: number,
    y: number,
  ): void {
    const rects = compositionRects(cell.text);
    if (rects.length === 0) return;
    const { ctx } = c;
    ctx.save();
    ctx.strokeStyle = tableStyle(c.styles).color;
    ctx.lineWidth = COMPOSITION_UNDERLINE_WIDTH;
    ctx.beginPath();
    for (const rect of rects) {
      const underlineY =
        y + cell.textY + (rect.baseline ?? rect.y) + COMPOSITION_UNDERLINE_GAP;
      ctx.moveTo(x + cell.textX + rect.x, underlineY);
      ctx.lineTo(x + cell.textX + rect.x + rect.width, underlineY);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** The hairlines: every interior edge, then the rounded outer border. */
  private paintGrid(
    layout: TableLayout,
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    hoveredEdge: number | null,
  ): void {
    const style = layout.style;
    const gridTop = y + layout.gridTop;
    ctx.save();
    ctx.strokeStyle = style.borderColor;
    ctx.lineWidth = style.borderWidth;
    // Hairlines land on a half-pixel so a 1px stroke covers one device pixel
    // instead of smearing across two.
    const align = (value: number): number =>
      Math.round(value) + (style.borderWidth % 2) / 2;

    ctx.beginPath();
    for (let at = 1; at < layout.columns.length; at++) {
      const edge = align(x + layout.columns[at].x);
      ctx.moveTo(edge, gridTop);
      ctx.lineTo(edge, gridTop + layout.gridHeight);
    }
    const gridLeft = x + layout.gridX;
    for (let at = 1; at < layout.rows.length; at++) {
      const edge = align(y + layout.rows[at].y);
      ctx.moveTo(gridLeft, edge);
      ctx.lineTo(gridLeft + layout.gridWidth, edge);
    }
    ctx.stroke();

    ctx.beginPath();
    ctx.roundRect(
      align(gridLeft),
      align(gridTop),
      layout.gridWidth - style.borderWidth,
      layout.gridHeight - style.borderWidth,
      style.borderRadius,
    );
    ctx.stroke();

    // The edge the pointer is resting on (or dragging), drawn last so it covers
    // the hairline it replaces. Painted from the same hover the cursor is
    // derived from, so the lit edge is always the one a press would take — and,
    // while a drag holds one, from the drag itself, which is the only source a
    // finger has: touch never records a hover.
    const column =
      hoveredEdge === null ? undefined : layout.columns[hoveredEdge];
    if (column) {
      ctx.strokeStyle = style.resizeEdgeColor;
      ctx.lineWidth = style.resizeEdgeWidth;
      const edge = Math.round(x + column.x) + (style.resizeEdgeWidth % 2) / 2;
      ctx.beginPath();
      ctx.moveTo(edge, gridTop);
      ctx.lineTo(edge, gridTop + layout.gridHeight);
      ctx.stroke();
    } else if (hoveredEdge === layout.columns.length && hoveredEdge > 0) {
      // The right edge is lit just inside the border it covers — it sits on the
      // page's edge, where the clip would halve a line centred on it — and
      // clear of the rounded corners.
      ctx.strokeStyle = style.resizeEdgeColor;
      ctx.lineWidth = style.resizeEdgeWidth;
      const edge =
        Math.round(gridLeft + layout.gridWidth) - style.resizeEdgeWidth / 2;
      ctx.beginPath();
      ctx.moveTo(edge, gridTop + style.borderRadius);
      ctx.lineTo(edge, gridTop + layout.gridHeight - style.borderRadius);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The "add one here" band on the edge the pointer is resting on.
   *
   * Nothing is drawn until then: the strips sit in the gutter and the block's
   * bottom margin, and a table that painted them permanently would look fenced
   * in. Read back from the same `ui.regionHover` the resize edge uses, so the
   * band that lights up is by construction the one a click would take.
   *
   * A tinted wash with the accent plus over it, rather than a solid accent
   * button: the strip runs the full length of the grid, and a bar of solid
   * accent down the side of every hovered table reads as a selection, not as an
   * affordance.
   */
  private paintEdgeAdder(
    layout: TableLayout,
    c: NodePaintCtx,
    x: number,
    y: number,
  ): void {
    const edge = hoveredEdgeAdd(c.state, c.block.id);
    if (edge === null) return;
    const strip = tableEdgeStrips(
      layout,
      { x, y },
      c.styles.canvas.paddingRight,
    ).find((candidate) => candidate.edge === edge);
    if (!strip) return;

    const { ctx } = c;
    const style = layout.style;
    const short = Math.min(strip.width, strip.height);
    ctx.save();
    ctx.fillStyle = style.resizeEdgeColor;
    ctx.globalAlpha = EDGE_ADD_WASH_OPACITY;
    ctx.beginPath();
    ctx.roundRect(strip.x, strip.y, strip.width, strip.height, short / 2);
    ctx.fill();

    // The plus sits at the band's midpoint rather than under the pointer: the
    // strip is one control along its whole length, and a glyph that slid with
    // the mouse would suggest the click lands where it is drawn.
    ctx.globalAlpha = 1;
    ctx.strokeStyle = style.resizeEdgeColor;
    ctx.lineWidth = style.resizeEdgeWidth;
    ctx.lineCap = "round";
    const cx = strip.x + strip.width / 2;
    const cy = strip.y + strip.height / 2;
    const arm = Math.max(2, (short - EDGE_ADD_GLYPH_INSET) / 2);
    ctx.beginPath();
    ctx.moveTo(cx - arm, cy);
    ctx.lineTo(cx + arm, cy);
    ctx.moveTo(cx, cy - arm);
    ctx.lineTo(cx, cy + arm);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The column under the move grip, or the one a drag is carrying.
   *
   * Nothing is drawn until the pointer rests on the band (or holds a column):
   * the grips would otherwise put a row of bars over every table. Lit, the
   * column gets a short pill in the top margin — the grip itself, where the
   * pointer is — and a wash down its full height, so what is about to move is the whole
   * column and not the title. While a drag holds it the grid is already drawn
   * in the previewed order (`previewedLayout`), so the wash follows the column
   * to where it would land: the preview IS the feedback, and needs no marker.
   */
  private paintColumnMove(
    layout: TableLayout,
    c: NodePaintCtx,
    x: number,
    y: number,
  ): void {
    const drag = columnDragOf(c.state, c.block.id);
    const lit = drag
      ? columnIndexForGap(drag)
      : hoveredMoveColumn(c.state, c.block.id);
    const column = lit === null ? undefined : layout.columns[lit];
    if (!column) return;

    const { ctx } = c;
    const style = layout.style;
    const gridTop = y + layout.gridTop;
    ctx.save();
    ctx.fillStyle = style.resizeEdgeColor;

    // The wash, clipped to the grid's outline the way the cell washes are so
    // the first and last columns cannot bleed past the rounded corners.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(
      x + layout.gridX,
      gridTop,
      layout.gridWidth,
      layout.gridHeight,
      style.borderRadius,
    );
    ctx.clip();
    ctx.globalAlpha = drag ? COLUMN_LIFT_OPACITY : COLUMN_HOVER_OPACITY;
    ctx.fillRect(x + column.x, gridTop, column.width, layout.gridHeight);
    ctx.restore();

    // The grip: a short pill centred above the column, in the margin. Short,
    // not the column's width — a full-width bar reads as a tab, and fights the
    // grid's rounded corner under the outer columns; a handle is a small thing
    // you pick up.
    const pillHeight = Math.min(
      COLUMN_GRIP_HEIGHT,
      Math.max(0, layout.gridTop - COLUMN_GRIP_GAP * 2),
    );
    if (pillHeight > 0) {
      const pillWidth = Math.min(COLUMN_GRIP_WIDTH, column.width / 2);
      ctx.beginPath();
      ctx.roundRect(
        x + column.x + (column.width - pillWidth) / 2,
        y + (layout.gridTop - pillHeight) / 2,
        pillWidth,
        pillHeight,
        pillHeight / 2,
      );
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Soft edges where a wide table's grid runs on past the window: the cells
   * fade out toward the side that has more, so a cut-off table reads as one
   * that continues rather than one drawn wrong.
   *
   * The canvas is transparent (the page color is the element's own background),
   * so the fade is made by erasing the table's pixels with a gradient rather than
   * by painting a page-colored one over them — it works on any theme.
   */
  private paintEdgeFades(
    layout: TableLayout,
    c: NodePaintCtx,
    x: number,
    y: number,
  ): void {
    const { ctx } = c;
    const width = Math.min(EDGE_FADE_WIDTH, layout.maxWidth / 8);
    if (width <= 0) return;
    const top = y + layout.gridTop - layout.style.borderWidth;
    const height = layout.gridHeight + layout.style.borderWidth * 2;
    const left = x;
    const right = x + layout.maxWidth;
    const hiddenLeft = layout.gridX < 0;
    const hiddenRight = x + layout.gridX + layout.gridWidth > right + 1;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    if (hiddenLeft) {
      const fade = ctx.createLinearGradient(left, 0, left + width, 0);
      fade.addColorStop(0, "rgba(0, 0, 0, 1)");
      fade.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = fade;
      ctx.fillRect(left, top, width, height);
    }
    if (hiddenRight) {
      const fade = ctx.createLinearGradient(right - width, 0, right, 0);
      fade.addColorStop(0, "rgba(0, 0, 0, 0)");
      fade.addColorStop(1, "rgba(0, 0, 0, 1)");
      ctx.fillStyle = fade;
      ctx.fillRect(right - width, top, width, height);
    }
    ctx.restore();
  }

  /**
   * The thumb under a wide table: how much of the grid is in view, and where.
   * Always shown while the table is wider than the page — it is the one sign,
   * besides the faded edge, that there are columns past it — and lit while the
   * pointer rests on it or drags it, the way the page's scrollbar is. A finger
   * holding it also thickens it (upward, so it does not slip under the finger),
   * as the page's does. Stood down while the bottom "add a row"
   * strip, which shares the margin, is lit. Sticks to the screen's bottom edge
   * while the grid runs past it (see `tableScrollbar`).
   */
  private paintScrollbar(layout: TableLayout, c: NodePaintCtx): void {
    if (hoveredEdgeAdd(c.state, c.block.id) === "bottom") return;
    const thumb = tableScrollbar(layout, c.origin, c.viewport?.height);
    if (!thumb) return;
    const colors = c.styles.scrollbar;
    const drag = scrollbarDragOf(c.state, c.block.id);
    const height =
      drag === "touch" ? thumb.height * TOUCH_DRAG_THUMB_SCALE : thumb.height;
    const { ctx } = c;
    ctx.save();
    ctx.fillStyle = drag
      ? colors.thumbActiveColor
      : hoversScrollbar(c.state, c.block.id)
        ? colors.thumbHoverColor
        : colors.thumbColor;
    ctx.beginPath();
    ctx.roundRect(
      thumb.x,
      thumb.y + thumb.height - height,
      thumb.width,
      height,
      height / 2,
    );
    ctx.fill();
    ctx.restore();
  }

  // ── Sideways scroll ───────────────────────────────────────────────────────

  canScrollSideways(c: NodeScrollCtx): boolean {
    return tableOverflows(this.layout(c));
  }

  scrollSideways(c: NodeScrollCtx, deltaX: number): EditorState | null {
    return scrollTableBy(c.state, c.block.id, this.layout(c), deltaX);
  }

  /**
   * Keep the local caret on screen in a wide table. Nothing moves while the
   * caret itself can be seen — a click on a half-hidden cell does not jerk the
   * table under the pointer. Once it cannot (a Tab or an arrow into a hidden
   * column, typing past the window's edge), the table scrolls to show the
   * caret's whole cell, or just the caret when the cell is wider than the page.
   */
  revealSideways(c: NodeScrollCtx, point: ContentPoint): EditorState | null {
    const layout = this.layout(c);
    if (!tableOverflows(layout)) return null;
    const document = getTableDocument(c.block);
    const caret = document && tableCaretFromContentPoint(document, point);
    if (!caret) return null;
    const cell = layout.cells.find(
      (candidate) => candidate.cellId === caret.cellId,
    );
    if (!cell) return null;
    const caretX = cellCaretX(cell, caret.offset);
    const scrollX = Math.round(tableScrollX(c.state, c.block.id, layout));
    if (caretX >= scrollX && caretX <= scrollX + layout.maxWidth) return null;
    return cell.width <= layout.maxWidth
      ? revealTableSpan(
          c.state,
          c.block.id,
          layout,
          cell.x,
          cell.x + cell.width,
        )
      : revealTableSpan(
          c.state,
          c.block.id,
          layout,
          caretX - layout.style.cellPaddingX,
          caretX + layout.style.cellPaddingX,
        );
  }

  // ── Caret and hit-testing ─────────────────────────────────────────────────

  /**
   * A pointer inside the table always resolves to a cell caret — the table has
   * no flat text for the ordinary path to land in, and clamping to the nearest
   * cell is what lets a drag that strays outside the grid keep selecting.
   *
   * In a wide table the point is also held inside the page-wide window first,
   * so a drag out past its side selects up to the column at the edge rather
   * than reaching a column scrolled out of sight.
   */
  contentSelectionFromPoint(
    passedLayout: NodeLayout,
    local: Point,
    c: NodeContentHitCtx<TableBlock>,
    _options: NodeContentHitOptions,
  ) {
    const layout = viewedTableLayout(
      passedLayout as TableLayout,
      c.state,
      c.block.id,
    );
    const document = getTableDocument(c.block);
    if (!document) return null;
    const point = tableOverflows(layout)
      ? { x: Math.max(0, Math.min(layout.maxWidth, local.x)), y: local.y }
      : local;
    const cell = cellFromPoint(layout, point);
    if (!cell?.cellId) return null;
    return (
      tableCaretToContentSelection(document, c.block.id, {
        cellId: cell.cellId,
        offset: cellOffsetFromPoint(cell, point),
      }) ?? null
    );
  }

  /** Place the caret for a cell address — the inverse of the hit-test above. */
  contentCaretRect(
    passedLayout: NodeLayout,
    point: ContentPoint,
    c: NodeContentCaretCtx<TableBlock>,
  ): NodeCaretRect | null {
    // The caret rides its cell, so during a column-move drag it is placed in
    // the previewed order the grid is painted in — and during a composition,
    // in the cell as it is drawn with the preview folded in.
    const layout = shownLayout(passedLayout, c);
    const document = getTableDocument(c.block);
    if (!document) return null;
    const stored = tableCaretFromContentPoint(document, point);
    if (!stored) return null;
    const caret = composedCaret(c, point, stored);
    const cell = layout.cells.find(
      (candidate) => candidate.cellId === caret.cellId,
    );
    if (!cell) return null;
    const lineIndex = cellLineAtOffset(cell, caret.offset);
    const line = cell.lines[lineIndex];
    if (!line) return null;
    // A caret in a column scrolled out of sight is pinned to the window's edge
    // and flagged, never drawn in the page margin beside the table. Core then
    // skips the local caret (scrolled back into view as soon as it moves, see
    // `revealSideways`) and marks a peer's with an edge indicator on its row.
    const caretX = cellCaretX(cell, caret.offset);
    const offscreen =
      caretX < -1 ? "left" : caretX > layout.maxWidth + 1 ? "right" : null;
    return {
      x: c.origin.x + Math.max(0, Math.min(layout.maxWidth, caretX)),
      y: c.origin.y + line.y,
      // Text height, not the line box — core draws this rect verbatim, so the
      // node owns how tall its caret looks. See `cellCaretHeight`.
      height: cellCaretHeight(layout),
      ...(offscreen ? { offscreen } : {}),
    };
  }

  /**
   * The band a range paints and the edges its touch handles hang from — the
   * same band {@link paintContentBand} fills, so a handle sits on its corner.
   */
  contentSelectionGeometry(
    passedLayout: NodeLayout,
    selection: ContentSelection,
    c: NodeContentCaretCtx<TableBlock>,
  ): NodeContentSelectionGeometry | null {
    const layout = viewedTableLayout(
      previewedLayout(passedLayout as TableLayout, c),
      c.state,
      c.block.id,
    );
    const band = tableContentBand(layout, c.block, selection);
    if (!band) return null;
    const { x, y } = c.origin;
    const boxes =
      band.kind === "text"
        ? cellRangeRects(band.cell, band.from, band.to)
        : band.cells;
    // Only the part in view: in a wide table, a range can run on into columns
    // scrolled out of sight, and its handles belong on what can be seen.
    const rects = boxes.flatMap((box) => {
      const left = Math.max(box.x, 0);
      const right = Math.min(box.x + box.width, layout.maxWidth);
      if (right <= left) return [];
      return [
        { x: x + left, y: y + box.y, width: right - left, height: box.height },
      ];
    });
    if (rects.length === 0) return null;
    // Reading order: top row first, then left to right — the edges prose
    // handles hang from (see `selectionHighlightEdge`).
    const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    return {
      rects,
      start: { x: first.x, y: first.y, height: first.height },
      end: { x: last.x + last.width, y: last.y, height: last.height },
      isForward: band.isForward,
    };
  }

  // ── Editing affordances ───────────────────────────────────────────────────

  /**
   * The column-resize handles: one grab band on every interior column edge,
   * and one on the grid's right edge.
   *
   * An interior edge trades width between the two columns it separates, which
   * keeps the grid's total width fixed by construction. The right edge is the
   * one that changes it: dragging it out widens the last column and the table
   * with it, past the page if need be — the table then scrolls sideways — and
   * dragging it back in narrows them down to the table's automatic width, never
   * under it. The other columns keep their widths either way. In a wide table
   * only the edges in view can be grabbed, and the right one is in view only
   * once the table is scrolled to its end, where it sits on the page's edge:
   * from there the drag pulls the grid through the window instead of moving
   * the edge, and a pointer held at the screen's edge keeps it growing.
   *
   * On touch the drag arms behind a short hold rather than on contact. A column
   * edge sits in the middle of the reading area, where scrolls and long-press
   * selections begin; capturing the pointer on contact would snag both. While
   * the hold is pending the page still scrolls, and any real scroll cancels it
   * by moving — so only a finger that lands on the hairline and stays there
   * resizes. The edge lights up the moment the hold takes, which alongside the
   * haptic is how a finger learns the grab is live: the mouse reads that from
   * its hover, and touch has none.
   */
  regions(c: NodeRegionCtx): readonly NodeHitRegion[] {
    const layout = viewedTableLayout(this.layout(c), c.state, c.block.id);
    if (layout.columns.length === 0 || layout.rows.length === 0) return [];
    const gridTop = c.origin.y + layout.gridTop;
    const gridBottom = gridTop + layout.gridHeight;
    const blockId = c.block.id;
    const minimum = layout.style.minColumnWidth;
    const windowLeft = c.origin.x;
    const windowRight = c.origin.x + layout.maxWidth;

    const regions: NodeHitRegion[] = [this.edgeAddRegion(layout, c)];
    const scrollbar = this.scrollbarRegion(layout, c);
    if (scrollbar) regions.push(scrollbar);
    // Only interior edges resize, and a single column has nowhere to be moved
    // to, so a one-column grid has neither band.
    if (layout.columns.length < 2) return regions;

    regions.push(this.columnMoveRegion(layout, c));
    regions.push(
      hitRegion({
        id: COLUMN_RESIZE_REGION,
        priority: 60,
        modes: ["edit", "select"],
        hitTest: (p, pointerType): ColumnResizeHit | null => {
          // `isReadonlyBase` rather than the mode: a readonly editor still uses
          // `select` mode for drag-selection, and the grid is not resizable there.
          if (c.state.ui.isReadonlyBase) return null;
          if (p.y < gridTop || p.y > gridBottom) return null;
          const slop = pointerType === "touch" ? 10 : 4;
          for (let at = 1; at < layout.columns.length; at++) {
            const edge = c.origin.x + layout.columns[at].x;
            if (edge < windowLeft || edge > windowRight) continue;
            if (Math.abs(p.x - edge) <= slop) {
              return { blockId, index: at };
            }
          }
          // The right edge, once it is in view — a pixel of slack for the
          // rounded scroll offset, as the add strip allows.
          const outer = c.origin.x + layout.gridX + layout.gridWidth;
          if (outer <= windowRight + 1 && Math.abs(p.x - outer) <= slop) {
            return { blockId, index: layout.columns.length };
          }
          return null;
        },
        // What the pointer resting on an edge advertises: the sideways-resize
        // cursor, and which edge it is. `paint` rebuilds the same name to light
        // that edge up, so the highlight and the grab band cannot drift apart.
        hover: (hit) => ({
          cursor: "ew-resize",
          target: columnEdgeTarget(hit.blockId, hit.index),
        }),
        drag: {
          touchHoldMs: SCROLLBAR_HOLD_DURATION,
          activationIntensity: "medium",
          onStart: (hit, p, ctx) => {
            const document = tableDocumentById(ctx.state, blockId);
            if (!document) return null;
            const view = readTable(document);
            const columns = view.columns;
            if (hit.index === layout.columns.length) {
              hit.outer = {
                pointerX: p.x,
                maxWidth: layout.maxWidth,
                gridWidth: layout.gridWidth,
                automatic: tableGridWidth(
                  layout.columns.length,
                  layout.maxWidth,
                  layout.style,
                ),
                widths: layout.columns.map((column) => column.width),
                fractions: columns.map(columnWidth),
                tableWidth: tableWidth(view.root),
                scrollX: -layout.gridX,
                grown: 0,
                current: layout.gridWidth,
              };
              return {
                state: setResizingEdge(
                  withStoppedMomentum(ctx.state),
                  blockId,
                  hit.index,
                ),
              };
            }
            const left = layout.columns[hit.index - 1];
            const right = layout.columns[hit.index];
            if (!left || !right) return null;
            // The pre-drag fractions are kept so a cancelled drag restores
            // "automatic" as automatic, rather than freezing whatever width the
            // column happened to be fitted to.
            hit.start = {
              pointerX: p.x,
              gridWidth: layout.gridWidth,
              leftWidth: left.width,
              rightWidth: right.width,
              leftFraction: columnWidth(columns[hit.index - 1]),
              rightFraction: columnWidth(columns[hit.index]),
            };
            // A drag that begins mid-flick must not fight the page's momentum.
            // The held edge is recorded on the block so `paint` can light it:
            // on touch this is the only record of it there is.
            return {
              state: setResizingEdge(
                withStoppedMomentum(ctx.state),
                blockId,
                hit.index,
              ),
            };
          },
          onMove: (p, ctx) => {
            const hit = capturedResize(ctx);
            if (hit?.outer) {
              const gridWidth = draggedGridWidth(hit.outer, p.x, minimum);
              return { state: tableWidthState(ctx.state, hit, gridWidth) };
            }
            const next = hit && resizedFractions(hit, p.x, minimum);
            return {
              state: next
                ? widthState(ctx.state, hit, next.left, next.right)
                : ctx.state,
            };
          },
          onEnd: (p, ctx) => {
            const hit = capturedResize(ctx);
            const released = setResizingEdge(ctx.state, blockId, null);
            if (hit?.outer) {
              const gridWidth =
                p === null
                  ? hit.outer.current
                  : draggedGridWidth(hit.outer, p.x, minimum);
              return commitTableWidth(released, hit, gridWidth);
            }
            if (!hit?.start) return { state: released };
            // The live drag repainted without writing operations; the release
            // states the final widths once, which is all any peer ever sees.
            return commitColumnWidths(released, hit, p?.x ?? null, minimum);
          },
          onCancel: (ctx) => {
            const hit = capturedResize(ctx);
            const released = setResizingEdge(ctx.state, blockId, null);
            if (hit?.outer) return restoreTableWidth(released, hit, hit.outer);
            const start = hit?.start;
            if (!hit || !start) return released;
            return widthState(
              released,
              hit,
              start.leftFraction,
              start.rightFraction,
            );
          },
          // The right edge held at the screen's edge keeps widening the table:
          // the pointer has nowhere further to go, on a phone least of all.
          onFrame: (p, ctx) => {
            const hit = capturedResize(ctx);
            const drag = hit?.outer;
            if (!hit || !drag) return null;
            const zone = ctx.viewport.width - WIDEN_EDGE_ZONE;
            if (p.x < zone || p.x < drag.pointerX + WIDEN_ARM_DISTANCE) {
              return null;
            }
            const reach = Math.min(1.5, (p.x - zone) / WIDEN_EDGE_ZONE);
            drag.grown += WIDEN_SPEED * Math.max(0.25, reach);
            const gridWidth = draggedGridWidth(drag, p.x, minimum);
            // Growth past the cap is not banked, so easing back off answers at
            // once instead of first spending what piled up against the cap.
            drag.grown = Math.max(
              0,
              gridWidth - drag.gridWidth - (p.x - drag.pointerX),
            );
            if (gridWidth === drag.current) return null;
            return tableWidthState(ctx.state, hit, gridWidth);
          },
        },
      }),
    );
    return regions;
  }

  /**
   * The column-move grab band: the block's top margin, one grip per column.
   *
   * Above the grid rather than in the header cells, so a press there can never
   * be a press aimed at a title: the margin is space the table already owns and
   * nothing else uses (there is no row above the header for an add-strip to
   * make). Resting the pointer on it lights the column below and takes the
   * grab cursor; dragging carries that column sideways, and the grid redraws
   * in the order the drop would produce — a preview painted from the same
   * layout (`previewColumnMove`), the document untouched — so what you see is
   * what release commits, in one operation. Escape, or any cancel, puts the
   * picture back with nothing to undo. It is the block-reorder gesture turned
   * on its side, and follows the same bargain: nothing is written until
   * release, so a gesture costs one entry in the log.
   *
   * Mouse only, for the reason the add strips are: the band is revealed by
   * hover, which a finger does not have, and a touch that lands there while
   * scrolling past a table must not pick a column up. On a phone the same move
   * is a pair of commands in the keyboard toolbar's table menu.
   */
  private columnMoveRegion(
    layout: TableLayout,
    c: NodeRegionCtx,
  ): NodeHitRegion<ColumnMoveHit> {
    const blockId = c.block.id;
    const gridLeft = c.origin.x;
    const top = c.origin.y;
    // Down to, and including, the grid's own top hairline — the resize bands
    // outrank this one, so an interior edge's top end still resizes.
    const bottom = c.origin.y + layout.gridTop + 1;

    return hitRegion({
      id: COLUMN_MOVE_REGION,
      // Below the resize bands and the add strips: this band's only meeting
      // with either is the corner where an edge reaches the top margin.
      priority: 50,
      modes: ["edit", "select"],
      hitTest: (p, pointerType): ColumnMoveHit | null => {
        // `isReadonlyBase` rather than the mode, for the reason the resize band
        // gives: a readonly editor still uses `select` mode to drag-select.
        if (c.state.ui.isReadonlyBase || pointerType === "touch") return null;
        if (p.y < top || p.y > bottom) return null;
        if (p.x < gridLeft || p.x > gridLeft + layout.maxWidth) return null;
        const index = columnAtX(layout, p.x - gridLeft);
        return index === null ? null : { blockId, index };
      },
      hover: (hit) => ({
        cursor: "grab",
        target: columnMoveTarget(hit.blockId, hit.index),
      }),
      drag: {
        onStart: (hit, p, ctx) => ({
          state: setColumnDrag(ctx.state, blockId, {
            from: hit.index,
            to: dropGapAtX(layout, p.x - gridLeft),
            pressX: p.x,
            moved: false,
          }),
        }),
        onMove: (p, ctx) => {
          const drag = columnDragOf(ctx.state, blockId);
          if (!drag) return { state: ctx.state };
          return {
            state: setColumnDrag(ctx.state, blockId, {
              ...drag,
              to: dropGapAtX(layout, p.x - gridLeft),
              moved:
                drag.moved || Math.abs(p.x - drag.pressX) > COLUMN_CLICK_SLOP,
            }),
          };
        },
        onEnd: (_p, ctx) => {
          // The STORED gap, not the release position: a window-level mouseup
          // has none, and the indicator the user watched was drawn from it.
          const drag = columnDragOf(ctx.state, blockId);
          const released = setColumnDrag(ctx.state, blockId, null);
          if (!drag) return { state: released };
          // A press that never carried the column anywhere is a click on the
          // grip, and a click picks the column out: it selects it whole, ready
          // to copy, cut or format.
          if (!drag.moved) {
            const selected = released.actionBus.dispatchState(
              TABLE_SELECT_COLUMN,
              released,
              { blockId, columnIndex: drag.from },
            );
            return { state: selected.state, ops: selected.ops };
          }
          const to = columnIndexForGap(drag);
          if (to === drag.from) return { state: released };
          const result = released.actionBus.dispatchState(
            TABLE_MOVE_COLUMN,
            released,
            { blockId, columnIndex: drag.from, to },
          );
          return { state: result.state, ops: result.ops };
        },
        onCancel: (ctx) => setColumnDrag(ctx.state, blockId, null),
      },
    });
  }

  /**
   * The outer-edge "add a row/column" strips.
   *
   * One region for both edges rather than one each: they are the same
   * affordance twice over, and a single band keeps the hover name — which is
   * what `paint` reads back — in one place.
   *
   * Mouse only. The strip is revealed by hover, which a finger does not have,
   * and both bands sit exactly where a thumb rests while scrolling past a
   * table; a touch that landed on one would add a column nobody asked for. On
   * a phone the same two commands are in the keyboard toolbar's table panel.
   */
  private edgeAddRegion(
    layout: TableLayout,
    c: NodeRegionCtx,
  ): NodeHitRegion<TableEdgeAddHit> {
    const blockId = c.block.id;
    const strips = tableEdgeStrips(
      layout,
      c.origin,
      c.styles.canvas.paddingRight,
    );
    return hitRegion({
      id: EDGE_ADD_REGION,
      // Above the resize bands: the two only meet at the grid's own corner, and
      // along the right edge, where the strip's catchment stops short of the
      // edge's own grab band (see `tableEdgeStrips`).
      priority: 70,
      modes: ["edit", "select"],
      hitTest: (p, pointerType): TableEdgeAddHit | null => {
        // `isReadonlyBase` rather than the mode, for the reason the resize band
        // gives: a readonly editor still uses `select` mode to drag-select.
        if (c.state.ui.isReadonlyBase || pointerType === "touch") return null;
        const strip = strips.find((candidate) =>
          withinEdgeBox(candidate.hit, p),
        );
        return strip ? { blockId, strip } : null;
      },
      hover: (hit) => ({
        cursor: "pointer",
        target: edgeAddTarget(hit.blockId, hit.strip.edge),
      }),
      onTap: (hit, _p, _tapCount, ctx) => {
        // The new row/column goes after the last one, which is the whole point
        // of an edge control: the grid grows in the direction the strip sits.
        // The command parks the caret in the cell it just made, so the click
        // both adds the column and puts you in its header.
        const result =
          hit.strip.edge === "right"
            ? ctx.state.actionBus.dispatchState(
                TABLE_INSERT_COLUMN,
                ctx.state,
                {
                  blockId: hit.blockId,
                  columnIndex: layout.columns.length - 1,
                  side: "after",
                },
              )
            : ctx.state.actionBus.dispatchState(TABLE_INSERT_ROW, ctx.state, {
                blockId: hit.blockId,
                rowIndex: layout.rows.length - 1,
                side: "after",
              });
        return { state: result.state, ops: result.ops };
      },
    });
  }

  /**
   * The structural controls, anchored to the cell the caret is in. Geometry
   * only — the host owns what they look like. See `./overlays`.
   */
  overlays(c: NodeRegionCtx): readonly NodeOverlay[] {
    const overlay = tableToolsOverlay(
      viewedTableLayout(this.layout(c), c.state, c.block.id),
      c,
    );
    return overlay ? [overlay] : [];
  }

  /**
   * The scrollbar thumb under a wide table, dragged like the page's own: a
   * mouse grabs it at once, a finger after the same short hold — until then
   * the touch scrolls or taps as usual, so a swipe that starts on the thumb is
   * never stolen. Works in a read-only editor too: scrolling is reading, not
   * editing.
   */
  private scrollbarRegion(
    layout: TableLayout,
    c: NodeRegionCtx,
  ): NodeHitRegion<TableScrollbarHit> | null {
    const thumb = tableScrollbar(layout, c.origin, c.viewport.height);
    if (!thumb) return null;
    const blockId = c.block.id;
    const scrollX = -layout.gridX;
    return hitRegion({
      id: SCROLLBAR_REGION,
      // Above the add strip, which shares the bottom margin: the thumb is the
      // smaller target, so it wins where the two overlap.
      priority: 75,
      modes: ["edit", "select", "readonly"],
      hitTest: (p, pointerType): TableScrollbarHit | null => {
        const touch = pointerType === "touch";
        const slop = touch ? SCROLLBAR_TOUCH_BUFFER : SCROLLBAR_HIT_SLOP;
        if (p.y < thumb.y - slop || p.y > thumb.y + thumb.height + slop) {
          return null;
        }
        const sideSlop = touch ? SCROLLBAR_TOUCH_BUFFER : 0;
        if (
          p.x < thumb.x - sideSlop ||
          p.x > thumb.x + thumb.width + sideSlop
        ) {
          return null;
        }
        return { blockId, pressX: p.x, scrollX, thumb, touch };
      },
      hover: (hit) => ({
        cursor: "pointer",
        target: scrollbarTarget(hit.blockId),
      }),
      drag: {
        touchHoldMs: SCROLLBAR_HOLD_DURATION,
        activationIntensity: "medium",
        cursor: "grabbing",
        onStart: (hit, _p, ctx) => ({
          state: setScrollbarDrag(
            withStoppedMomentum(ctx.state),
            blockId,
            hit.touch ? "touch" : "mouse",
          ),
        }),
        onMove: (p, ctx) => {
          const hit = ctx.session.captured?.hit as
            TableScrollbarHit | undefined;
          if (!hit) return { state: ctx.state };
          const target = hit.scrollX + (p.x - hit.pressX) * hit.thumb.scale;
          const moved = scrollTableBy(
            ctx.state,
            blockId,
            layout,
            target - tableScrollX(ctx.state, blockId, layout),
          );
          return { state: moved ?? ctx.state };
        },
        onEnd: (_p, ctx) => ({
          state: setScrollbarDrag(ctx.state, blockId, null),
        }),
        onCancel: (ctx) => setScrollbarDrag(ctx.state, blockId, null),
      },
    });
  }

  registerActions(bus: ActionBus): void {
    registerTableActions(bus);
    registerTableInputActions(bus);
    registerTableCommands(bus);
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  readonly codec = tableBlockNodeCodec;
}

/**
 * The name this table gives one interior column edge, for `ui.regionHover`.
 *
 * The engine stores the string and never reads it; both the region that sets it
 * and the paint that looks it up build it here, so the lit edge is by
 * construction the edge under the pointer — including during the drag, where
 * the hover from the press still stands.
 */
function columnEdgeTarget(blockId: string, index: number): string {
  return `${blockId}${COLUMN_EDGE_TARGET}${index}`;
}

/** The interior edge of THIS table the pointer is on, if any. */
function hoveredColumnEdge(state: EditorState, blockId: string): number | null {
  const hover = state.ui.regionHover;
  if (!hover || hover.regionId !== COLUMN_RESIZE_REGION) return null;
  const prefix = `${blockId}${COLUMN_EDGE_TARGET}`;
  if (!hover.target.startsWith(prefix)) return null;
  const index = Number(hover.target.slice(prefix.length));
  return Number.isInteger(index) ? index : null;
}

/** The name this table gives one column's move grip, for `ui.regionHover`. */
function columnMoveTarget(blockId: string, index: number): string {
  return `${blockId}${COLUMN_MOVE_TARGET}${index}`;
}

/** The column of THIS table whose move grip the pointer is on, if any. */
function hoveredMoveColumn(state: EditorState, blockId: string): number | null {
  const hover = state.ui.regionHover;
  if (!hover || hover.regionId !== COLUMN_MOVE_REGION) return null;
  const prefix = `${blockId}${COLUMN_MOVE_TARGET}`;
  if (!hover.target.startsWith(prefix)) return null;
  const index = Number(hover.target.slice(prefix.length));
  return Number.isInteger(index) ? index : null;
}

/** Hit data for a column-move drag: which table, and which column it lifts. */
interface ColumnMoveHit {
  readonly blockId: string;
  readonly index: number;
}

/**
 * A column-move drag in flight: the column lifted, and the gap — an index in
 * `[0..columns]`, counted in the grid as it stands — the pointer is over.
 */
interface ColumnDragState {
  readonly from: number;
  readonly to: number;
  /** Where the press landed, to tell a click on the grip from a drag. */
  readonly pressX: number;
  /** Whether the pointer has travelled past {@link COLUMN_CLICK_SLOP}. */
  readonly moved: boolean;
}

/** How far a press may wander and still count as a click on the grip. */
const COLUMN_CLICK_SLOP = 3;

/** Opacity of the wash over a column whose grip the pointer is resting on. */
const COLUMN_HOVER_OPACITY = 0.08;
/** Opacity of the wash over a column while a drag holds it. */
const COLUMN_LIFT_OPACITY = 0.16;
/** The grip pill's size, and the least air it keeps from the grid and the
 *  block's top when the margin is too tight for it at full height. */
const COLUMN_GRIP_WIDTH = 28;
const COLUMN_GRIP_HEIGHT = 4;
const COLUMN_GRIP_GAP = 1;

/** The column whose span holds `localX` (relative to the block's left edge). */
function columnAtX(layout: TableLayout, localX: number): number | null {
  if (localX < layout.gridX || localX > layout.gridX + layout.gridWidth) {
    return null;
  }
  for (let at = layout.columns.length - 1; at >= 0; at--) {
    if (localX >= layout.columns[at].x) return at;
  }
  return null;
}

/**
 * The gap `localX` is nearest to: the number of columns whose midpoint lies
 * before it, so a pointer past a column's middle means "after that column".
 */
function dropGapAtX(layout: TableLayout, localX: number): number {
  let gap = 0;
  for (const column of layout.columns) {
    if (localX > column.x + column.width / 2) gap++;
  }
  return gap;
}

/**
 * The index the lifted column ends up at if dropped in `drag.to`. A gap on
 * either side of the column itself is where it already is.
 */
function columnIndexForGap(drag: ColumnDragState): number {
  return drag.to > drag.from ? drag.to - 1 : drag.to;
}

/**
 * The table's transient per-block view-state (`ui.nodeViewState[block.id]`).
 *
 * `resizeEdge` is the interior edge a resize drag is currently holding.
 * `ui.regionHover` already says that for a mouse, but it is a hover, and a
 * finger has none — so on touch the drag itself is the only thing that knows
 * which edge is live. Written by the drag, read by `paint`.
 *
 * `columnDrag` is a column-move drag in flight. The hover from the press still
 * names the lifted column, but the gap the pointer is over is the drag's own
 * knowledge, and `paint` draws the drop edge from it.
 *
 * `scrollbarDrag` is the pointer holding the scrollbar thumb, if one is. A
 * mouse's hover could say so, but a finger has none, and the thumb thickens
 * only under a finger.
 *
 * `scrollX`, how far a wide table is scrolled sideways, shares the slot and is
 * owned by `./scroll`.
 */
interface TableViewState {
  resizeEdge?: number;
  columnDrag?: ColumnDragState;
  scrollbarDrag?: "mouse" | "touch";
  scrollX?: number;
}

/** Merge a column drag into a block's view-state (or clear it with `null`),
 *  preserving whatever else a host has parked in the same slot. */
function setColumnDrag(
  state: EditorState,
  blockId: string,
  drag: ColumnDragState | null,
): EditorState {
  const previous = state.ui.nodeViewState[blockId] as
    TableViewState | undefined;
  const current = previous?.columnDrag;
  if (
    (current ?? null) === drag ||
    (current &&
      drag &&
      current.from === drag.from &&
      current.to === drag.to &&
      current.moved === drag.moved)
  ) {
    return state;
  }
  const next: TableViewState = { ...previous };
  if (drag === null) delete next.columnDrag;
  else next.columnDrag = drag;
  return {
    ...state,
    ui: {
      ...state.ui,
      nodeViewState: { ...state.ui.nodeViewState, [blockId]: next },
    },
  };
}

/** The column-move drag THIS table is holding, if any. */
function columnDragOf(
  state: EditorState,
  blockId: string,
): ColumnDragState | undefined {
  const view = state.ui.nodeViewState[blockId] as TableViewState | undefined;
  return view?.columnDrag;
}

/**
 * The layout to draw and place carets from: the real one, or — while a
 * column-move drag holds this table — the same geometry in the previewed
 * order. A drag parked beside its own column previews nothing.
 */
function previewedLayout(
  layout: TableLayout,
  c: { readonly state: EditorState; readonly block: { readonly id: string } },
): TableLayout {
  const drag = columnDragOf(c.state, c.block.id);
  if (!drag) return layout;
  return previewColumnMove(layout, drag.from, columnIndexForGap(drag));
}

/**
 * The layout exactly as it is drawn: any composition folded in, any column
 * drag previewed, scrolled sideways to where this device has the table.
 */
function shownLayout(
  layout: NodeLayout,
  c: Pick<NodeLayoutCtx, "maxWidth" | "styles" | "marks"> & {
    readonly state: EditorState;
    readonly block: Parameters<typeof getTableDocument>[0];
  },
): TableLayout {
  return viewedTableLayout(
    previewedLayout(composedLayout(layout, c), c),
    c.state,
    c.block.id,
  );
}

/** The layout inputs a table block reads from its editor instance. */
function tableLayoutCtx(
  c: Pick<NodeLayoutCtx, "maxWidth" | "styles" | "marks">,
): TableLayoutCtx {
  return {
    maxWidth: c.maxWidth,
    style: tableStyle(c.styles),
    fontFamily: currentFontFamily(c.styles),
    fonts: c.styles.fonts,
    marks: c.marks,
  };
}

/**
 * The IME text the local caret is composing in one of this table's cells.
 *
 * A structured selection stays in the document until the composition commits
 * (so a cancelled one destroys nothing), which makes a selected range here the
 * span the preview stands in for. A range across cells shows no preview: the
 * commit clears those cells whole, which a preview inside one cell cannot show.
 */
function tableComposition(
  state: EditorState,
  blockId: string,
): TableComposition | undefined {
  const composition = state.ui.composition;
  if (!composition?.isComposing || !composition.text) return undefined;
  const context = activeTableContext(state);
  if (!context || context.block.id !== blockId) return undefined;
  const { anchor, caret } = context;
  if (anchor.cellId !== caret.cellId) return undefined;
  return {
    cellId: caret.cellId,
    from: Math.min(anchor.offset, caret.offset),
    to: Math.max(anchor.offset, caret.offset),
    text: composition.text,
  };
}

/** The layout with any live composition folded into its cell. */
function composedLayout(
  layout: NodeLayout,
  c: Pick<NodeLayoutCtx, "maxWidth" | "styles" | "marks"> & {
    readonly state: EditorState;
    readonly block: Parameters<typeof getTableDocument>[0];
  },
): TableLayout {
  const composition = tableComposition(c.state, c.block.id);
  if (!composition) return layout as TableLayout;
  return layoutTable(getTableDocument(c.block), tableLayoutCtx(c), composition);
}

/**
 * Where a stored caret sits in the composed cell. The local caret rides the
 * end of the preview, as it does in a paragraph; any other caret in the cell
 * (a peer's) keeps its place in the text around it.
 */
function composedCaret(
  c: { readonly state: EditorState; readonly block: { readonly id: string } },
  point: ContentPoint,
  caret: TableCaret,
): TableCaret {
  const composition = tableComposition(c.state, c.block.id);
  if (!composition || composition.cellId !== caret.cellId) return caret;
  const focus = c.state.document.contentSelection?.focus;
  const local =
    focus?.kind === "text" &&
    point.kind === "text" &&
    focus.nodeId === point.nodeId &&
    focus.afterCharId === point.afterCharId;
  const { from, to, text } = composition;
  if (local) return { ...caret, offset: from + text.length };
  if (caret.offset <= from) return caret;
  if (caret.offset < to) return { ...caret, offset: from };
  return { ...caret, offset: caret.offset - (to - from) + text.length };
}

/** Merge the held edge into a block's view-state (or clear it with `null`),
 *  preserving whatever else a host has parked in the same slot. */
function setResizingEdge(
  state: EditorState,
  blockId: string,
  index: number | null,
): EditorState {
  const previous = state.ui.nodeViewState[blockId] as
    TableViewState | undefined;
  if ((previous?.resizeEdge ?? null) === index) return state;
  const next: TableViewState = { ...previous };
  if (index === null) delete next.resizeEdge;
  else next.resizeEdge = index;
  return {
    ...state,
    ui: {
      ...state.ui,
      nodeViewState: { ...state.ui.nodeViewState, [blockId]: next },
    },
  };
}

/** Mark which pointer holds a block's scrollbar thumb (or clear it with
 *  `null`), preserving whatever else a host has parked in the same slot. */
function setScrollbarDrag(
  state: EditorState,
  blockId: string,
  pointer: "mouse" | "touch" | null,
): EditorState {
  const previous = state.ui.nodeViewState[blockId] as
    TableViewState | undefined;
  if ((previous?.scrollbarDrag ?? null) === pointer) return state;
  const next: TableViewState = { ...previous };
  if (pointer === null) delete next.scrollbarDrag;
  else next.scrollbarDrag = pointer;
  return {
    ...state,
    ui: {
      ...state.ui,
      nodeViewState: { ...state.ui.nodeViewState, [blockId]: next },
    },
  };
}

/** The pointer holding THIS table's scrollbar thumb, if any. */
function scrollbarDragOf(
  state: EditorState,
  blockId: string,
): "mouse" | "touch" | undefined {
  const view = state.ui.nodeViewState[blockId] as TableViewState | undefined;
  return view?.scrollbarDrag;
}

/** The interior edge of THIS table a resize drag is holding, if any. */
function resizingColumnEdge(
  state: EditorState,
  blockId: string,
): number | null {
  const view = state.ui.nodeViewState[blockId] as TableViewState | undefined;
  return view?.resizeEdge ?? null;
}

/** The name this table gives one outer edge's add strip, for `ui.regionHover`. */
function edgeAddTarget(blockId: string, edge: TableEdge): string {
  return `${blockId}${EDGE_ADD_TARGET}${edge}`;
}

/** The outer edge of THIS table the pointer is resting on, if any. */
function hoveredEdgeAdd(state: EditorState, blockId: string): TableEdge | null {
  const hover = state.ui.regionHover;
  if (!hover || hover.regionId !== EDGE_ADD_REGION) return null;
  const prefix = `${blockId}${EDGE_ADD_TARGET}`;
  if (!hover.target.startsWith(prefix)) return null;
  const edge = hover.target.slice(prefix.length);
  return edge === "right" || edge === "bottom" ? edge : null;
}

/** The id the wide-table scrollbar thumb is registered (and hit) under. */
const SCROLLBAR_REGION = "table-scrollbar";

/** Separator between the block and the thumb in a hover target name. */
const SCROLLBAR_TARGET = ":scrollbar";

/** How far above and below the thin thumb a mouse still grabs it. */
const SCROLLBAR_HIT_SLOP = 5;

/** How much thicker the thumb draws while a finger holds it — the page
 *  scrollbar's own scale-up. */
const TOUCH_DRAG_THUMB_SCALE = 1.5;

/** How wide the fade is at a wide table's cut-off side. */
const EDGE_FADE_WIDTH = 24;

/** The name this table gives its scrollbar thumb, for `ui.regionHover`. */
function scrollbarTarget(blockId: string): string {
  return `${blockId}${SCROLLBAR_TARGET}`;
}

/** Whether the pointer is resting on (or dragging) THIS table's thumb. */
function hoversScrollbar(state: EditorState, blockId: string): boolean {
  const hover = state.ui.regionHover;
  return (
    hover?.regionId === SCROLLBAR_REGION &&
    hover.target === scrollbarTarget(blockId)
  );
}

/** Hit data for a scrollbar drag: where it was pressed, and the offset then. */
interface TableScrollbarHit {
  readonly blockId: string;
  readonly pressX: number;
  readonly scrollX: number;
  readonly thumb: TableScrollbar;
  /** Pressed by a finger, which thickens the thumb while it holds it. */
  readonly touch: boolean;
}

/** Hit data for an edge-strip click: which table, and which strip. */
interface TableEdgeAddHit {
  readonly blockId: string;
  readonly strip: TableEdgeStrip;
}

/** Opacity of the strip's tinted band — a wash, not a filled accent bar. */
const EDGE_ADD_WASH_OPACITY = 0.16;

/** Padding between the plus glyph and the band's short edges. */
const EDGE_ADD_GLYPH_INSET = 6;

/** Hit data for a column-resize drag: which edge, and its start state. */
interface ColumnResizeHit {
  readonly blockId: string;
  /**
   * The edge between columns `index - 1` and `index`; the column count for the
   * grid's right edge.
   */
  readonly index: number;
  /**
   * Filled in `onStart` for the right edge, which drags the table's own width
   * rather than trading between two columns.
   */
  outer?: TableWidthDrag;
  /** Filled in `onStart`; read back off `session.captured.hit` thereafter. */
  start?: {
    readonly pointerX: number;
    readonly gridWidth: number;
    readonly leftWidth: number;
    readonly rightWidth: number;
    readonly leftFraction: number | null;
    readonly rightFraction: number | null;
  };
}

/** The table attached to a block id, if that block is a live table. */
function tableDocumentById(
  state: EditorState,
  blockId: string,
): StructuredDocument | undefined {
  const block = state.document.page.blocks.find(
    (candidate) => candidate.id === blockId,
  );
  return block && !block.deleted ? getTableDocument(block) : undefined;
}

/** The resize hit currently holding the pointer, if any. */
function capturedResize(ctx: RegionCtx): ColumnResizeHit | undefined {
  return (
    (ctx.session.captured?.hit as ColumnResizeHit | undefined) ?? undefined
  );
}

/**
 * The two fractions an edge dragged to `pointerX` implies.
 *
 * The pair's combined width never changes, so every other column stays exactly
 * where it is and only the dragged edge moves. Each side stops at `minimum`,
 * which is where the fitting pass would have stopped it anyway.
 */
function resizedFractions(
  hit: ColumnResizeHit,
  pointerX: number,
  minimum: number,
): { readonly left: number; readonly right: number } | undefined {
  const start = hit.start;
  if (!start || start.gridWidth <= 0) return undefined;
  const pair = start.leftWidth + start.rightWidth;
  const floor = Math.min(minimum, pair / 2);
  const left = Math.max(
    floor,
    Math.min(pair - floor, start.leftWidth + (pointerX - start.pointerX)),
  );
  return {
    left: left / start.gridWidth,
    right: (pair - left) / start.gridWidth,
  };
}

/** The edits that put a pair of columns at the given fractions. */
function widthEdits(
  document: StructuredDocument,
  hit: ColumnResizeHit,
  left: number | null,
  right: number | null,
): readonly StructuredEdit[] | undefined {
  return setColumnWidths(document, [
    { columnIndex: hit.index - 1, fraction: left },
    { columnIndex: hit.index, fraction: right },
  ])?.edits;
}

/**
 * Move a pair of columns to new widths locally, emitting no operations.
 *
 * This is the live drag: it repaints every frame, and writing an operation per
 * frame would fill the log with the intermediate widths of a gesture nobody
 * else is watching. The release commits the one width that matters.
 */
function widthState(
  state: EditorState,
  hit: ColumnResizeHit,
  left: number | null,
  right: number | null,
): EditorState {
  const document = tableDocumentById(state, hit.blockId);
  if (!document) return state;
  const edits = widthEdits(document, hit, left, right);
  if (!edits || edits.length === 0) return state;
  return withTableDocument(
    state,
    hit.blockId,
    applyStructuredEdits(document, edits),
  );
}

/** Write the released widths to the document as operations. */
function commitColumnWidths(
  state: EditorState,
  hit: ColumnResizeHit,
  pointerX: number | null,
  minimum: number,
): { readonly state: EditorState; readonly ops: Operation[] } {
  const live = tableDocumentById(state, hit.blockId);
  const start = hit.start;
  if (!live || !start) return { state, ops: [] };

  // A release whose position is unknown (a window-level mouseup) keeps what the
  // last move produced rather than snapping back — so the widths are read back
  // out of the live document instead of recomputed from the pointer.
  const columns = readTable(live).columns;
  const fractions =
    pointerX === null
      ? {
          left: columnWidth(columns[hit.index - 1]),
          right: columnWidth(columns[hit.index]),
        }
      : resizedFractions(hit, pointerX, minimum);
  if (!fractions) return { state, ops: [] };

  // Committed from the widths the press found, so undo returns to them.
  const base = widthState(state, hit, start.leftFraction, start.rightFraction);
  const block = base.document.page.blocks.find(
    (candidate) => candidate.id === hit.blockId,
  );
  const document = block ? getTableDocument(block) : undefined;
  const edits =
    document && widthEdits(document, hit, fractions.left, fractions.right);
  if (!block || !document || !edits) return { state, ops: [] };

  const committed = commitTableEdits(
    base,
    { block, document },
    edits,
    undefined,
  );
  return { state: withDragUndo(base, committed), ops: committed.ops };
}

/**
 * Record a released drag's operations for undo against `base` — the document
 * as the press found it — and hand back the state carrying that entry.
 *
 * The editor records an action's operations against the state it last had,
 * and a live drag has already repainted that state at the dragged widths: the
 * inverse it took would put back the widths the drag ended on, and undo would
 * do nothing. An action that records its own entry is left to it (as undo and
 * redo are), so the drag records one against the widths it started from.
 */
function withDragUndo(
  base: EditorState,
  committed: { readonly state: EditorState; readonly ops: Operation[] },
): EditorState {
  if (committed.ops.length === 0) return committed.state;
  return recordUndoOps(
    base,
    committed.state,
    committed.ops,
    base.CRDTbinding.getPeerId(),
  );
}

/**
 * How close to the screen's right edge (px) a held table edge starts widening
 * the table on its own, and how fast (px a frame, scaled by how far in).
 */
const WIDEN_EDGE_ZONE = 24;
const WIDEN_SPEED = 8;
/**
 * How far right of where it was grabbed the pointer must be before holding it
 * at the screen's edge widens the table. On a phone the edge is grabbed inside
 * that zone, and merely holding it must not set it growing.
 */
const WIDEN_ARM_DISTANCE = 4;

/** A drag of the grid's right edge, from press to release. */
interface TableWidthDrag {
  readonly pointerX: number;
  /** The page width the table is laid out against; widths are stored per it. */
  readonly maxWidth: number;
  readonly gridWidth: number;
  /** The width the table falls back to with no width of its own. */
  readonly automatic: number;
  /** Every column's width at the press; all but the last keep it. */
  readonly widths: readonly number[];
  // What the document held at the press, for a cancel to put back.
  readonly fractions: readonly (number | null)[];
  readonly tableWidth: number | null;
  readonly scrollX: number;
  /** Width added by holding the pointer at the screen's edge. */
  grown: number;
  /** The grid width last shown, which a release with no position commits. */
  current: number;
}

/**
 * The grid width the right edge dragged to `pointerX` implies: the press width
 * plus the pointer's travel, never under the automatic width or a last column
 * narrower than `minimum`, never over `MAX_TABLE_WIDTH` pages.
 */
function draggedGridWidth(
  drag: TableWidthDrag,
  pointerX: number,
  minimum: number,
): number {
  const last = drag.widths[drag.widths.length - 1] ?? 0;
  const others = drag.gridWidth - last;
  const lowest = Math.max(drag.automatic, others + Math.min(minimum, last));
  const highest = Math.max(lowest, Math.floor(drag.maxWidth * MAX_TABLE_WIDTH));
  const wanted = drag.gridWidth + (pointerX - drag.pointerX) + drag.grown;
  return Math.round(Math.max(lowest, Math.min(highest, wanted)));
}

/**
 * The edits that draw the table `gridWidth` wide with every column but the last
 * at its press width. Every column is pinned to its fraction of the new width:
 * a column left automatic would take a share of the change.
 */
function tableWidthEdits(
  document: StructuredDocument,
  drag: TableWidthDrag,
  gridWidth: number,
): readonly StructuredEdit[] {
  const count = drag.widths.length;
  const others = drag.gridWidth - (drag.widths[count - 1] ?? 0);
  const width = gridWidth <= drag.automatic ? null : gridWidth / drag.maxWidth;
  return [
    ...(setTableWidth(document, width)?.edits ?? []),
    ...(setColumnWidths(
      document,
      drag.widths.map((columnWidth, at) => ({
        columnIndex: at,
        fraction:
          (at === count - 1 ? gridWidth - others : columnWidth) / gridWidth,
      })),
    )?.edits ?? []),
  ];
}

/**
 * The live right-edge drag: the new widths applied locally, emitting no
 * operations (see `widthState`), and the table kept scrolled to its end so the
 * edge stays on the page's edge under the drag.
 */
function tableWidthState(
  state: EditorState,
  hit: ColumnResizeHit,
  gridWidth: number,
): EditorState {
  const drag = hit.outer;
  const document = tableDocumentById(state, hit.blockId);
  if (!drag || !document) return state;
  drag.current = gridWidth;
  const resized = withTableDocument(
    state,
    hit.blockId,
    applyStructuredEdits(document, tableWidthEdits(document, drag, gridWidth)),
  );
  return withTableScrollX(
    resized,
    hit.blockId,
    Math.max(0, gridWidth - drag.maxWidth),
  );
}

/** Write the released table width to the document as operations. */
function commitTableWidth(
  state: EditorState,
  hit: ColumnResizeHit,
  gridWidth: number,
): { readonly state: EditorState; readonly ops: Operation[] } {
  const drag = hit.outer;
  if (!drag) return { state, ops: [] };
  // Committed from the widths the press found, so undo returns to them (see
  // `withDragUndo`).
  const base = restoreTableWidth(state, hit, drag);
  const block = base.document.page.blocks.find(
    (candidate) => candidate.id === hit.blockId,
  );
  const document = block ? getTableDocument(block) : undefined;
  if (!block || !document) return { state, ops: [] };
  const committed = commitTableEdits(
    base,
    { block, document },
    tableWidthEdits(document, drag, gridWidth),
    undefined,
  );
  return {
    state: withTableScrollX(
      withDragUndo(base, committed),
      hit.blockId,
      Math.max(0, gridWidth - drag.maxWidth),
    ),
    ops: committed.ops,
  };
}

/** Put a cancelled right-edge drag's widths and scroll back as they were. */
function restoreTableWidth(
  state: EditorState,
  hit: ColumnResizeHit,
  drag: TableWidthDrag,
): EditorState {
  const document = tableDocumentById(state, hit.blockId);
  if (!document) return state;
  const edits = [
    ...(setTableWidth(document, drag.tableWidth)?.edits ?? []),
    ...(setColumnWidths(
      document,
      drag.fractions.map((fraction, columnIndex) => ({
        columnIndex,
        fraction,
      })),
    )?.edits ?? []),
  ];
  const restored = withTableDocument(
    state,
    hit.blockId,
    applyStructuredEdits(document, edits),
  );
  return withTableScrollX(restored, hit.blockId, drag.scrollX);
}
