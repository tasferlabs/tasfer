/**
 * The on-canvas table: its geometry seams (hit-test ⇄ caret rect), what it
 * paints, and the caret motions that make it reachable and escapable from the
 * keyboard.
 */

import { registerTableActions } from "./actions";
import { registerTableCommands } from "./commands";
import type { TableLayout } from "./geometry";
import {
  cellCaretHeight,
  tableCaretFromContentPoint,
  tableCellIds,
  tableRangeToContentSelection,
} from "./selection";
import { cellText, getTableDocument, readTable } from "./structured";
import { tableExtension } from "./table-extension";
import { type TableBlock, TableNode } from "./TableNode";
import { createNodeRegistry } from "@tasfer/editor";
import { createActionBus } from "@tasfer/editor/action-bus";
import { SELECT_ALL } from "@tasfer/editor/actions/edit-actions";
import {
  MOVE_CONTENT_TAB,
  MOVE_CURSOR_DOWN,
  MOVE_CURSOR_LEFT,
  MOVE_CURSOR_RIGHT,
  MOVE_CURSOR_UP,
  MOVE_TO_LINE_END,
} from "@tasfer/editor/actions/keyboard-actions";
import { createChromeRegionRegistry } from "@tasfer/editor/events/chromeRegions";
import { createInteractionSession } from "@tasfer/editor/events/interaction-session";
import { handleKeyDown } from "@tasfer/editor/events/keysEvents";
import { handleMouseMove } from "@tasfer/editor/events/mouseEvents";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage, type Page } from "@tasfer/editor/serlization/loadPage";
import type { EditorState, ViewportState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { resolveTheme } from "@tasfer/editor/styles";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(tableExtension());
const styles = resolveTheme({});
const node = new TableNode();
const MAX_WIDTH = 600;

const TABLE = [
  "| Fruit | Price |",
  "| --- | --- |",
  "| Apples | 1.20 |",
  "| Pears | 2.40 |",
].join("\n");

/** Same shape, but one cell long enough that it has to wrap onto more lines. */
const WRAPPING_TABLE = [
  "| Fruit | Notes |",
  "| --- | --- |",
  "| Apples | a rather long tasting note that runs on well past the width one column can give it |",
  "| Pears | 2.40 |",
].join("\n");

function pageOf(source: string): Page {
  return loadPage(source, schema.data);
}

/** The persisted `Block` union has no table member; the node narrows it. */
function tableBlock(state: EditorState, blockIndex: number): TableBlock {
  return state.document.page.blocks[blockIndex] as unknown as TableBlock;
}

function stateOf(source: string): EditorState {
  return createInitialState(pageOf(source), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
  });
}

const viewport: ViewportState = {
  width: MAX_WIDTH + styles.canvas.paddingLeft + styles.canvas.paddingRight,
  height: 800,
  scrollY: 0,
} as ViewportState;

function layoutOf(state: EditorState, blockIndex = 0): TableLayout {
  return node.layout({
    block: state.document.page.blocks[blockIndex],
    blockIndex,
    maxWidth: MAX_WIDTH,
    isFirst: blockIndex === 0,
    styles,
    marks: state.marks,
  });
}

/** Put the nested caret in the cell holding `text`, at `offset`. */
function caretIn(
  state: EditorState,
  blockIndex: number,
  cellIndex: number,
  offset: number,
): EditorState {
  const block = state.document.page.blocks[blockIndex];
  const document = getTableDocument(block)!;
  const cells = Object.values(document.nodes).filter(
    (candidate) => candidate.type === "cell",
  );
  const layout = layoutOf(state, blockIndex);
  const ordered = layout.cells
    .map((cell) => cells.find((candidate) => candidate.id === cell.cellId))
    .filter((cell) => cell !== undefined);
  const cell = ordered[cellIndex];
  const runs = [...cell.textFields.text];
  let seen = 0;
  let afterCharId: string | null = null;
  outer: for (const run of runs) {
    for (let at = 0; at < run.text.length; at++) {
      seen++;
      afterCharId = `${run.peerId}:${run.startCounter + at}`;
      if (seen === offset) break outer;
    }
  }
  return updateContentSelection(state, {
    anchor: {
      kind: "text",
      blockId: block.id,
      contentId: document.rootId,
      nodeId: cell.id,
      field: "text",
      afterCharId: offset === 0 ? null : afterCharId,
      affinity: "forward",
    },
    focus: {
      kind: "text",
      blockId: block.id,
      contentId: document.rootId,
      nodeId: cell.id,
      field: "text",
      afterCharId: offset === 0 ? null : afterCharId,
      affinity: "forward",
    },
  });
}

/** The caret's (cellId, offset), read back off the state. */
function caretOf(state: EditorState, blockIndex = 0) {
  const focus = state.document.contentSelection?.focus;
  if (!focus) return undefined;
  const document = getTableDocument(state.document.page.blocks[blockIndex]);
  return document ? tableCaretFromContentPoint(document, focus) : undefined;
}

/** The visible text of the cell the caret is in. */
function caretCellText(state: EditorState, blockIndex = 0): string | undefined {
  const caret = caretOf(state, blockIndex);
  const document = getTableDocument(state.document.page.blocks[blockIndex]);
  if (!caret || !document) return undefined;
  return document.nodes[caret.cellId].textFields.text
    .map((run) => run.text)
    .join("");
}

