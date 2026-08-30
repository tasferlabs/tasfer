/**
 * Caret navigation and selection for tables — the action-bus half of the cell
 * caret model.
 *
 * The engine's own caret moves address flat block text, and a table block has
 * none, so every motion that starts or ends inside a table is claimed here and
 * answered in cell addresses instead. Two directions matter:
 *
 *   - inside → inside: step between characters and cells (`./selection`);
 *   - across the boundary: enter a table the document caret is moving toward,
 *     and leave it at its top and bottom edges. Without both, a table is a trap
 *     a keyboard user can enter and not leave (or, worse, never reach).
 *
 * Selection is the same walk with the anchor left behind: every Shift+key is
 * the motion its unshifted twin performs, committed as a range rather than a
 * caret, and a double/triple click takes the word or the cell around the caret
 * the click just placed. Producing the range is all that was missing — painting
 * it, marking it and deleting it have always read a two-ended nested selection
 * (see `TableNode.paintSelection`, `./marks`, `./input`).
 *
 * The keys stay claimed at the grid's edges rather than escaping into the
 * document: a nested range and a flat one are different models, and a
 * half-and-half selection has no meaning the rest of the engine could act on.
 *
 * Every handler is a pure state transform emitting no ops — moving a caret or
 * selecting text changes no document content. The one exception is leaving the
 * table at the document's edge, which has to grow the paragraph it lands in and
 * so carries that block's `block_insert` (see {@link exitTable}).
 */

import {
  activeTableContext,
  type Claimed,
  selectTableBlock,
  type TableContext,
} from "./context";
import { layoutTable, type TableLayout } from "./geometry";
import {
  cellRuns,
  cellTextRange,
  cellWordRange,
  moveTableCaretVertically,
  stepTableCaret,
  type TableCaret,
  type TableCaretStep,
  tableCaretToContentSelection,
  type TableCellRange,
  tableEntryCaret,
  tableRangeToContentSelection,
} from "./selection";
import { getTableDocument } from "./structured";
import type { ActionBus } from "@tasfer/editor/action-bus";
import {
  appendTrailingParagraph,
  prependLeadingParagraph,
  SELECT_ALL,
} from "@tasfer/editor/actions/edit-actions";
import {
  EXTEND_SELECTION_DOWN,
  EXTEND_SELECTION_END,
  EXTEND_SELECTION_HOME,
  EXTEND_SELECTION_LEFT,
  EXTEND_SELECTION_PAGE_DOWN,
  EXTEND_SELECTION_PAGE_UP,
  EXTEND_SELECTION_RIGHT,
  EXTEND_SELECTION_UP,
  EXTEND_SELECTION_WORD_LEFT,
  EXTEND_SELECTION_WORD_RIGHT,
  MOVE_CONTENT_TAB,
  MOVE_CURSOR_DOWN,
  MOVE_CURSOR_LEFT,
  MOVE_CURSOR_PAGE_DOWN,
  MOVE_CURSOR_PAGE_UP,
  MOVE_CURSOR_RIGHT,
  MOVE_CURSOR_UP,
  MOVE_TO_LINE_END,
  MOVE_TO_LINE_START,
  MOVE_TO_NEXT_WORD,
  MOVE_TO_PREVIOUS_WORD,
  type ViewportPayload,
} from "@tasfer/editor/actions/keyboard-actions";
import {
  SELECT_LINE_AT_POINT,
  SELECT_WORD_AT_POINT,
} from "@tasfer/editor/actions/mouse-actions";
import {
  TAP_SELECT_LINE,
  TAP_SELECT_WORD,
} from "@tasfer/editor/actions/touch-actions";
import { currentFontFamily } from "@tasfer/editor/fonts";
import { getTextDirection } from "@tasfer/editor/rtl";
import {
  clearSelection,
  getCursorDocumentCoords,
  moveCursorToPosition,
} from "@tasfer/editor/selection";
import type { Block } from "@tasfer/editor/serlization/loadPage";
import type { EditorState, ViewportState } from "@tasfer/editor/state-types";
import { updateMode } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { getEditorStyles } from "@tasfer/editor/styles";
import { getVisibleTextFromRuns } from "@tasfer/editor/sync/char-runs";
import {
  findNextVisibleBlockIndex,
  findPreviousVisibleBlockIndex,
} from "@tasfer/editor/sync/reducer";
import type { StructuredDocument } from "@tasfer/editor/sync/structured-content";

