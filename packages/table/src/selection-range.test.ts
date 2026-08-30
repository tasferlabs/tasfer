/**
 * Selecting inside a table: the gestures that produce a two-ended nested range
 * — Shift+key, word and cell-wide multi-click — and what one copies as.
 *
 * The consumers of such a range (the selection band, the mark toggles, the
 * deletes) are covered where they live; these are the producers.
 */

import { registerTableActions } from "./actions";
import { serializeTableContentSelection } from "./content-selection";
import { registerTableInputActions } from "./input";
import {
  cellRuns,
  tableCaretFromContentPoint,
  tableCaretToContentSelection,
  tableCellIds,
} from "./selection";
import { getTableDocument } from "./structured";
import { tableExtension } from "./table-extension";
import { createNodeRegistry } from "@tasfer/editor";
import { createActionBus } from "@tasfer/editor/action-bus";
import { DELETE_BACKWARD } from "@tasfer/editor/actions/edit-actions";
import {
  EXTEND_SELECTION_DOWN,
  EXTEND_SELECTION_END,
  EXTEND_SELECTION_LEFT,
  EXTEND_SELECTION_RIGHT,
  EXTEND_SELECTION_UP,
  EXTEND_SELECTION_WORD_RIGHT,
  MOVE_TO_NEXT_WORD,
} from "@tasfer/editor/actions/keyboard-actions";
import {
  SELECT_LINE_AT_POINT,
  SELECT_WORD_AT_POINT,
} from "@tasfer/editor/actions/mouse-actions";
import { TAP_SELECT_WORD } from "@tasfer/editor/actions/touch-actions";
import { createChromeRegionRegistry } from "@tasfer/editor/events/chromeRegions";
import { handleEvents } from "@tasfer/editor/events/events";
import { createInteractionSession } from "@tasfer/editor/events/interaction-session";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage, type Page } from "@tasfer/editor/serlization/loadPage";
import type { EditorState, ViewportState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { resolveTheme } from "@tasfer/editor/styles";
import { getVisibleTextFromRuns } from "@tasfer/editor/sync/char-runs";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  // The chrome regions probe the document body for the iOS safe-area inset.
  const dom = (globalThis as unknown as { document: Record<string, unknown> })
    .document;
  if (!dom.body) dom.body = { appendChild: () => {}, removeChild: () => {} };
});

const schema = baseSchema.use(tableExtension());
const styles = resolveTheme({});
const MAX_WIDTH = 600;

const TABLE = [
  "| Fruit basket | Price |",
  "| --- | --- |",
  "| Green apples | 1.20 |",
  "| Pears | 2.40 |",
].join("\n");

/** Same grid, but the first body cell is long enough to wrap onto two lines. */
const WRAPPED_TABLE = [
  "| Fruit basket | Price |",
  "| --- | --- |",
  `| ${"a long cell whose text certainly wraps onto more lines ".repeat(6)}| 1.20 |`,
  "| Pears | 2.40 |",
].join("\n");

/** Same grid, but the first cell reads right to left. */
const RTL_TABLE = [
  "| فاكهة | Price |",
  "| --- | --- |",
  "| تفاح | 1.20 |",
].join("\n");

const viewport: ViewportState = {
  width: MAX_WIDTH + styles.canvas.paddingLeft + styles.canvas.paddingRight,
  height: 800,
  scrollY: 0,
} as ViewportState;

function pageOf(source: string): Page {
  return loadPage(source, schema.data);
}

function busState(source: string): EditorState {
  const state = createInitialState(pageOf(source), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
  });
  const bus = createActionBus();
  registerTableActions(bus);
  registerTableInputActions(bus);
  return { ...state, actionBus: bus };
}

function documentOf(state: EditorState) {
  return getTableDocument(state.document.page.blocks[0])!;
}

/** The cell at `index` in row-major order — the order Tab walks. */
function cellIdAt(state: EditorState, index: number): string {
  return tableCellIds(documentOf(state))[index];
}

/** Park a collapsed caret in the cell at `index`, `offset` characters in. */
function caretIn(
  state: EditorState,
  index: number,
  offset: number,
): EditorState {
  const document = documentOf(state);
  const selection = tableCaretToContentSelection(
    document,
    state.document.page.blocks[0].id,
    { cellId: cellIdAt(state, index), offset },
  );
  return updateContentSelection(state, selection!);
}

/** The live range, as (cell index, offset) pairs. */
function rangeOf(state: EditorState) {
  const selection = state.document.contentSelection;
  if (!selection) return undefined;
  const document = documentOf(state);
  const order = tableCellIds(document);
  const resolve = (point: (typeof selection)["anchor"]) => {
    const caret = tableCaretFromContentPoint(document, point);
    return caret
      ? { cell: order.indexOf(caret.cellId), offset: caret.offset }
      : undefined;
  };
  return {
    anchor: resolve(selection.anchor),
    focus: resolve(selection.focus),
  };
}