describe("TableNode layout", () => {
  it("reuses the memoized layout at an unchanged width", () => {
    const state = stateOf(TABLE);
    const first = layoutOf(state);

    expect(layoutOf(state)).toBe(first);
  });

  it("lays a parsed table out as a full grid", () => {
    const layout = layoutOf(stateOf(TABLE));

    expect(layout.columns).toHaveLength(2);
    expect(layout.rows).toHaveLength(3);
    expect(layout.cells).toHaveLength(6);
    expect(layout.cells.every((cell) => cell.cellId !== null)).toBe(true);
    expect(layout.height).toBeGreaterThan(0);
  });

  it("estimates a height without wrapping every cell", () => {
    const state = stateOf(TABLE);
    const estimate = node.estimateHeight({
      block: state.document.page.blocks[0],
      blockIndex: 0,
      maxWidth: MAX_WIDTH,
      isFirst: true,
      styles,
      marks: state.marks,
    });

    expect(estimate).toBeGreaterThan(0);
    // Every cell here is one line, so the cheap estimate is the real height.
    expect(estimate).toBe(layoutOf(state).height);
  });

  it("estimates the extra rows a wrapping cell adds", () => {
    // The height index seeds every off-screen block with the estimate, so a
    // table whose cells wrap must not claim a one-line-per-row height — the
    // document below it would sit too high until the row was measured.
    const state = stateOf(WRAPPING_TABLE);
    const estimate = node.estimateHeight({
      block: state.document.page.blocks[0],
      blockIndex: 0,
      maxWidth: MAX_WIDTH,
      isFirst: true,
      styles,
      marks: state.marks,
    });
    const real = layoutOf(state).height;
    const oneLinePerRow = node.estimateHeight({
      block: stateOf(TABLE).document.page.blocks[0],
      blockIndex: 0,
      maxWidth: MAX_WIDTH,
      isFirst: true,
      styles,
      marks: state.marks,
    });

    // Taller than the same-shaped table whose cells all fit on one line …
    expect(estimate).toBeGreaterThan(oneLinePerRow);
    // … and within a row's height of what the table actually draws.
    expect(Math.abs(estimate - real)).toBeLessThan(
      styles.blocks.table.fontSize * styles.blocks.table.lineHeight +
        styles.blocks.table.cellPaddingY * 2,
    );
  });
});

describe("TableNode caret geometry", () => {
  const state = stateOf(TABLE);
  const layout = layoutOf(state);
  const block = tableBlock(state, 0);

  it("resolves a point to the cell under it", () => {
    const target = layout.cells[3]; // second row, second column
    const selection = node.contentSelectionFromPoint(
      layout,
      { x: target.x + target.width / 2, y: target.y + target.height / 2 },
      {
        state,
        block,
        blockIndex: 0,
        maxWidth: MAX_WIDTH,
        isFirst: true,
        styles,
        marks: state.marks,
      },
      { pointerType: "mouse" },
    );

    expect(selection?.focus.kind).toBe("text");
    expect(
      selection && "nodeId" in selection.focus ? selection.focus.nodeId : null,
    ).toBe(target.cellId);
  });

  it("clamps a point below the grid into the last row", () => {
    const selection = node.contentSelectionFromPoint(
      layout,
      { x: 10, y: layout.height + 500 },
      {
        state,
        block,
        blockIndex: 0,
        maxWidth: MAX_WIDTH,
        isFirst: true,
        styles,
        marks: state.marks,
      },
      { pointerType: "mouse" },
    );
    const caret = tableCaretFromContentPoint(
      getTableDocument(block)!,
      selection!.focus,
    );

    expect(caret?.cellId).toBe(layout.rows[2].cells[0].cellId);
  });

  it("round-trips a point through the caret rect it produces", () => {
    const target = layout.cells[2];
    const hitCtx = {
      state,
      block,
      blockIndex: 0,
      maxWidth: MAX_WIDTH,
      isFirst: true,
      styles,
      marks: state.marks,
    };
    const point = {
      x: target.lines[0].x + target.lines[0].width,
      y: target.y + target.height / 2,
    };
    const selection = node.contentSelectionFromPoint(layout, point, hitCtx, {
      pointerType: "mouse",
    })!;
    const rect = node.contentCaretRect(layout, selection.focus, {
      ...hitCtx,
      origin: { x: 0, y: 0 },
    });

    expect(rect).not.toBeNull();
    // The caret lands on the end of the text, within a pixel of where the hit
    // was taken.
    expect(Math.abs(rect!.x - point.x)).toBeLessThanOrEqual(1);
    expect(rect!.y).toBe(target.lines[0].y);
    // Text height at the line top, the way a paragraph caret is measured — not
    // the line box, which also carries the row's leading and would draw a cell
    // caret noticeably taller than the caret in the prose beside it.
    expect(rect!.height).toBe(cellCaretHeight(layout));
    expect(rect!.height).toBeLessThan(target.lines[0].height);
  });

  it("offers no caret rect for a point that is not a cell", () => {
    const rect = node.contentCaretRect(
      layout,
      {
        kind: "gap",
        blockId: block.id,
        contentId: getTableDocument(block)!.rootId,
        parentId: "nope",
        slot: "rows",
        afterNodeId: null,
        affinity: "forward",
      },
      {
        state,
        block,
        blockIndex: 0,
        maxWidth: MAX_WIDTH,
        isFirst: true,
        styles,
        marks: state.marks,
        origin: { x: 0, y: 0 },
      },
    );

    expect(rect).toBeNull();
  });
});