/** A claimed motion: state changed (or deliberately did not), no ops. */
function claim(state: EditorState): Claimed {
  return { state, ops: [], handled: true };
}

/** Lay a table block out at the current viewport width. */
function tableLayoutFor(
  state: EditorState,
  block: Block,
  viewport: ViewportState,
): TableLayout {
  const styles = getEditorStyles(state);
  return layoutTable(getTableDocument(block), {
    maxWidth:
      viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight),
    style: styles.blocks.table,
    fontFamily: currentFontFamily(styles),
    fonts: styles.fonts,
    marks: state.marks,
  });
}

/** Park the nested caret at `caret`, clearing any flat selection. */
function placeCaret(
  state: EditorState,
  context: Pick<TableContext, "block" | "document">,
  caret: TableCaret,
): Claimed | undefined {
  const selection = tableCaretToContentSelection(
    context.document,
    context.block.id,
    caret,
  );
  if (!selection) return undefined;
  return claim(
    updateContentSelection(clearSelection(state), {
      ...selection,
      lastUpdate: Date.now(),
    }),
  );
}

/**
 * Park a two-ended nested selection from `anchor` to `focus`.
 *
 * The collapsed case goes through {@link placeCaret} instead, which stamps both
 * ends with the same forward affinity a caret wants; a range wants its anchor
 * to stay glued to the character it starts after.
 */
function placeRange(
  state: EditorState,
  context: Pick<TableContext, "block" | "document">,
  anchor: TableCaret,
  focus: TableCaret,
): Claimed | undefined {
  if (anchor.cellId === focus.cellId && anchor.offset === focus.offset) {
    return placeCaret(state, context, focus);
  }
  const selection = tableRangeToContentSelection(
    context.document,
    context.block.id,
    anchor,
    focus,
  );
  if (!selection) return undefined;
  return claim(
    updateContentSelection(clearSelection(state), {
      ...selection,
      lastUpdate: Date.now(),
    }),
  );
}

/**
 * Leave the table for the block above or below, placing an ordinary flat
 * caret.
 *
 * At the document edge there is no block to land in, so one is grown: a table
 * stores no flat text, and a document that starts or ends with a grid would
 * otherwise have nowhere to type. Core owns that paragraph — the same helper
 * behind every other block's edge escape — so the schema clamp and the order
 * key stay in one place; it declines only when the schema forbids a block
 * there, and then the caret stays put rather than vanishing.
 */
function exitTable(
  state: EditorState,
  context: TableContext,
  direction: "up" | "down",
): Claimed | undefined {
  const blocks = state.document.page.blocks;
  const target =
    direction === "up"
      ? findPreviousVisibleBlockIndex(blocks, context.blockIndex)
      : findNextVisibleBlockIndex(blocks, context.blockIndex);
  const next = updateContentSelection(state, null);
  if (target === null) {
    const edge =
      direction === "up"
        ? prependLeadingParagraph(next)
        : appendTrailingParagraph(next, context.block);
    return edge.kind === "break"
      ? { state: edge.state, ops: edge.ops, handled: true }
      : undefined;
  }
  return claim(moveCursorToPosition(clearSelection(next), target, 0));
}

/**
 * Enter the table the document caret is about to move past.
 *
 * Core's vertical moves skip a non-textual block, so without this a table
 * cannot be reached with the arrow keys at all. The caret keeps its horizontal
 * position, landing in the column it was already over.
 */