describe("extending a selection inside a cell", () => {
  it("leaves the anchor behind and moves only the focus", () => {
    let state = caretIn(busState(TABLE), 0, 0);

    state = state.actionBus.dispatchState(EXTEND_SELECTION_RIGHT, state).state;
    state = state.actionBus.dispatchState(EXTEND_SELECTION_RIGHT, state).state;

    expect(rangeOf(state)).toEqual({
      anchor: { cell: 0, offset: 0 },
      focus: { cell: 0, offset: 2 },
    });
  });

  it("shrinks again when the focus turns back", () => {
    let state = caretIn(busState(TABLE), 0, 3);
    state = state.actionBus.dispatchState(EXTEND_SELECTION_RIGHT, state).state;
    state = state.actionBus.dispatchState(EXTEND_SELECTION_LEFT, state).state;

    expect(rangeOf(state)).toEqual({
      anchor: { cell: 0, offset: 3 },
      focus: { cell: 0, offset: 3 },
    });
  });

  it("crosses into the next cell at the cell's end", () => {
    // "Fruit basket" is 12 characters; one more step leaves the cell.
    let state = caretIn(busState(TABLE), 0, "Fruit basket".length);
    state = state.actionBus.dispatchState(EXTEND_SELECTION_RIGHT, state).state;

    expect(rangeOf(state)).toEqual({
      anchor: { cell: 0, offset: 12 },
      focus: { cell: 1, offset: 0 },
    });
  });

  it("holds at the table's last stop rather than escaping the grid", () => {
    const cells = tableCellIds(documentOf(busState(TABLE)));
    let state = caretIn(busState(TABLE), cells.length - 1, "2.40".length);
    const result = state.actionBus.dispatchState(EXTEND_SELECTION_RIGHT, state);
    state = result.state;

    expect(result.claimed).toBe(true);
    expect(rangeOf(state)?.focus).toEqual({
      cell: cells.length - 1,
      offset: 4,
    });
  });

  it("selects to the cell's own end on Shift+End", () => {
    let state = caretIn(busState(TABLE), 0, 6);
    state = state.actionBus.dispatchState(EXTEND_SELECTION_END, state, {
      isCtrl: false,
    }).state;

    expect(rangeOf(state)).toEqual({
      anchor: { cell: 0, offset: 6 },
      focus: { cell: 0, offset: 12 },
    });
  });

  it("leaves Ctrl+Shift+End to the document-wide handler", () => {
    const state = caretIn(busState(TABLE), 0, 6);
    const result = state.actionBus.dispatchState(EXTEND_SELECTION_END, state, {
      isCtrl: true,
    });

    expect(result.claimed).toBe(false);
  });

  it("takes a whole word on Shift+Alt+Right", () => {
    let state = caretIn(busState(TABLE), 0, 0);
    state = state.actionBus.dispatchState(
      EXTEND_SELECTION_WORD_RIGHT,
      state,
    ).state;

    expect(rangeOf(state)).toEqual({
      anchor: { cell: 0, offset: 0 },
      focus: { cell: 0, offset: "Fruit".length },
    });
  });

  it("moves the caret a word at a time without Shift", () => {
    let state = caretIn(busState(TABLE), 0, 0);
    state = state.actionBus.dispatchState(MOVE_TO_NEXT_WORD, state).state;

    expect(rangeOf(state)).toEqual({
      anchor: { cell: 0, offset: 5 },
      focus: { cell: 0, offset: 5 },
    });
  });

  it("extends toward the left edge in a right-to-left cell", () => {
    // LEFT is a visual key: in an RTL cell it walks the text forward.
    let state = caretIn(busState(RTL_TABLE), 0, 0);
    state = state.actionBus.dispatchState(EXTEND_SELECTION_LEFT, state).state;

    expect(rangeOf(state)).toEqual({
      anchor: { cell: 0, offset: 0 },
      focus: { cell: 0, offset: 1 },
    });
  });

  it("extends into the row below, and stops at the last row", () => {
    let state = caretIn(busState(TABLE), 0, 2);
    state = state.actionBus.dispatchState(EXTEND_SELECTION_DOWN, state, {
      viewport,
    }).state;
    expect(rangeOf(state)?.anchor).toEqual({ cell: 0, offset: 2 });
    expect(rangeOf(state)?.focus?.cell).toBe(2);

    // Two more rows down is past the grid: the key is claimed and the range
    // stays where the last row left it.
    state = state.actionBus.dispatchState(EXTEND_SELECTION_DOWN, state, {
      viewport,
    }).state;
    const last = rangeOf(state);
    const result = state.actionBus.dispatchState(EXTEND_SELECTION_DOWN, state, {
      viewport,
    });

    expect(result.claimed).toBe(true);
    expect(rangeOf(result.state)).toEqual(last);
  });

  it("does not claim a Shift+key outside a table", () => {
    const state = busState(TABLE);
    const result = state.actionBus.dispatchState(EXTEND_SELECTION_UP, state, {
      viewport,
    });

    expect(result.claimed).toBe(false);
  });

  it("deletes exactly the range the keyboard selected", () => {
    let state = caretIn(busState(TABLE), 0, 0);
    for (let at = 0; at < 5; at++) {
      state = state.actionBus.dispatchState(
        EXTEND_SELECTION_RIGHT,
        state,
      ).state;
    }
    state = state.actionBus.dispatchState(DELETE_BACKWARD, state).state;

    expect(
      getVisibleTextFromRuns(cellRuns(documentOf(state), cellIdAt(state, 0))),
    ).toBe(" basket");
  });
});