describe("TableNode paint", () => {
  it("draws the grid and reports block-absolute line boxes", () => {
    const state = stateOf(TABLE);
    const layout = layoutOf(state);
    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_target, key: string) => {
          if (key === "canvas") return {};
          return (...args: unknown[]) => {
            calls.push(key);
            return args;
          };
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;

    const rendered = node.paint(layout, {
      block: state.document.page.blocks[0],
      blockIndex: 0,
      maxWidth: MAX_WIDTH,
      isFirst: true,
      styles,
      marks: state.marks,
      ctx,
      state,
      origin: { x: 40, y: 100 },
      requestRedraw: () => {},
    });

    expect(calls).toContain("roundRect");
    expect(calls).toContain("stroke");
    expect(calls).toContain("fillText");
    expect(rendered.bounds.height).toBe(layout.height);
    expect(rendered.lines[0].x).toBe(40 + layout.lines[0].x);
    expect(rendered.lines[0].y).toBe(100 + layout.lines[0].y);
  });

  it("clips a cell whose text is wider than the cell itself", () => {
    // Four columns in a viewport too narrow to give even one minimum width: the
    // columns share what there is, and a glyph no longer fits inside a cell's
    // padding. Without a clip those glyphs paint straight across the hairline
    // into the neighbouring cell.
    const state = stateOf(
      [
        "| a | b | c | d |",
        "| --- | --- | --- | --- |",
        "| supercalifragilistic | wordy | more | https://example.com/x/y |",
      ].join("\n"),
    );
    const narrow = 60;
    const layout = node.layout({
      block: state.document.page.blocks[0],
      blockIndex: 0,
      maxWidth: narrow,
      isFirst: true,
      styles,
      marks: state.marks,
    });
    // The scenario is only meaningful if the squeeze really did overflow a cell.
    expect(
      layout.cells.some((cell) =>
        cell.lines.some((line) => line.width > cell.textWidth),
      ),
    ).toBe(true);

    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_target, key: string) => {
          if (key === "canvas") return {};
          return (...args: unknown[]) => {
            calls.push(key);
            return args;
          };
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;

    node.paint(layout, {
      block: state.document.page.blocks[0],
      blockIndex: 0,
      maxWidth: narrow,
      isFirst: true,
      styles,
      marks: state.marks,
      ctx,
      state,
      origin: { x: 0, y: 0 },
      requestRedraw: () => {},
    });

    // One clip for the grid's rounded outline, plus one per overflowing cell.
    expect(calls.filter((call) => call === "clip").length).toBeGreaterThan(1);
    expect(calls.filter((call) => call === "save").length).toBe(
      calls.filter((call) => call === "restore").length,
    );
  });

  it("takes no per-cell clip when every cell fits", () => {
    const state = stateOf(TABLE);
    const layout = layoutOf(state);
    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_target, key: string) => {
          if (key === "canvas") return {};
          return (...args: unknown[]) => {
            calls.push(key);
            return args;
          };
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;

    node.paint(layout, {
      block: state.document.page.blocks[0],
      blockIndex: 0,
      maxWidth: MAX_WIDTH,
      isFirst: true,
      styles,
      marks: state.marks,
      ctx,
      state,
      origin: { x: 0, y: 0 },
      requestRedraw: () => {},
    });

    // Only the grid outline's clip — an ordinary table pays nothing per cell.
    expect(calls.filter((call) => call === "clip").length).toBe(1);
  });
});

describe("table caret navigation", () => {
  function busState(source: string): EditorState {
    const state = stateOf(source);
    const bus = createActionBus();
    registerTableActions(bus);
    return { ...state, actionBus: bus };
  }

  it("walks the cells in row-major order on Tab", () => {
    let state = caretIn(busState(TABLE), 0, 0, 0);

    state = state.actionBus.dispatchState(MOVE_CONTENT_TAB, state, {
      backward: false,
    }).state;
    expect(caretCellText(state)).toBe("Price");

    state = state.actionBus.dispatchState(MOVE_CONTENT_TAB, state, {
      backward: false,
    }).state;
    expect(caretCellText(state)).toBe("Apples");
  });

  it("walks back on Shift+Tab and stops at the first cell", () => {
    let state = caretIn(busState(TABLE), 0, 1, 0);

    state = state.actionBus.dispatchState(MOVE_CONTENT_TAB, state, {
      backward: true,
    }).state;
    expect(caretCellText(state)).toBe("Fruit");

    // Nowhere further back: the caret holds rather than escaping the table.
    state = state.actionBus.dispatchState(MOVE_CONTENT_TAB, state, {
      backward: true,
    }).state;
    expect(caretCellText(state)).toBe("Fruit");
  });

  it("crosses into the next cell when the right arrow leaves one", () => {
    let state = caretIn(busState(TABLE), 0, 0, 5); // end of "Fruit"

    state = state.actionBus.dispatchState(MOVE_CURSOR_RIGHT, state).state;
    expect(caretCellText(state)).toBe("Price");
    expect(caretOf(state)?.offset).toBe(0);
  });

  it("steps character by character inside a cell", () => {
    let state = caretIn(busState(TABLE), 0, 0, 0);

    state = state.actionBus.dispatchState(MOVE_CURSOR_RIGHT, state).state;
    expect(caretOf(state)?.offset).toBe(1);
    expect(caretCellText(state)).toBe("Fruit");

    state = state.actionBus.dispatchState(MOVE_CURSOR_LEFT, state).state;
    expect(caretOf(state)?.offset).toBe(0);
  });

  it("jumps to the end of the cell on End", () => {
    let state = caretIn(busState(TABLE), 0, 2, 0);

    state = state.actionBus.dispatchState(MOVE_TO_LINE_END, state).state;
    expect(caretOf(state)?.offset).toBe("Apples".length);
  });

  it("moves down the column, keeping the horizontal position", () => {
    let state = caretIn(busState(TABLE), 0, 0, 0);

    state = state.actionBus.dispatchState(MOVE_CURSOR_DOWN, state, {
      viewport,
    }).state;
    expect(caretCellText(state)).toBe("Apples");

    state = state.actionBus.dispatchState(MOVE_CURSOR_UP, state, {
      viewport,
    }).state;
    expect(caretCellText(state)).toBe("Fruit");
  });

  it("enters a table the arrow key would otherwise skip", () => {
    let state = busState(`before\n\n${TABLE}`);
    const tableIndex = state.document.page.blocks.findIndex(
      (block) => (block.type as string) === "table",
    );
    state = {
      ...state,
      document: {
        ...state.document,
        cursor: {
          position: { blockIndex: tableIndex - 1, textIndex: 0 },
          lastUpdate: 0,
        },
      },
    };

    state = state.actionBus.dispatchState(MOVE_CURSOR_DOWN, state, {
      viewport,
    }).state;

    expect(state.document.contentSelection).not.toBeNull();
    expect(caretCellText(state, tableIndex)).toBe("Fruit");
  });

  it("leaves the table downward from its last row", () => {
    let state = busState(`${TABLE}\n\nafter`);
    state = caretIn(state, 0, 4, 0); // "Pears", the last row

    state = state.actionBus.dispatchState(MOVE_CURSOR_DOWN, state, {
      viewport,
    }).state;

    expect(state.document.contentSelection).toBeNull();
    expect(state.document.cursor?.position.blockIndex).toBe(1);
    expect(state.document.page.blocks[1].type as string).not.toBe("table");
  });

  it("does not claim a motion when the caret is outside every table", () => {
    const state = busState(TABLE);
    const result = state.actionBus.dispatchState(MOVE_CONTENT_TAB, state, {
      backward: false,
    });

    expect(result.state).toBe(state);
  });
});