function enterAdjacentTable(
  state: EditorState,
  direction: "up" | "down",
  viewport: ViewportState,
): Claimed | undefined {
  const cursor = state.document.cursor;
  if (!cursor || state.document.contentSelection) return undefined;
  const blocks = state.document.page.blocks;
  const target =
    direction === "up"
      ? findPreviousVisibleBlockIndex(blocks, cursor.position.blockIndex)
      : findNextVisibleBlockIndex(blocks, cursor.position.blockIndex);
  const block = target === null ? undefined : blocks[target];
  if (!block || (block.type as string) !== "table") return undefined;
  const document = getTableDocument(block);
  if (!document) return undefined;

  const layout = tableLayoutFor(state, block, viewport);
  const styles = getEditorStyles(state);
  // The x the caret is leaving from, in the block-local space the layout uses.
  // Core keeps no goal column across vertical moves, so it is read off the live
  // caret exactly as core's own line-to-line move does.
  const coords = getCursorDocumentCoords(
    cursor.position,
    state,
    viewport,
    styles,
  );
  const x = Math.max(
    0,
    (coords?.x ?? styles.canvas.paddingLeft) - styles.canvas.paddingLeft,
  );
  const caret = tableEntryCaret(layout, direction, x);
  if (!caret) return undefined;
  return placeCaret(state, { block, document }, caret);
}