describe("extending a selection that already spans cells", () => {
  // The covered cells ARE the selection once the range leaves its first cell —
  // the band paints them whole, copy and delete take them whole — so the step
  // that grows it has to be a cell too. Stepping by character through a cell
  // that is already wholly selected is a press that changes nothing, and a wide
  // cell eats one per character.
  function crossed(source = TABLE): EditorState {
    // "Fruit basket" is 12 characters: the seventh step from offset 6 is the
    // one that leaves the cell.
    let state = caretIn(busState(source), 0, 6);
    for (let at = 0; at < 7; at++) {
      state = state.actionBus.dispatchState(
        EXTEND_SELECTION_RIGHT,
        state,
      ).state;
    }
    return state;
  }

  it("grows by a whole cell rather than a character", () => {
    let state = crossed();
    expect(rangeOf(state)?.focus).toEqual({ cell: 1, offset: 0 });

    state = state.actionBus.dispatchState(EXTEND_SELECTION_RIGHT, state).state;

    expect(rangeOf(state)).toEqual({
      anchor: { cell: 0, offset: 6 },
      focus: { cell: 2, offset: 0 },
    });
  });

  it("shrinks back into the cell the range crossed out of", () => {
    let state = crossed();
    state = state.actionBus.dispatchState(EXTEND_SELECTION_RIGHT, state).state;
    state = state.actionBus.dispatchState(EXTEND_SELECTION_LEFT, state).state;

    // A cell back is the previous cell's END, so turning round exactly undoes
    // the step that crossed — and one more lands in the anchor's own cell,
    // where the range is a character range again.
    expect(rangeOf(state)?.focus).toEqual({ cell: 1, offset: "Price".length });

    state = state.actionBus.dispatchState(EXTEND_SELECTION_LEFT, state).state;

    expect(rangeOf(state)).toEqual({
      anchor: { cell: 0, offset: 6 },
      focus: { cell: 0, offset: "Fruit basket".length },
    });
  });

  it("takes a whole cell on Shift+Alt+Right too", () => {
    let state = crossed();
    state = state.actionBus.dispatchState(
      EXTEND_SELECTION_WORD_RIGHT,
      state,
    ).state;

    expect(rangeOf(state)?.focus).toEqual({ cell: 2, offset: 0 });
  });

  it("still walks a wrapped cell line by line while the range is inside it", () => {
    let state = caretIn(busState(WRAPPED_TABLE), 2, 0);
    state = state.actionBus.dispatchState(EXTEND_SELECTION_DOWN, state, {
      viewport,
    }).state;

    const range = rangeOf(state);
    expect(range?.focus?.cell).toBe(2);
    expect(range?.focus?.offset).toBeGreaterThan(0);
  });

  it("leaves a wrapped cell for the row below once the range spans cells", () => {
    let state = caretIn(busState(WRAPPED_TABLE), 0, 0);
    state = state.actionBus.dispatchState(EXTEND_SELECTION_DOWN, state, {
      viewport,
    }).state;
    expect(rangeOf(state)?.focus?.cell).toBe(2);

    // That cell wraps (the test above walks its lines), but every line of it is
    // already covered, so the next press belongs to the row below.
    state = state.actionBus.dispatchState(EXTEND_SELECTION_DOWN, state, {
      viewport,
    }).state;

    expect(rangeOf(state)?.focus?.cell).toBe(4);
  });
});

