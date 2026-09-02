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
  TABLE_INSERT_COLUMN,
  TABLE_INSERT_ROW,
  TABLE_MOVE_COLUMN,
} from "./commands";
import { commitTableEdits, withTableDocument } from "./context";
import { tableBlockNodeCodec } from "./data";
import {
  type TableEdge,
  type TableEdgeStrip,
  tableEdgeStrips,
  withinEdgeBox,
} from "./edge-adders";
import { layoutTable, previewColumnMove, type TableLayout } from "./geometry";
import { registerTableInputActions } from "./input";
import { tableToolsOverlay } from "./overlays";
import {
  cellCaretHeight,
  cellFromPoint,
  cellLineAtOffset,
  cellOffsetFromPoint,
  cellOffsetX,
  tableCaretFromContentPoint,
  tableCaretToContentSelection,
} from "./selection";
import {
  cellText,
  columnWidth,
  getTableDocument,
  readTable,
} from "./structured";
import type { ActionBus } from "@tasfer/editor/action-bus";
import { SCROLLBAR_HOLD_DURATION } from "@tasfer/editor/constants";
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
  type NodeHitRegion,
  type NodeLayout,
  type NodeLayoutCtx,
  type NodePaintCtx,
  type NodeRegionCtx,
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
import {
  applyStructuredEdits,
  type StructuredDocument,
  type StructuredEdit,
} from "@tasfer/editor/sync/structured-content";

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
      layoutTable(getTableDocument(c.block), {
        maxWidth: c.maxWidth,
        style: tableStyle(c.styles),
        fontFamily: currentFontFamily(c.styles),
        fonts: c.styles.fonts,
        marks: c.marks,
      }),
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

    // Nominal column widths: a pinned column takes its stored fraction, and the
    // rest share what is left. The fitter reaches a different answer from real
    // text metrics — this only has to be close enough to get the line COUNT right.
    const pinned = view.columns.map((column) => columnWidth(column));
    const pinnedWidth = pinned.reduce<number>(
      (total, fraction) => total + (fraction ?? 0) * c.maxWidth,
      0,
    );
    const autoCount = pinned.filter((fraction) => fraction === null).length;
    const autoWidth =
      autoCount > 0 ? Math.max(0, c.maxWidth - pinnedWidth) / autoCount : 0;

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
          pinned[column] !== null ? pinned[column]! * c.maxWidth : autoWidth;
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
    // untouched until the release says so.
    const layout = previewedLayout(passedLayout as TableLayout, c);
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

    ctx.save();

    // The cell washes are clipped to the grid's rounded outline so none of them
    // can bleed past its corners.
    ctx.beginPath();
    ctx.roundRect(x, gridTop, layout.gridWidth, gridHeight, style.borderRadius);
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
    this.paintEdgeAdder(layout, c, x, y);
    this.paintColumnMove(layout, c, x, y);

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
    ctx.fillRect(x, y + layout.gridTop, layout.gridWidth, layout.gridHeight);
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
      x,
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
    if (selection.focus.blockId !== c.block.id) return;
    if (selection.anchor.kind !== "text" || selection.focus.kind !== "text") {
      return;
    }
    const document = getTableDocument(c.block);
    if (!document) return;
    const anchor = tableCaretFromContentPoint(document, selection.anchor);
    const focus = tableCaretFromContentPoint(document, selection.focus);
    if (!anchor || !focus) return;
    if (anchor.cellId === focus.cellId && anchor.offset === focus.offset) {
      return;
    }

    // Same fill, opacity and corner rounding prose uses, so a selection that
    // starts in a paragraph and a selection inside a cell look like one thing.
    const rects: DecorationRect[] = [];

    if (anchor.cellId === focus.cellId) {
      const cell = layout.cells.find(
        (candidate) => candidate.cellId === anchor.cellId,
      );
      if (cell) {
        const from = Math.min(anchor.offset, focus.offset);
        const to = Math.max(anchor.offset, focus.offset);
        for (let at = 0; at < cell.lines.length; at++) {
          const line = cell.lines[at];
          const start = Math.max(from, line.startIndex);
          const end = Math.min(to, line.endIndex);
          if (end <= start) continue;
          const startX = cellOffsetX(layout, cell, at, start);
          const endX = cellOffsetX(layout, cell, at, end);
          const width = Math.abs(endX - startX);
          if (width <= 0 || line.height <= 0) continue;
          rects.push({
            x: x + Math.min(startX, endX),
            y: y + line.y,
            width,
            height: line.height,
            baseline: y + line.y + (line.baselineOffset ?? 0),
          });
        }
      }
      paintDecorationRects(c.ctx, rects, deco, c.styles);
      return;
    }

    const order = layout.cells.filter((cell) => cell.cellId !== null);
    const from = order.findIndex((cell) => cell.cellId === anchor.cellId);
    const to = order.findIndex((cell) => cell.cellId === focus.cellId);
    if (from >= 0 && to >= 0) {
      for (let at = Math.min(from, to); at <= Math.max(from, to); at++) {
        const cell = order[at];
        if (cell.width <= 0 || cell.height <= 0) continue;
        rects.push(
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
      }
    }
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
      // A line can still be wider than its cell when the grid was squeezed past
      // the point wrapping can help — a single glyph is unbreakable, and the
      // table must fit the block width regardless. Clip those cells to their own
      // box so the overflow stops at the hairline instead of painting across the
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
    for (let at = 1; at < layout.rows.length; at++) {
      const edge = align(y + layout.rows[at].y);
      ctx.moveTo(x, edge);
      ctx.lineTo(x + layout.gridWidth, edge);
    }
    ctx.stroke();

    ctx.beginPath();
    ctx.roundRect(
      align(x),
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
      x,
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

  // ── Caret and hit-testing ─────────────────────────────────────────────────

  /**
   * A pointer inside the table always resolves to a cell caret — the table has
   * no flat text for the ordinary path to land in, and clamping to the nearest
   * cell is what lets a drag that strays outside the grid keep selecting.
   */
  contentSelectionFromPoint(
    passedLayout: NodeLayout,
    local: Point,
    c: NodeContentHitCtx<TableBlock>,
    _options: NodeContentHitOptions,
  ) {
    const layout = passedLayout as TableLayout;
    const document = getTableDocument(c.block);
    if (!document) return null;
    const cell = cellFromPoint(layout, local);
    if (!cell?.cellId) return null;
    return (
      tableCaretToContentSelection(document, c.block.id, {
        cellId: cell.cellId,
        offset: cellOffsetFromPoint(layout, cell, local),
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
    // the previewed order the grid is painted in.
    const layout = previewedLayout(passedLayout as TableLayout, c);
    const document = getTableDocument(c.block);
    if (!document) return null;
    const caret = tableCaretFromContentPoint(document, point);
    if (!caret) return null;
    const cell = layout.cells.find(
      (candidate) => candidate.cellId === caret.cellId,
    );
    if (!cell) return null;
    const lineIndex = cellLineAtOffset(cell, caret.offset);
    const line = cell.lines[lineIndex];
    if (!line) return null;
    return {
      x: c.origin.x + cellOffsetX(layout, cell, lineIndex, caret.offset),
      y: c.origin.y + line.y,
      // Text height, not the line box — core draws this rect verbatim, so the
      // node owns how tall its caret looks. See `cellCaretHeight`.
      height: cellCaretHeight(layout),
    };
  }

  // ── Editing affordances ───────────────────────────────────────────────────

  /**
   * The column-resize handles: one grab band on every interior column edge.
   *
   * Only interior edges. The grid is always exactly as wide as the page — there
   * is no horizontal scroll to reveal more — so the outer edges have nowhere to
   * go; dragging one would either do nothing or push the table off the page.
   * An interior edge instead trades width between the two columns it separates,
   * which keeps the total fixed by construction.
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
    const layout = this.layout(c);
    if (layout.columns.length === 0 || layout.rows.length === 0) return [];
    const gridTop = c.origin.y + layout.gridTop;
    const gridBottom = gridTop + layout.gridHeight;
    const blockId = c.block.id;
    const minimum = layout.style.minColumnWidth;

    const regions: NodeHitRegion[] = [this.edgeAddRegion(layout, c)];
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
            if (Math.abs(p.x - edge) <= slop) {
              return { blockId, index: at };
            }
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
            const columns = readTable(document).columns;
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
            if (!hit?.start) return { state: released };
            // The live drag repainted without writing operations; the release
            // states the final widths once, which is all any peer ever sees.
            return commitColumnWidths(released, hit, p?.x ?? null, minimum);
          },
          onCancel: (ctx) => {
            const hit = capturedResize(ctx);
            const released = setResizingEdge(ctx.state, blockId, null);
            const start = hit?.start;
            if (!hit || !start) return released;
            return widthState(
              released,
              hit,
              start.leftFraction,
              start.rightFraction,
            );
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
          }),
        }),
        onMove: (p, ctx) => {
          const drag = columnDragOf(ctx.state, blockId);
          if (!drag) return { state: ctx.state };
          return {
            state: setColumnDrag(ctx.state, blockId, {
              ...drag,
              to: dropGapAtX(layout, p.x - gridLeft),
            }),
          };
        },
        onEnd: (_p, ctx) => {
          // The STORED gap, not the release position: a window-level mouseup
          // has none, and the indicator the user watched was drawn from it.
          const drag = columnDragOf(ctx.state, blockId);
          const released = setColumnDrag(ctx.state, blockId, null);
          if (!drag) return { state: released };
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
      // an edge with nothing beyond it cannot be dragged anyway.
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
    const overlay = tableToolsOverlay(this.layout(c), c);
    return overlay ? [overlay] : [];
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
}

/** Opacity of the wash over a column whose grip the pointer is resting on. */
const COLUMN_HOVER_OPACITY = 0.08;
/** Opacity of the wash over a column while a drag holds it. */
const COLUMN_LIFT_OPACITY = 0.16;
/** The grip pill's size, and the least air it keeps from the grid and the
 *  block's top when the margin is too tight for it at full height. */
const COLUMN_GRIP_WIDTH = 28;
const COLUMN_GRIP_HEIGHT = 4;
const COLUMN_GRIP_GAP = 1;

/** The column whose span holds `localX` (relative to the grid's left edge). */
function columnAtX(layout: TableLayout, localX: number): number | null {
  if (localX < 0 || localX > layout.gridWidth) return null;
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
 */
interface TableViewState {
  resizeEdge?: number;
  columnDrag?: ColumnDragState;
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
    (current && drag && current.from === drag.from && current.to === drag.to)
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

/** Hit data for an edge-strip click: which table, and which strip. */
interface TableEdgeAddHit {
  readonly blockId: string;
  readonly strip: TableEdgeStrip;
}

/** Opacity of the strip's tinted band — a wash, not a filled accent bar. */
const EDGE_ADD_WASH_OPACITY = 0.16;

/** Padding between the plus glyph and the band's short edges. */
const EDGE_ADD_GLYPH_INSET = 6;

/** Hit data for a column-resize drag: which interior edge, and its start state. */
interface ColumnResizeHit {
  readonly blockId: string;
  /** The edge between columns `index - 1` and `index`. */
  readonly index: number;
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
  const block = state.document.page.blocks.find(
    (candidate) => candidate.id === hit.blockId,
  );
  const document = block ? getTableDocument(block) : undefined;
  if (!block || !document) return { state, ops: [] };

  // A release whose position is unknown (a window-level mouseup) keeps what the
  // last move produced rather than snapping back — so the widths are read back
  // out of the live document instead of recomputed from the pointer.
  const columns = readTable(document).columns;
  const fractions =
    pointerX === null
      ? {
          left: columnWidth(columns[hit.index - 1]),
          right: columnWidth(columns[hit.index]),
        }
      : resizedFractions(hit, pointerX, minimum);
  const edits = fractions
    ? widthEdits(document, hit, fractions.left, fractions.right)
    : undefined;
  if (!edits) return { state, ops: [] };

  const committed = commitTableEdits(
    state,
    { block, document },
    edits,
    undefined,
  );
  return { state: committed.state, ops: committed.ops };
}