/** A canvas context that records every call made on it, for paint assertions. */
function recordingCtx() {
  const calls: { name: string; args: unknown[] }[] = [];
  const ctx = new Proxy(
    {},
    {
      get: (_target, key: string) => {
        if (key === "canvas") return {};
        return (...args: unknown[]) => {
          calls.push({ name: key, args });
          return args;
        };
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

/** How many strokes painting the table takes — one more once an edge is lit. */
function strokesFor(state: EditorState): number {
  const { ctx, calls } = recordingCtx();
  node.paint(layoutOf(state), {
    block: state.document.page.blocks[0],
    blockIndex: 0,
    maxWidth: MAX_WIDTH,
    isFirst: true,
    styles,
    marks: state.marks,
    ctx,
    state,
    origin: { x: 0, y: 0 },
    requestRedraw: () => {},
  });
  return calls.filter((call) => call.name === "stroke").length;
}

/** The lines painting the table reports, at their painted x. */
function paintLines(state: EditorState) {
  const { ctx } = recordingCtx();
  return node.paint(layoutOf(state), {
    block: state.document.page.blocks[0],
    blockIndex: 0,
    maxWidth: MAX_WIDTH,
    isFirst: true,
    styles,
    marks: state.marks,
    ctx,
    state,
    origin: { x: 0, y: 0 },
    requestRedraw: () => {},
  }).lines;
}

/** The region context a pointer event would build for the table block. */
function regionCtx(state: EditorState) {
  return {
    block: state.document.page.blocks[0],
    blockIndex: 0,
    maxWidth: MAX_WIDTH,
    isFirst: true,
    styles,
    marks: state.marks,
    state,
    viewport,
    origin: { x: styles.canvas.paddingLeft, y: 0 },
  };
}

/** A minimal interaction session: only `captured` is read by a drag. */
function session(hit: unknown) {
  return { captured: { region: { id: "table-column-resize" }, hit } };
}

function resizeRegion(state: EditorState) {
  const regions = node.regions?.(regionCtx(state) as never) ?? [];
  // A table declares the outer-edge "add" strips alongside these, so pick the
  // resize bands out by their registered id rather than by position.
  const region = regions.find((r) => r.id === "table-column-resize");
  expect(region).toBeDefined();
  return region!;
}

describe("column resize", () => {
  it("offers a grab band on every interior edge, and none on the outer ones", () => {
    const state = stateOf(TABLE);
    const layout = layoutOf(state);
    const region = resizeRegion(state);
    const y = layout.gridTop + 4;
    const edge = styles.canvas.paddingLeft + layout.columns[1].x;

    expect(region.hitTest({ x: edge, y }, "mouse")).toMatchObject({ index: 1 });
    // The grid is exactly as wide as the page, so its outer edges have nowhere
    // to be dragged to.
    expect(
      region.hitTest({ x: styles.canvas.paddingLeft, y }, "mouse"),
    ).toBeNull();
    expect(
      region.hitTest(
        { x: styles.canvas.paddingLeft + layout.gridWidth, y },
        "mouse",
      ),
    ).toBeNull();
  });

  it("ignores a point above or below the grid", () => {
    const state = stateOf(TABLE);
    const layout = layoutOf(state);
    const region = resizeRegion(state);
    const edge = styles.canvas.paddingLeft + layout.columns[1].x;

    expect(region.hitTest({ x: edge, y: -20 }, "mouse")).toBeNull();
    expect(
      region.hitTest({ x: edge, y: layout.height + 40 }, "mouse"),
    ).toBeNull();
  });

  it("moves width from one column to the other and emits nothing until release", () => {
    const state = stateOf(TABLE);
    const layout = layoutOf(state);
    const region = resizeRegion(state);
    const y = layout.gridTop + 4;
    const edge = styles.canvas.paddingLeft + layout.columns[1].x;
    const hit = region.hitTest({ x: edge, y }, "mouse")!;

    const ctx = { state, session: session(hit) } as never;
    expect(region.drag!.onStart(hit, { x: edge, y }, ctx)).not.toBeNull();

    const moved = region.drag!.onMove({ x: edge + 60, y }, {
      state,
      session: session(hit),
    } as never)!;
    // A live drag repaints; it must not write an operation per frame.
    expect(moved.ops ?? []).toHaveLength(0);

    const after = layoutOf(moved.state);
    expect(after.columns[0].width).toBe(layout.columns[0].width + 60);
    expect(after.columns[1].width).toBe(layout.columns[1].width - 60);
    // Everything the drag did not touch stays exactly where it was.
    expect(after.gridWidth).toBe(layout.gridWidth);
  });

  it("commits the released width as operations a peer can replay", () => {
    const state = stateOf(TABLE);
    const layout = layoutOf(state);
    const region = resizeRegion(state);
    const y = layout.gridTop + 4;
    const edge = styles.canvas.paddingLeft + layout.columns[1].x;
    const hit = region.hitTest({ x: edge, y }, "mouse")!;
    region.drag!.onStart(hit, { x: edge, y }, {
      state,
      session: session(hit),
    } as never);

    const released = region.drag!.onEnd({ x: edge + 40, y }, {
      state,
      session: session(hit),
    } as never)!;

    expect(released.ops?.length).toBeGreaterThan(0);
    expect(released.ops?.every((op) => op.op === "content_edit")).toBe(true);
    expect(layoutOf(released.state).columns[0].width).toBe(
      layout.columns[0].width + 40,
    );
  });

  it("stops at the minimum column width instead of collapsing a column", () => {
    const state = stateOf(TABLE);
    const layout = layoutOf(state);
    const region = resizeRegion(state);
    const y = layout.gridTop + 4;
    const edge = styles.canvas.paddingLeft + layout.columns[1].x;
    const hit = region.hitTest({ x: edge, y }, "mouse")!;
    region.drag!.onStart(hit, { x: edge, y }, {
      state,
      session: session(hit),
    } as never);

    const moved = region.drag!.onMove({ x: edge + 10_000, y }, {
      state,
      session: session(hit),
    } as never)!;

    const after = layoutOf(moved.state);
    expect(after.columns[1].width).toBeGreaterThanOrEqual(
      styles.blocks.table.minColumnWidth,
    );
  });

  it("puts the columns back where they were when the drag is cancelled", () => {
    const state = stateOf(TABLE);
    const layout = layoutOf(state);
    const region = resizeRegion(state);
    const y = layout.gridTop + 4;
    const edge = styles.canvas.paddingLeft + layout.columns[1].x;
    const hit = region.hitTest({ x: edge, y }, "mouse")!;
    region.drag!.onStart(hit, { x: edge, y }, {
      state,
      session: session(hit),
    } as never);
    const moved = region.drag!.onMove({ x: edge + 50, y }, {
      state,
      session: session(hit),
    } as never)!;

    const cancelled = region.drag!.onCancel({
      state: moved.state,
      session: session(hit),
    } as never);

    expect(layoutOf(cancelled).columns[0].width).toBe(layout.columns[0].width);
    expect(layoutOf(cancelled).columns[1].width).toBe(layout.columns[1].width);
  });

  it("keeps the edge under the pointer past the widest word in the column", () => {
    // The column's fitted floor is its widest word — the width it needs to show
    // its own text. That floor sizes a column nobody touched; it must not stop a
    // column somebody is dragging, or the edge parts company with the pointer
    // while the drag is still going.
    const state = stateOf(WRAPPING_TABLE);
    const layout = layoutOf(state);
    const region = resizeRegion(state);
    const y = layout.gridTop + 4;
    const edge = styles.canvas.paddingLeft + layout.columns[1].x;
    const hit = region.hitTest({ x: edge, y }, "mouse")!;
    region.drag!.onStart(hit, { x: edge, y }, {
      state,
      session: session(hit),
    } as never);

    const shrink = layout.columns[0].width - styles.blocks.table.minColumnWidth;
    const moved = region.drag!.onMove({ x: edge - shrink, y }, {
      state,
      session: session(hit),
    } as never)!;

    const after = layoutOf(moved.state);
    expect(after.columns[0].width).toBe(styles.blocks.table.minColumnWidth);
    expect(after.columns[1].width).toBe(layout.columns[1].width + shrink);
    // Past the hard floor the edge stops — but only there.
    const further = region.drag!.onMove({ x: edge - shrink - 200, y }, {
      state,
      session: session(hit),
    } as never)!;
    expect(layoutOf(further.state).columns[0].width).toBe(
      styles.blocks.table.minColumnWidth,
    );
  });
});

describe("column resize hover", () => {
  it("advertises the sideways-resize cursor and names the edge under it", () => {
    const state = stateOf(TABLE);
    const layout = layoutOf(state);
    const region = resizeRegion(state);
    const y = layout.gridTop + 4;
    const blockId = state.document.page.blocks[0].id;

    const first = region.hover!(
      region.hitTest(
        { x: styles.canvas.paddingLeft + layout.columns[1].x, y },
        "mouse",
      )!,
    )!;

    expect(first.cursor).toBe("ew-resize");
    // The engine stores the name and never reads it; what matters is that it
    // says WHICH edge, so the paint below can light exactly that one.
    expect(first.target).toContain(blockId);
    expect(first.target).not.toBe(
      region.hover!({ blockId, index: 2 } as never)!.target,
    );
  });

  it("records the hovered edge on the editor state as the mouse crosses it", () => {
    // The whole chain, as the engine runs it: the hover hit-test picks the
    // region, the region describes itself, and the result lands where both the
    // canvas cursor and the paint below read it.
    const state = stateOf(TABLE);
    const layout = layoutOf(state);
    const y = layout.gridTop + 4;
    const move = (x: number, from: EditorState): EditorState =>
      handleMouseMove(
        from,
        viewport,
        { x, y, button: 0, ctrlKey: false, metaKey: false } as never,
        { left: 0, top: 0 },
        1000,
        createInteractionSession(createChromeRegionRegistry()),
        { start: 0, startY: 0 } as never,
      );

    const onEdge = move(styles.canvas.paddingLeft + layout.columns[1].x, state);
    expect(onEdge.ui.regionHover).toMatchObject({
      regionId: "table-column-resize",
      cursor: "ew-resize",
    });

    // Inside a cell there is nothing to grab, so the affordance goes away.
    const inCell = move(
      styles.canvas.paddingLeft + layout.columns[0].x + 4,
      onEdge,
    );
    expect(inCell.ui.regionHover).toBeNull();
  });

  it("paints the hovered edge over its hairline, and only while it is hovered", () => {
    const state = stateOf(TABLE);
    const blockId = state.document.page.blocks[0].id;
    const strokes = (hover: EditorState["ui"]["regionHover"]): number => {
      const hovered: EditorState = {
        ...state,
        ui: { ...state.ui, regionHover: hover },
      };
      const { ctx, calls } = recordingCtx();
      node.paint(layoutOf(hovered), {
        block: hovered.document.page.blocks[0],
        blockIndex: 0,
        maxWidth: MAX_WIDTH,
        isFirst: true,
        styles,
        marks: hovered.marks,
        ctx,
        state: hovered,
        origin: { x: 0, y: 0 },
        requestRedraw: () => {},
      });
      return calls.filter((call) => call.name === "stroke").length;
    };

    const plain = strokes(null);
    expect(
      strokes({
        regionId: "table-column-resize",
        cursor: "ew-resize",
        target: `${blockId}:column-edge:1`,
      }),
    ).toBe(plain + 1);
    // Another block's table, hovered — not this one's edge.
    expect(
      strokes({
        regionId: "table-column-resize",
        cursor: "ew-resize",
        target: `other:column-edge:1`,
      }),
    ).toBe(plain);
  });
});

describe("column resize on touch", () => {
  it("arms behind a hold so a scroll or long press is never stolen", () => {
    const state = stateOf(TABLE);
    const layout = layoutOf(state);
    const regions =
      node.regions?.({
        block: state.document.page.blocks[0],
        blockIndex: 0,
        maxWidth: MAX_WIDTH,
        isFirst: true,
        styles,
        marks: state.marks,
        state,
        viewport,
        origin: { x: styles.canvas.paddingLeft, y: 0 },
      } as never) ?? [];
    const region = regions.find((r) => r.id === "table-column-resize")!;
    const y = layout.gridTop + 4;
    const edge = styles.canvas.paddingLeft + layout.columns[1].x;

    // The hold is what keeps the page scrolling until the finger has stayed put.
    expect(region.drag?.touchHoldMs).toBeGreaterThan(0);
    // A wider band on touch, still narrow enough to read as "the line".
    expect(region.hitTest({ x: edge + 8, y }, "touch")).not.toBeNull();
    expect(region.hitTest({ x: edge + 8, y }, "mouse")).toBeNull();
  });

  it("lights the held edge without a hover to read it from", () => {
    // Touch never records `ui.regionHover`, so the drag itself has to say which
    // edge is live — otherwise a finger resizes a column with nothing lit.
    const state = stateOf(TABLE);
    const layout = layoutOf(state);
    const region = resizeRegion(state);
    const blockId = state.document.page.blocks[0].id;
    const y = layout.gridTop + 4;
    const edge = styles.canvas.paddingLeft + layout.columns[1].x;
    const hit = region.hitTest({ x: edge + 8, y }, "touch")!;

    const started = region.drag!.onStart(hit, { x: edge, y }, {
      state,
      session: session(hit),
    } as never)!.state;
    expect(started.ui.regionHover).toBeNull();
    expect(strokesFor(started)).toBe(strokesFor(state) + 1);

    // ...and stops saying so once the finger lifts.
    const ended = region.drag!.onEnd({ x: edge + 40, y }, {
      state: started,
      session: session(hit),
    } as never)!.state;
    expect(strokesFor(ended)).toBe(strokesFor(state));
    expect(ended.ui.nodeViewState[blockId]).toEqual({});
  });

  it("drops the lit edge when the drag is cancelled", () => {
    const state = stateOf(TABLE);
    const layout = layoutOf(state);
    const region = resizeRegion(state);
    const y = layout.gridTop + 4;
    const edge = styles.canvas.paddingLeft + layout.columns[1].x;
    const hit = region.hitTest({ x: edge + 8, y }, "touch")!;

    const started = region.drag!.onStart(hit, { x: edge, y }, {
      state,
      session: session(hit),
    } as never)!.state;
    const cancelled = region.drag!.onCancel!({
      state: started,
      session: session(hit),
    } as never)!;
    expect(strokesFor(cancelled)).toBe(strokesFor(state));
  });
});

describe("TableNode selection paint", () => {
  /** Paint the table with `selection` set on the document, and record the calls. */
  function paintWith(selection: EditorState["document"]["selection"]) {
    const base = stateOf(TABLE);
    const state: EditorState = {
      ...base,
      document: { ...base.document, selection, contentSelection: null },
    };
    const layout = layoutOf(state);
    const { ctx, calls } = recordingCtx();
    node.paint(layout, {
      block: state.document.page.blocks[0],
      blockIndex: 0,
      maxWidth: MAX_WIDTH,
      isFirst: true,
      styles,
      marks: state.marks,
      ctx,
      state,
      origin: { x: 0, y: 0 },
      requestRedraw: () => {},
    });
    return { calls, layout };
  }

  const held = {
    anchor: { blockIndex: 0, textIndex: 0 },
    focus: { blockIndex: 0, textIndex: 0 },
    isForward: true,
    isCollapsed: false,
  } as EditorState["document"]["selection"];

  it("washes the grid when the table is held whole", () => {
    const { calls, layout } = paintWith(held);

    // The wash covers the grid exactly — not the block's outer flow margins.
    const wash = calls.find(
      (call) =>
        call.name === "fillRect" &&
        call.args[1] === layout.gridTop &&
        call.args[2] === layout.gridWidth &&
        call.args[3] === layout.gridHeight,
    );
    expect(wash).toBeDefined();
  });

  it("paints nothing extra when there is no selection", () => {
    const { calls, layout } = paintWith(null);

    expect(
      calls.some(
        (call) =>
          call.name === "fillRect" && call.args[3] === layout.gridHeight,
      ),
    ).toBe(false);
  });

  it("washes the table when a multi-block sweep crosses it", () => {
    // A select-all covering several blocks used to leave the table the one
    // blank block in an otherwise highlighted document.
    const { calls, layout } = paintWith({
      anchor: { blockIndex: 0, textIndex: 0 },
      focus: { blockIndex: 3, textIndex: 0 },
      isForward: true,
      isCollapsed: false,
    } as EditorState["document"]["selection"]);

    expect(
      calls.some(
        (call) =>
          call.name === "fillRect" && call.args[3] === layout.gridHeight,
      ),
    ).toBe(true);
  });

  it("does not wash a table outside the selected block range", () => {
    const { calls, layout } = paintWith({
      anchor: { blockIndex: 2, textIndex: 0 },
      focus: { blockIndex: 4, textIndex: 0 },
      isForward: true,
      isCollapsed: false,
    } as EditorState["document"]["selection"]);

    expect(
      calls.some(
        (call) =>
          call.name === "fillRect" && call.args[3] === layout.gridHeight,
      ),
    ).toBe(false);
  });
});

describe("select-all inside a table", () => {
  function busState(source: string): EditorState {
    const state = stateOf(source);
    const bus = createActionBus();
    registerTableActions(bus);
    return { ...state, actionBus: bus };
  }

  it("takes the caret's own cell on the first press", () => {
    let state = caretIn(busState(TABLE), 0, 0, 0);
    state = state.actionBus.dispatchState(SELECT_ALL, state).state;

    const selection = state.document.contentSelection;
    const document = getTableDocument(state.document.page.blocks[0])!;
    const anchor = tableCaretFromContentPoint(document, selection!.anchor);
    const focus = tableCaretFromContentPoint(document, selection!.focus);
    expect(anchor?.cellId).toBe(focus?.cellId);
    expect(anchor?.offset).toBe(0);
    // "Fruit" — the whole of that cell's text, and nothing of its neighbour.
    expect(focus?.offset).toBe(5);
    expect(state.document.selection).toBeNull();
  });

  it("holds the table whole on the second press", () => {
    let state = caretIn(busState(TABLE), 0, 0, 0);
    state = state.actionBus.dispatchState(SELECT_ALL, state).state;
    state = state.actionBus.dispatchState(SELECT_ALL, state).state;

    const selection = state.document.selection;
    expect(selection?.isCollapsed).toBe(false);
    expect(selection?.anchor.blockIndex).toBe(0);
    expect(selection?.focus.blockIndex).toBe(0);
    expect(state.document.contentSelection).toBeNull();
  });

  it("stops claiming once the table is held, so a third press widens", () => {
    // Holding the table cleared the nested caret, so there is no table context
    // left and the handler must fall through to core's document-wide select-all.
    let state = caretIn(busState(TABLE), 0, 0, 0);
    state = state.actionBus.dispatchState(SELECT_ALL, state).state;
    state = state.actionBus.dispatchState(SELECT_ALL, state).state;
    const third = state.actionBus.dispatchState(SELECT_ALL, state);

    expect(third.claimed).toBe(false);
  });

  it("skips the cell rung when the selection already spans two cells", () => {
    const state = busState(TABLE);
    const block = state.document.page.blocks[0];
    const document = getTableDocument(block)!;
    const cells = tableCellIds(document);
    const across = tableRangeToContentSelection(
      document,
      block.id,
      { cellId: cells[0], offset: 0 },
      { cellId: cells[1], offset: 1 },
    )!;
    const spanning = updateContentSelection(state, {
      ...across,
      lastUpdate: Date.now(),
    });
    const held = spanning.actionBus.dispatchState(SELECT_ALL, spanning).state;

    expect(held.document.contentSelection).toBeNull();
    expect(held.document.selection?.isCollapsed).toBe(false);
  });

  it("holds the table straight away from an empty cell", () => {
    // The cell rung would highlight nothing there, which reads as a dead key.
    const EMPTY = ["| A |  |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    let state = caretIn(busState(EMPTY), 0, 1, 0);
    state = state.actionBus.dispatchState(SELECT_ALL, state).state;

    expect(state.document.contentSelection).toBeNull();
    expect(state.document.selection?.isCollapsed).toBe(false);
  });

  it("does not claim select-all when the caret is outside a table", () => {
    const state = busState(TABLE);
    const result = state.actionBus.dispatchState(SELECT_ALL, state);

    expect(result.claimed).toBe(false);
  });
});

describe("column move", () => {
  const THREE = [
    "| A | B | C |",
    "| --- | --- | --- |",
    "| one | two | three |",
  ].join("\n");

  function busState(source: string): EditorState {
    const state = stateOf(source);
    const bus = createActionBus();
    registerTableCommands(bus);
    return { ...state, actionBus: bus };
  }

  function moveRegion(state: EditorState) {
    const regions = node.regions?.(regionCtx(state) as never) ?? [];
    const region = regions.find((r) => r.id === "table-column-move");
    expect(region).toBeDefined();
    return region!;
  }

  /** The header row's titles, in grid order. */
  function header(state: EditorState): string[] {
    const document = getTableDocument(state.document.page.blocks[0])!;
    return readTable(document).rows[0].cells.map((cell) =>
      cell ? cellText(document, cell) : "",
    );
  }

  /** Canvas x of the middle of column `index`. */
  function middleOf(layout: TableLayout, index: number): number {
    const column = layout.columns[index];
    return styles.canvas.paddingLeft + column.x + column.width / 2;
  }

  /** A drag context whose captured hit is the region's own. */
  function ctxOf(state: EditorState, hit: unknown) {
    return {
      state,
      session: { captured: { region: { id: "table-column-move" }, hit } },
    } as never;
  }

  it("offers a grip over each column in the block's top margin only", () => {
    const state = busState(THREE);
    const layout = layoutOf(state);
    const region = moveRegion(state);
    const inMargin = layout.gridTop / 2;

    expect(
      region.hitTest({ x: middleOf(layout, 0), y: inMargin }, "mouse"),
    ).toMatchObject({ index: 0 });
    expect(
      region.hitTest({ x: middleOf(layout, 2), y: inMargin }, "mouse"),
    ).toMatchObject({ index: 2 });
    // Inside the grid the pointer is aimed at a cell, not a grip.
    expect(
      region.hitTest(
        { x: middleOf(layout, 1), y: layout.gridTop + 6 },
        "mouse",
      ),
    ).toBeNull();
    // Beyond the grid's sides there is no column to lift.
    expect(
      region.hitTest(
        { x: styles.canvas.paddingLeft + layout.gridWidth + 5, y: inMargin },
        "mouse",
      ),
    ).toBeNull();
    // A finger never gets one: the band is revealed by hover.
    expect(
      region.hitTest({ x: middleOf(layout, 0), y: inMargin }, "touch"),
    ).toBeNull();
  });

  it("advertises the grab cursor and names the column under it", () => {
    const state = busState(THREE);
    const layout = layoutOf(state);
    const region = moveRegion(state);
    const hit = region.hitTest(
      { x: middleOf(layout, 1), y: layout.gridTop / 2 },
      "mouse",
    )!;

    expect(region.hover?.(hit)).toMatchObject({
      cursor: "grab",
      target: `${state.document.page.blocks[0].id}:column-move:1`,
    });
  });

  it("moves the column to the gap it is dropped in, in one operation", () => {
    const state = busState(THREE);
    const layout = layoutOf(state);
    const region = moveRegion(state);
    const y = layout.gridTop / 2;
    const hit = region.hitTest({ x: middleOf(layout, 0), y }, "mouse")!;

    const started = region.drag!.onStart(
      hit,
      { x: middleOf(layout, 0), y },
      ctxOf(state, hit),
    )!;
    // Past the last column's middle: the gap after it.
    const moved = region.drag!.onMove(
      { x: middleOf(layout, 2) + 10, y },
      ctxOf(started.state, hit),
    )!;
    // The live drag paints; it writes nothing.
    expect(moved.ops ?? []).toHaveLength(0);
    expect(header(moved.state)).toEqual(["A", "B", "C"]);

    // A window-level mouseup has no position; the stored gap decides.
    const released = region.drag!.onEnd(null, ctxOf(moved.state, hit))!;
    expect(released.ops).toHaveLength(1);
    expect(released.ops?.[0].op).toBe("content_edit");
    expect(header(released.state)).toEqual(["B", "C", "A"]);
    expect(
      released.state.ui.nodeViewState[state.document.page.blocks[0].id],
    ).not.toHaveProperty("columnDrag");
  });

  it("treats a drop on either side of the lifted column as no move", () => {
    const state = busState(THREE);
    const layout = layoutOf(state);
    const region = moveRegion(state);
    const y = layout.gridTop / 2;
    const hit = region.hitTest({ x: middleOf(layout, 1), y }, "mouse")!;

    const started = region.drag!.onStart(
      hit,
      { x: middleOf(layout, 1), y },
      ctxOf(state, hit),
    )!;
    // Just past column A's middle is the gap between A and B — where B is.
    const moved = region.drag!.onMove(
      { x: middleOf(layout, 0) + 4, y },
      ctxOf(started.state, hit),
    )!;
    const released = region.drag!.onEnd(null, ctxOf(moved.state, hit))!;

    expect(released.ops ?? []).toHaveLength(0);
    expect(header(released.state)).toEqual(["A", "B", "C"]);
  });

  it("drops the drag on cancel without moving anything", () => {
    const state = busState(THREE);
    const layout = layoutOf(state);
    const region = moveRegion(state);
    const y = layout.gridTop / 2;
    const hit = region.hitTest({ x: middleOf(layout, 2), y }, "mouse")!;

    const started = region.drag!.onStart(
      hit,
      { x: middleOf(layout, 2), y },
      ctxOf(state, hit),
    )!;
    const moved = region.drag!.onMove(
      { x: middleOf(layout, 0) - 4, y },
      ctxOf(started.state, hit),
    )!;
    const cancelled = region.drag!.onCancel(ctxOf(moved.state, hit));

    expect(header(cancelled)).toEqual(["A", "B", "C"]);
    expect(
      cancelled.ui.nodeViewState[state.document.page.blocks[0].id],
    ).not.toHaveProperty("columnDrag");
  });

  it("previews the move in the picture, not the document, while held", () => {
    const state = busState(THREE);
    const layout = layoutOf(state);
    const region = moveRegion(state);
    const y = layout.gridTop / 2;
    const hit = region.hitTest({ x: middleOf(layout, 0), y }, "mouse")!;
    const started = region.drag!.onStart(
      hit,
      { x: middleOf(layout, 0), y },
      ctxOf(state, hit),
    )!;
    const moved = region.drag!.onMove(
      { x: middleOf(layout, 2) + 10, y },
      ctxOf(started.state, hit),
    )!;

    // The document has not moved.
    expect(header(moved.state)).toEqual(["A", "B", "C"]);
    expect(layoutOf(moved.state).columns[0].x).toBe(layout.columns[0].x);

    // The painted lines have: A's header now sits where the last column is.
    const painted = paintLines(moved.state);
    const titleA = painted.find((line) => line.text === "A")!;
    const titleB = painted.find((line) => line.text === "B")!;
    const base = paintLines(state);
    expect(titleB.x).toBe(
      base.find((line) => line.text === "B")!.x - layout.columns[0].width,
    );
    expect(titleA.x).toBe(
      base.find((line) => line.text === "A")!.x +
        layout.columns[1].width +
        layout.columns[2].width,
    );

    // A drag parked beside its own column previews nothing.
    const home = region.drag!.onMove(
      { x: middleOf(layout, 0), y },
      ctxOf(started.state, hit),
    )!;
    expect(paintLines(home.state).find((line) => line.text === "A")!.x).toBe(
      base.find((line) => line.text === "A")!.x,
    );
  });

  it("carries the caret along with its previewed column", () => {
    const state = busState(THREE);
    const layout = layoutOf(state);
    const region = moveRegion(state);
    const y = layout.gridTop / 2;
    const block = state.document.page.blocks[0];
    const document = getTableDocument(block)!;
    const firstCell = readTable(document).rows[0].cells[0]!;
    const point = {
      kind: "text" as const,
      blockId: block.id,
      contentId: document.rootId,
      nodeId: firstCell.id,
      field: "text",
      afterCharId: null,
      affinity: "forward" as const,
    };
    const caretX = (s: EditorState) =>
      node.contentCaretRect(layoutOf(s), point, {
        block: s.document.page.blocks[0] as unknown as TableBlock,
        blockIndex: 0,
        maxWidth: MAX_WIDTH,
        isFirst: true,
        styles,
        marks: s.marks,
        state: s,
        origin: { x: 0, y: 0 },
      })!.x;

    const hit = region.hitTest({ x: middleOf(layout, 0), y }, "mouse")!;
    const started = region.drag!.onStart(
      hit,
      { x: middleOf(layout, 0), y },
      ctxOf(state, hit),
    )!;
    const moved = region.drag!.onMove(
      { x: middleOf(layout, 2) + 10, y },
      ctxOf(started.state, hit),
    )!;

    expect(caretX(moved.state)).toBe(
      caretX(state) + layout.columns[1].width + layout.columns[2].width,
    );
  });

  it("cancels on Escape, putting the picture back with nothing to undo", () => {
    const state = busState(THREE);
    const layout = layoutOf(state);
    const region = moveRegion(state);
    const y = layout.gridTop / 2;
    const hit = region.hitTest({ x: middleOf(layout, 0), y }, "mouse")!;
    const started = region.drag!.onStart(
      hit,
      { x: middleOf(layout, 0), y },
      ctxOf(state, hit),
    )!;
    const moved = region.drag!.onMove(
      { x: middleOf(layout, 2) + 10, y },
      ctxOf(started.state, hit),
    )!;

    const session = createInteractionSession(createChromeRegionRegistry());
    session.captured = { region: region as never, hit };
    // Keys reach the editor only while it is focused, as a real drag's do.
    const focused = {
      ...moved.state,
      view: { ...moved.state.view, isFocused: true },
    };
    const escaped = handleKeyDown(
      focused,
      viewport,
      {
        key: "Escape",
        code: "Escape",
        preventDefault() {},
        stopPropagation() {},
      } as unknown as Event,
      undefined,
      undefined,
      session,
    );

    expect(escaped.ops).toEqual([]);
    expect(session.captured).toBeNull();
    expect(header(escaped.state)).toEqual(["A", "B", "C"]);
    expect(
      escaped.state.ui.nodeViewState[state.document.page.blocks[0].id],
    ).not.toHaveProperty("columnDrag");
    expect(paintLines(escaped.state).find((line) => line.text === "A")!.x).toBe(
      paintLines(state).find((line) => line.text === "A")!.x,
    );
  });

  it("has no grip on a single-column grid", () => {
    const single = busState(["| A |", "| --- |", "| one |"].join("\n"));
    const regions = node.regions?.(regionCtx(single) as never) ?? [];
    expect(regions.find((r) => r.id === "table-column-move")).toBeUndefined();
  });
});