describe("multi-click selection in a cell", () => {
  it("takes the word around the caret the click placed", () => {
    let state = caretIn(busState(TABLE), 0, 8); // inside "basket"
    state = state.actionBus.dispatchState(SELECT_WORD_AT_POINT, state, {
      position: { blockIndex: 0, textIndex: 0 },
    }).state;

    expect(rangeOf(state)).toEqual({
      anchor: { cell: 0, offset: 6 },
      focus: { cell: 0, offset: 12 },
    });
  });

  it("takes the word that ended when the caret sits after it", () => {
    let state = caretIn(busState(TABLE), 0, 5); // just after "Fruit"
    state = state.actionBus.dispatchState(TAP_SELECT_WORD, state, {
      position: { blockIndex: 0, textIndex: 0 },
    }).state;

    expect(rangeOf(state)).toEqual({
      anchor: { cell: 0, offset: 0 },
      focus: { cell: 0, offset: 5 },
    });
  });

  it("takes the whole cell on a triple click", () => {
    let state = caretIn(busState(TABLE), 4, 2);
    state = state.actionBus.dispatchState(SELECT_LINE_AT_POINT, state, {
      position: { blockIndex: 0, textIndex: 0 },
    }).state;

    expect(rangeOf(state)).toEqual({
      anchor: { cell: 4, offset: 0 },
      focus: { cell: 4, offset: "Pears".length },
    });
  });

  it("claims the gesture even where there is no word, leaving the table alone", () => {
    // Otherwise the flat word-select runs over a block with no text at all and
    // ends up holding the whole table.
    let state = caretIn(busState(TABLE), 3, 0); // "1.20" starts on a digit
    const result = state.actionBus.dispatchState(SELECT_LINE_AT_POINT, state, {
      position: { blockIndex: 0, textIndex: 0 },
    });

    expect(result.claimed).toBe(true);
    expect(result.state.document.selection).toBeNull();
  });
});

describe("shift-click inside a cell", () => {
  function mouse(type: string, x: number, y: number, shiftKey = false) {
    return {
      type,
      x,
      y,
      button: 0,
      shiftKey,
      ctrlKey: false,
      metaKey: false,
      preventDefault: () => {},
      stopPropagation: () => {},
    };
  }

  const pointerViewport: ViewportState = {
    width: 800,
    height: 1000,
    scrollY: 0,
    documentHeight: 2000,
  } as ViewportState;

  function press(
    state: EditorState,
    session: ReturnType<typeof createInteractionSession>,
    x: number,
    shift = false,
  ): EditorState {
    const y = styles.canvas.paddingTop + 12;
    return handleEvents(
      state,
      pointerViewport,
      { start: 0, end: 1, startY: styles.canvas.paddingTop },
      [mouse("mousedown", x, y, shift), mouse("mouseup", x, y, shift)] as never,
      pointerViewport.documentHeight,
      { left: 0, top: 0 },
      session,
    ).state;
  }

  function focused(): EditorState {
    const state = busState(TABLE);
    return { ...state, view: { ...state.view, isFocused: true } };
  }

  it("extends the range rather than taking the word under the press", () => {
    // A press within 5px of the last one continues its click run — less than
    // one glyph, so this is where "extend by a character" lands. Shift must
    // still mean extend there, not double-click.
    const session = createInteractionSession(createChromeRegionRegistry());
    const x = styles.canvas.paddingLeft + 40;
    let state = press(focused(), session, x);
    const anchor = rangeOf(state)?.anchor;
    expect(anchor?.cell).toBe(0);

    state = press(state, session, x + 3, true);

    expect(rangeOf(state)?.anchor).toEqual(anchor);
    expect(state.document.contentSelection?.initialBoundary).toBeUndefined();
  });

  it("carries the focus to where the press landed further along the cell", () => {
    const session = createInteractionSession(createChromeRegionRegistry());
    const x = styles.canvas.paddingLeft + 20;
    let state = press(focused(), session, x);
    const anchor = rangeOf(state)?.anchor;

    state = press(state, session, x + 60, true);

    const range = rangeOf(state);
    expect(range?.anchor).toEqual(anchor);
    expect(range?.focus?.offset).toBeGreaterThan(anchor?.offset ?? 0);
  });
});

describe("what a table selection copies as", () => {
  function sliceOf(state: EditorState) {
    return serializeTableContentSelection({
      document: documentOf(state),
      selection: state.document.contentSelection!,
    });
  }

  it("copies just the characters selected inside one cell", () => {
    let state = caretIn(busState(TABLE), 0, 6);
    state = state.actionBus.dispatchState(EXTEND_SELECTION_END, state, {
      isCtrl: false,
    }).state;

    expect(sliceOf(state)?.plainText).toBe("basket");
  });

  it("copies covered cells whole, as a grid a spreadsheet can read", () => {
    // Row-major from the second header cell into the first body row.
    let state = caretIn(busState(TABLE), 1, 0);
    state = state.actionBus.dispatchState(EXTEND_SELECTION_DOWN, state, {
      viewport,
    }).state;

    expect(sliceOf(state)?.plainText).toBe("Price\nGreen apples\t1.20");
  });

  it("copies nothing for a collapsed caret", () => {
    const state = caretIn(busState(TABLE), 0, 3);

    expect(sliceOf(state)).toBeUndefined();
  });
});