/** Register every table caret motion on one editor instance's bus. */
export function registerTableActions(bus: ActionBus): void {
  // Horizontal steps. LEFT and RIGHT are visual keys, so they map onto the
  // logical steps the other way round in a right-to-left cell — for whole words
  // as much as for single characters.
  const horizontal = (
    context: TableContext,
    key: "left" | "right",
    unit: "character" | "word",
  ): TableCaretStep => {
    const forward = (key === "left") === cellIsRTL(context);
    if (unit === "word") return forward ? "word-forward" : "word-backward";
    return forward ? "forward" : "backward";
  };

  const step =
    (key: "left" | "right", unit: "character" | "word") =>
    (state: EditorState): Claimed | undefined => {
      const context = activeTableContext(state);
      if (!context) return undefined;
      const moved = stepTableCaret(
        context.document,
        context.caret,
        horizontal(context, key, unit),
      );
      // No neighbouring stop means the table's very start or end: claim the key
      // anyway so the caret never escapes sideways into a block it cannot
      // address.
      return moved ? placeCaret(state, context, moved) : claim(state);
    };
  bus.registerState(MOVE_CURSOR_LEFT, step("left", "character"), 100);
  bus.registerState(MOVE_CURSOR_RIGHT, step("right", "character"), 100);
  bus.registerState(MOVE_TO_PREVIOUS_WORD, step("left", "word"), 100);
  bus.registerState(MOVE_TO_NEXT_WORD, step("right", "word"), 100);

  // The step a Shift+key takes. While the range is still inside one cell it is
  // the ordinary character or word step its unshifted twin takes; once the range
  // covers more than one cell it is a whole CELL.
  //
  // A cross-cell range has no half-covered cell: the band paints every covered
  // cell whole, and copy and delete take them whole (`./content-selection`,
  // `./input`). Stepping by character there would walk the focus through a cell
  // that is already wholly selected — a wide cell swallowing a press per
  // character, the selection visibly frozen for as long as it takes to cross.
  //
  // `next-cell` lands at the next cell's start and `previous-cell` at the
  // previous cell's end, so growing and shrinking are exact inverses: turning
  // back into the anchor's own cell restores the character range that crossed
  // out of it.
  const extendMotion = (
    context: TableContext,
    key: "left" | "right",
    unit: "character" | "word",
  ): TableCaretStep => {
    if (context.anchor.cellId === context.caret.cellId) {
      return horizontal(context, key, unit);
    }
    const forward = (key === "left") === cellIsRTL(context);
    return forward ? "next-cell" : "previous-cell";
  };

  const extendStep =
    (key: "left" | "right", unit: "character" | "word") =>
    (state: EditorState): Claimed | undefined => {
      const context = activeTableContext(state);
      if (!context) return undefined;
      const moved = stepTableCaret(
        context.document,
        context.caret,
        extendMotion(context, key, unit),
      );
      // At the grid's first and last stop the range simply stops growing; the
      // key stays claimed so the selection never spills into the flat model.
      return moved
        ? placeRange(state, context, context.anchor, moved)
        : claim(state);
    };
  bus.registerState(
    EXTEND_SELECTION_LEFT,
    extendStep("left", "character"),
    100,
  );
  bus.registerState(
    EXTEND_SELECTION_RIGHT,
    extendStep("right", "character"),
    100,
  );
  bus.registerState(
    EXTEND_SELECTION_WORD_LEFT,
    extendStep("left", "word"),
    100,
  );
  bus.registerState(
    EXTEND_SELECTION_WORD_RIGHT,
    extendStep("right", "word"),
    100,
  );

  const edge =
    (motion: TableCaretStep) =>
    (state: EditorState): Claimed | undefined => {
      const context = activeTableContext(state);
      if (!context) return undefined;
      const moved = stepTableCaret(context.document, context.caret, motion);
      return moved ? placeCaret(state, context, moved) : claim(state);
    };
  bus.registerState(MOVE_TO_LINE_START, edge("cell-start"), 100);
  bus.registerState(MOVE_TO_LINE_END, edge("cell-end"), 100);

  // Shift+Home / Shift+End select to the cell's own edges. Their Ctrl variants
  // address the document's start and end, which is a flat position — left to
  // the generic handlers, which is also how a table is escaped that way.
  const extendEdge =
    (motion: TableCaretStep) =>
    (state: EditorState, { isCtrl }: { isCtrl: boolean }) => {
      if (isCtrl) return undefined;
      const context = activeTableContext(state);
      if (!context) return undefined;
      const moved = stepTableCaret(context.document, context.caret, motion);
      return moved
        ? placeRange(state, context, context.anchor, moved)
        : claim(state);
    };
  bus.registerState(EXTEND_SELECTION_HOME, extendEdge("cell-start"), 100);
  bus.registerState(EXTEND_SELECTION_END, extendEdge("cell-end"), 100);

  // Tab walks the cells in row-major order. At the last cell it does NOT claim
  // the key, leaving the ordinary Tab behavior in place.
  bus.registerState(
    MOVE_CONTENT_TAB,
    (state, { backward }) => {
      const context = activeTableContext(state);
      if (!context) return undefined;
      const moved = stepTableCaret(
        context.document,
        context.caret,
        backward ? "previous-cell" : "next-cell",
      );
      return moved ? placeCaret(state, context, moved) : claim(state);
    },
    100,
  );

  const vertical =
    (direction: "up" | "down") =>
    (
      state: EditorState,
      { viewport }: ViewportPayload,
    ): Claimed | undefined => {
      const context = activeTableContext(state);
      if (context) {
        const layout = tableLayoutFor(state, context.block, viewport);
        const moved = moveTableCaretVertically(
          layout,
          context.caret,
          direction,
        );
        return moved
          ? placeCaret(state, context, moved)
          : (exitTable(state, context, direction) ?? claim(state));
      }
      return enterAdjacentTable(state, direction, viewport);
    };
  bus.registerState(MOVE_CURSOR_UP, vertical("up"), 100);
  bus.registerState(MOVE_CURSOR_DOWN, vertical("down"), 100);

  // A grid has no page to turn, so PageUp/PageDown take the row move their
  // arrow twins take — and, at the top and bottom rows, leave the table the
  // same way. Without this they would be dead keys inside a cell: core's own
  // page move addresses flat block text a table does not have.
  bus.registerState(MOVE_CURSOR_PAGE_UP, vertical("up"), 100);
  bus.registerState(MOVE_CURSOR_PAGE_DOWN, vertical("down"), 100);

  // Shift+Up/Down walks the same lines and columns the unshifted key does, but
  // stops at the grid's top and bottom instead of leaving the table: the range
  // it is growing is a nested one, and there is no half-nested selection.
  const extendVertical =
    (direction: "up" | "down") =>
    (
      state: EditorState,
      { viewport }: ViewportPayload,
    ): Claimed | undefined => {
      const context = activeTableContext(state);
      if (!context) return undefined;
      const layout = tableLayoutFor(state, context.block, viewport);
      // Cell-wise for the same reason the horizontal extension is (see
      // `extendMotion`): a covered cell's wrapped lines are not stops of their
      // own, so a tall cell must not swallow a press per line.
      const moved = moveTableCaretVertically(
        layout,
        context.caret,
        direction,
        context.anchor.cellId === context.caret.cellId ? "line" : "cell",
      );
      return moved
        ? placeRange(state, context, context.anchor, moved)
        : claim(state);
    };
  bus.registerState(EXTEND_SELECTION_UP, extendVertical("up"), 100);
  bus.registerState(EXTEND_SELECTION_DOWN, extendVertical("down"), 100);
  bus.registerState(EXTEND_SELECTION_PAGE_UP, extendVertical("up"), 100);
  bus.registerState(EXTEND_SELECTION_PAGE_DOWN, extendVertical("down"), 100);

  // Double- and triple-click (and their touch twins) select the word and the
  // cell around the caret the press before them already placed. They resolve no
  // geometry of their own: the payload carries a FLAT position, which a table
  // has none of, and the caret the click just parked is the same point at cell
  // precision. A press with no word under it still claims the gesture — falling
  // through would run the flat word-select over a block with no text and wash
  // the whole table instead.
  const selectAround =
    (
      range: (
        document: StructuredDocument,
        caret: TableCaret,
      ) => TableCellRange | undefined,
    ) =>
    (state: EditorState): Claimed | undefined => {
      const context = activeTableContext(state);
      if (!context) return undefined;
      const around = range(context.document, context.caret);
      const selected = around
        ? placeRange(state, context, around.anchor, around.focus)
        : claim(state);
      // The gesture leaves the editor in `select` mode, the way a press that
      // starts a drag-selection does, so a sweep continuing from it extends the
      // range it just made.
      return (
        selected && { ...selected, state: updateMode(selected.state, "select") }
      );
    };
  bus.registerState(SELECT_WORD_AT_POINT, selectAround(cellWordRange), 100);
  bus.registerState(TAP_SELECT_WORD, selectAround(cellWordRange), 100);
  bus.registerState(SELECT_LINE_AT_POINT, selectAround(cellTextRange), 100);
  bus.registerState(TAP_SELECT_LINE, selectAround(cellTextRange), 100);

  // Select-all inside a table climbs one rung per press: the cell's own text,
  // then the table whole, then — because holding the table clears the nested
  // caret, so the third press finds no table context and falls through — core's
  // document-wide select-all. A widening ladder rather than a trapped key.
  //
  // The table rung is taken early whenever the cell rung would not widen
  // anything: a selection already spanning two cells is past it, and an empty
  // cell has nothing to show, which would make the first press look dead.
  bus.registerState(
    SELECT_ALL,
    (state) => {
      const context = activeTableContext(state);
      if (!context) return undefined;
      const cell = cellTextRange(context.document, context.caret);
      const spansCells = context.anchor.cellId !== context.caret.cellId;
      const wholeCell =
        cell !== undefined &&
        Math.min(context.anchor.offset, context.caret.offset) ===
          cell.anchor.offset &&
        Math.max(context.anchor.offset, context.caret.offset) ===
          cell.focus.offset;
      if (!cell || spansCells || wholeCell) {
        return selectTableBlock(state, context);
      }
      // A range the document cannot express takes the table rung rather than
      // falling through — an unclaimed press would skip straight to the
      // document and lose the middle of the ladder.
      return (
        placeRange(state, context, cell.anchor, cell.focus) ??
        selectTableBlock(state, context)
      );
    },
    50,
  );
}
/**
 * Whether the caret's cell reads right to left — resolved from the cell's own
 * text through the engine's direction heuristic, the same one the layout uses
 * to place its glyphs, so the LEFT key always moves toward the left edge.
 */
function cellIsRTL(context: TableContext): boolean {
  const runs = cellRuns(context.document, context.caret.cellId);
  return getTextDirection(getVisibleTextFromRuns(runs)) === "rtl";
}
