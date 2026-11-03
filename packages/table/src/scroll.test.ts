/**
 * A table wider than the page: when it grows past the page, how its offset
 * moves and clamps, and the editor gestures that drive it — a sideways wheel,
 * a sideways finger drag, and the caret moving into a hidden column.
 */

import { tableEdgeStrips } from "./edge-adders";
import {
  layoutTable,
  scrolledTableLayout,
  tableGridWidth,
  type TableLayout,
  tableScrollRange,
} from "./geometry";
import {
  revealTableSpan,
  scrollTableBy,
  tableScrollbar,
  tableScrollX,
  viewedTableLayout,
  withTableScrollX,
} from "./scroll";
import { tableCaretToContentSelection } from "./selection";
import { getTableDocument } from "./structured";
import { tableExtension } from "./table-extension";
import { type TableBlock, TableNode } from "./TableNode";
import { createNodeRegistry } from "@tasfer/editor";
import { createChromeRegionRegistry } from "@tasfer/editor/events/chromeRegions";
import { createInteractionSession } from "@tasfer/editor/events/interaction-session";
import { handleWheel } from "@tasfer/editor/events/mouseEvents";
import {
  revealCaretSideways,
  stepSidewaysFling,
  wheelSidewaysDelta,
} from "@tasfer/editor/events/sidewaysScroll";
import {
  handleTouchEnd,
  handleTouchMove,
  handleTouchStart,
  touchStartsOwnedGesture,
} from "@tasfer/editor/events/touchEvents";
import { currentFontFamily } from "@tasfer/editor/fonts";
import type { NodeHitRegion } from "@tasfer/editor/rendering/nodes/Node";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import type { EditorState, ViewportState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { resolveTheme } from "@tasfer/editor/styles";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(tableExtension());
const styles = resolveTheme({});
const node = new TableNode();
const MAX_WIDTH = 600;
const OVERFLOW = styles.blocks.table.overflowColumnWidth;

/** Eight columns: at 600px that is 75px each, well under the overflow width. */
const WIDE = [
  "| a | b | c | d | e | f | g | h |",
  "| - | - | - | - | - | - | - | - |",
  "| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |",
].join("\n");

/** Two columns: 300px each, so this table fits the page as it always did. */
const NARROW = ["| a | b |", "| - | - |", "| 1 | 2 |"].join("\n");

const viewport: ViewportState = {
  width: MAX_WIDTH + styles.canvas.paddingLeft + styles.canvas.paddingRight,
  height: 800,
  scrollY: 0,
} as ViewportState;

function stateOf(source: string): EditorState {
  return createInitialState(loadPage(source, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
  });
}

function blockOf(state: EditorState): TableBlock {
  return state.document.page.blocks[0] as unknown as TableBlock;
}

function layoutOf(state: EditorState): TableLayout {
  return node.layout({
    block: state.document.page.blocks[0],
    blockIndex: 0,
    maxWidth: MAX_WIDTH,
    isFirst: true,
    styles,
    marks: state.marks,
  });
}

function scrollCtx(state: EditorState) {
  return {
    block: state.document.page.blocks[0],
    blockIndex: 0,
    maxWidth: MAX_WIDTH,
    isFirst: true,
    styles,
    marks: state.marks,
    state,
  };
}

/** A point on the first row of the table, `x` px into the page column. */
function pointOnTable(state: EditorState, x: number) {
  const layout = layoutOf(state);
  return {
    x: styles.canvas.paddingLeft + x,
    y: styles.canvas.paddingTop + layout.gridTop + layout.rows[0].height / 2,
  };
}

/** Park the local caret at the start of the cell in `column` of row 0. */
function caretInColumn(state: EditorState, column: number): EditorState {
  const block = blockOf(state);
  const document = getTableDocument(block)!;
  const cellId = layoutOf(state).rows[0].cells[column].cellId!;
  const selection = tableCaretToContentSelection(document, block.id, {
    cellId,
    offset: 0,
  })!;
  return updateContentSelection(state, selection);
}

function touchEvent(x: number, y: number) {
  return {
    touches: [{ clientX: x, clientY: y, radiusX: 0, radiusY: 0 }],
    preventDefault: () => {},
  } as unknown as TouchEvent;
}

describe("when a table outgrows the page", () => {
  it("fills the page while its columns can keep the overflow width", () => {
    expect(tableGridWidth(2, MAX_WIDTH, styles.blocks.table)).toBe(MAX_WIDTH);
    const layout = layoutOf(stateOf(NARROW));
    expect(layout.gridWidth).toBe(MAX_WIDTH);
    expect(tableScrollRange(layout)).toBe(0);
  });

  it("grows past the page once the columns would average narrower", () => {
    const layout = layoutOf(stateOf(WIDE));
    expect(layout.gridWidth).toBe(8 * OVERFLOW);
    const total = layout.columns.reduce((sum, column) => sum + column.width, 0);
    expect(total).toBe(layout.gridWidth);
    expect(tableScrollRange(layout)).toBe(8 * OVERFLOW - MAX_WIDTH);
  });

  it("keeps the same split between columns on a narrower page", () => {
    const state = stateOf(WIDE);
    const document = getTableDocument(blockOf(state))!;
    const wide = layoutTable(document, {
      maxWidth: 2000,
      style: styles.blocks.table,
      fontFamily: currentFontFamily(styles),
      fonts: styles.fonts,
    });
    const narrow = layoutOf(state);
    // 2000px holds eight columns at 250px; 600px cannot hold eight at the
    // overflow width, so it draws them at exactly that instead.
    expect(wide.columns[0].width).toBe(250);
    expect(narrow.columns[0].width).toBe(OVERFLOW);
  });
});

describe("scrolled layout", () => {
  it("moves every column, cell and line by the offset", () => {
    const layout = layoutOf(stateOf(WIDE));
    const scrolled = scrolledTableLayout(layout, 100);
    expect(scrolled.gridX).toBe(-100);
    expect(scrolled.columns[3].x).toBe(layout.columns[3].x - 100);
    expect(scrolled.cells[5].x).toBe(layout.cells[5].x - 100);
    expect(scrolled.cells[5].textX).toBe(layout.cells[5].textX - 100);
    expect(scrolled.lines[0].x).toBe(layout.lines[0].x - 100);
    // Scrolling never re-wraps a cell.
    expect(scrolled.rows[0].height).toBe(layout.rows[0].height);
  });

  it("is the canonical layout itself at no offset", () => {
    const layout = layoutOf(stateOf(WIDE));
    expect(scrolledTableLayout(layout, 0)).toBe(layout);
  });
});

describe("the scroll offset", () => {
  it("moves by a delta and stops at both ends", () => {
    const state = stateOf(WIDE);
    const layout = layoutOf(state);
    const id = blockOf(state).id;
    const range = tableScrollRange(layout);

    const moved = scrollTableBy(state, id, layout, 50)!;
    expect(tableScrollX(moved, id, layout)).toBe(50);
    const end = scrollTableBy(moved, id, layout, 10_000)!;
    expect(tableScrollX(end, id, layout)).toBe(range);
    // Already at the end: nothing to do, so the gesture is the page's.
    expect(scrollTableBy(end, id, layout, 10)).toBeNull();
    expect(scrollTableBy(state, id, layout, -10)).toBeNull();
  });

  it("does nothing for a table that fits", () => {
    const state = stateOf(NARROW);
    expect(
      scrollTableBy(state, blockOf(state).id, layoutOf(state), 50),
    ).toBeNull();
  });

  it("is clamped when the table gets narrower under it", () => {
    const state = stateOf(WIDE);
    const id = blockOf(state).id;
    const scrolled = withTableScrollX(state, id, 10_000);
    expect(tableScrollX(scrolled, id, layoutOf(state))).toBe(
      tableScrollRange(layoutOf(state)),
    );
  });

  it("keeps what else the block's view state holds", () => {
    const state = stateOf(WIDE);
    const id = blockOf(state).id;
    const held = {
      ...state,
      ui: {
        ...state.ui,
        nodeViewState: { [id]: { resizeEdge: 2 } },
      },
    };
    const scrolled = withTableScrollX(held, id, 40);
    expect(scrolled.ui.nodeViewState[id]).toEqual({
      resizeEdge: 2,
      scrollX: 40,
    });
  });

  it("reveals a span with the least movement", () => {
    const state = stateOf(WIDE);
    const layout = layoutOf(state);
    const id = blockOf(state).id;
    const last = layout.columns[7];
    const right = revealTableSpan(
      state,
      id,
      layout,
      last.x,
      last.x + last.width,
    )!;
    expect(tableScrollX(right, id, layout)).toBe(
      last.x + last.width - MAX_WIDTH,
    );
    const first = layout.columns[0];
    const back = revealTableSpan(right, id, layout, first.x, first.width)!;
    expect(tableScrollX(back, id, layout)).toBe(0);
    // In view already.
    expect(revealTableSpan(state, id, layout, 0, 100)).toBeNull();
  });
});

describe("what a wide table shows", () => {
  it("offers the right add strip only with the grid's right edge in view", () => {
    const state = stateOf(WIDE);
    const layout = layoutOf(state);
    const origin = { x: 40, y: 0 };
    const edges = (shown: TableLayout) =>
      tableEdgeStrips(shown, origin, 60).map((strip) => strip.edge);
    expect(edges(layout)).toEqual(["bottom"]);
    const atEnd = scrolledTableLayout(layout, tableScrollRange(layout));
    expect(edges(atEnd)).toEqual(["right", "bottom"]);
    // The bottom strip spans only the window, wherever the grid is.
    const bottom = tableEdgeStrips(atEnd, origin, 60).find(
      (strip) => strip.edge === "bottom",
    )!;
    expect(bottom.x).toBe(origin.x);
    expect(bottom.width).toBe(MAX_WIDTH);
  });

  it("puts the scrollbar thumb at the start, then the end", () => {
    const layout = layoutOf(stateOf(WIDE));
    const origin = { x: 40, y: 0 };
    expect(tableScrollbar(layoutOf(stateOf(NARROW)), origin)).toBeNull();
    const start = tableScrollbar(layout, origin)!;
    expect(start.x).toBe(origin.x);
    expect(start.width).toBeCloseTo((MAX_WIDTH * MAX_WIDTH) / layout.gridWidth);
    const end = tableScrollbar(
      scrolledTableLayout(layout, tableScrollRange(layout)),
      origin,
    )!;
    expect(end.x + end.width).toBeCloseTo(origin.x + MAX_WIDTH);
  });

  it("keeps the scrollbar on screen while the grid runs past its bottom", () => {
    const layout = layoutOf(stateOf(WIDE));
    const origin = { x: 40, y: 0 };
    const natural = tableScrollbar(layout, origin)!;
    const gridTop = origin.y + layout.gridTop;
    const gridBottom = gridTop + layout.gridHeight;
    // The whole table is on screen: the thumb stays under the grid.
    expect(tableScrollbar(layout, origin, gridBottom + 100)!.y).toBe(natural.y);
    // The screen ends mid-grid: the thumb rides its bottom edge.
    const cut = gridTop + layout.gridHeight / 2;
    const pinned = tableScrollbar(layout, origin, cut)!;
    expect(pinned.y + pinned.height).toBeLessThanOrEqual(cut);
    expect(pinned.y).toBeGreaterThan(gridTop);
    // The screen ends above the grid: the thumb stops at the grid's top.
    expect(tableScrollbar(layout, origin, gridTop - 50)!.y).toBeGreaterThan(
      gridTop,
    );
  });

  it("pins a caret scrolled out of view to the window's edge", () => {
    const state = caretInColumn(stateOf(WIDE), 7);
    const point = state.document.contentSelection!.focus;
    const ctx = { ...scrollCtx(state), origin: { x: 0, y: 0 } };
    const layout = layoutOf(state);
    // Past the right edge: flagged, and pinned to that edge on its row.
    const hidden = node.contentCaretRect(layout, point, {
      ...ctx,
      block: blockOf(state),
    })!;
    expect(hidden.offscreen).toBe("right");
    expect(hidden.x).toBe(layout.maxWidth);
    const id = blockOf(state).id;
    const scrolled = withTableScrollX(state, id, tableScrollRange(layout));
    const shown = node.contentCaretRect(layoutOf(scrolled), point, {
      ...ctx,
      state: scrolled,
      block: blockOf(scrolled),
    })!;
    expect(shown.offscreen).toBeUndefined();
    expect(shown.y).toBe(hidden.y);
    // Scrolled back past it: pinned to the left edge instead.
    const left = caretInColumn(scrolled, 0);
    const leftPoint = left.document.contentSelection!.focus;
    const pinned = node.contentCaretRect(layoutOf(left), leftPoint, {
      ...ctx,
      state: left,
      block: blockOf(left),
    })!;
    expect(pinned.offscreen).toBe("left");
    expect(pinned.x).toBe(0);
  });

  it("maps a click to the column under it after a scroll", () => {
    const state = stateOf(WIDE);
    const id = blockOf(state).id;
    const scrolled = withTableScrollX(state, id, 3 * OVERFLOW);
    const layout = layoutOf(scrolled);
    const row = layout.rows[0];
    const selection = node.contentSelectionFromPoint(
      layout,
      { x: OVERFLOW / 2, y: row.y + row.height / 2 },
      { ...scrollCtx(scrolled), block: blockOf(scrolled) },
      { pointerType: "mouse" },
    );
    // Three columns are scrolled past, so the first one in view is the fourth.
    expect(selection?.focus.kind === "text" && selection.focus.nodeId).toBe(
      row.cells[3].cellId,
    );
  });
});

describe("painting a wide table", () => {
  it("draws through the window and fades both cut-off sides", () => {
    const state = stateOf(WIDE);
    const id = blockOf(state).id;
    const scrolled = withTableScrollX(state, id, 100);
    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_target, key: string) => {
          if (key === "canvas") return {};
          if (key === "createLinearGradient") {
            return () => ({ addColorStop: () => {} });
          }
          return (...args: unknown[]) => {
            calls.push(key);
            return args;
          };
        },
        set: (_target, key: string, value: unknown) => {
          if (key === "globalCompositeOperation") calls.push(`erase:${value}`);
          return true;
        },
      },
    ) as unknown as CanvasRenderingContext2D;

    const rendered = node.paint(layoutOf(scrolled), {
      ...scrollCtx(scrolled),
      ctx,
      origin: { x: 0, y: 0 },
      requestRedraw: () => {},
    });

    expect(calls.filter((call) => call === "save").length).toBe(
      calls.filter((call) => call === "restore").length,
    );
    expect(calls).toContain("erase:destination-out");
    // One rect per faded side, both sides having columns past them.
    const erase = calls.indexOf("erase:destination-out");
    expect(
      calls.slice(erase).filter((call) => call === "fillRect").length,
    ).toBeGreaterThanOrEqual(2);
    // Line boxes come back where they are drawn: scrolled.
    expect(rendered.lines[0].x).toBe(layoutOf(state).lines[0].x - 100);
  });
});

describe("gestures", () => {
  it("reads which wheel events are sideways", () => {
    const wheel = { deltaMode: 0, shiftKey: false };
    expect(wheelSidewaysDelta({ ...wheel, deltaX: 12, deltaY: 3 }, 800)).toBe(
      12,
    );
    expect(
      wheelSidewaysDelta({ ...wheel, deltaX: 2, deltaY: 30 }, 800),
    ).toBeNull();
    // Shift turns a plain wheel sideways.
    expect(
      wheelSidewaysDelta(
        { ...wheel, shiftKey: true, deltaX: 0, deltaY: 30 },
        800,
      ),
    ).toBe(30);
    // A mouse that counts in lines.
    expect(
      wheelSidewaysDelta({ ...wheel, deltaMode: 1, deltaX: 3, deltaY: 0 }, 800),
    ).toBe(48);
  });

  it("scrolls the table under a sideways wheel, and the page past its end", () => {
    const state = stateOf(WIDE);
    const id = blockOf(state).id;
    const session = createInteractionSession(createChromeRegionRegistry());
    const p = pointOnTable(state, 100);
    const wheel = (s: EditorState, deltaX: number) => {
      let scrolledPage: number | undefined;
      const next = handleWheel(
        s,
        viewport,
        { deltaX, deltaY: 0, deltaMode: 0, shiftKey: false, ...p } as never,
        2000,
        session,
        (v) => {
          scrolledPage = v.scrollY;
        },
        { left: 0, top: 0 },
      );
      return { next, scrolledPage };
    };

    const first = wheel(state, 80);
    expect(tableScrollX(first.next, id, layoutOf(state))).toBe(80);
    expect(first.scrolledPage).toBeUndefined();

    const end = withTableScrollX(state, id, tableScrollRange(layoutOf(state)));
    const past = wheel(end, 80);
    // At its end the table lets the event go on to the page.
    expect(past.scrolledPage).toBeDefined();
  });

  it("scrolls the table under a sideways finger drag, then coasts", () => {
    let state = stateOf(WIDE);
    const id = blockOf(state).id;
    const session = createInteractionSession(createChromeRegionRegistry());
    const start = pointOnTable(state, 400);
    const ctx = { state, viewport, documentHeight: 2000, session };
    expect(touchStartsOwnedGesture(start, ctx)).toBe(true);

    const container = { left: 0, top: 0 };
    state = handleTouchStart(
      state,
      viewport,
      touchEvent(start.x, start.y),
      container,
      2000,
      session,
    );
    // The clock has to move for the drag to register at all.
    session.touch!.lastTime -= 16;
    state = handleTouchMove(
      state,
      viewport,
      touchEvent(start.x - 40, start.y + 2),
      container,
      2000,
      session,
    );
    expect(session.touch?.sideways).toBeDefined();
    expect(tableScrollX(state, id, layoutOf(state))).toBe(40);

    // A quick last move, so the release has speed to carry.
    session.touch!.sideways!.lastTime -= 16;
    session.touch!.lastTime -= 16;
    state = handleTouchMove(
      state,
      viewport,
      touchEvent(start.x - 80, start.y + 2),
      container,
      2000,
      session,
    );
    expect(tableScrollX(state, id, layoutOf(state))).toBe(80);

    state = handleTouchEnd(
      state,
      viewport,
      touchEvent(start.x - 80, start.y + 2),
      container,
      2000,
      session,
    ).state;
    expect(session.sidewaysFling?.blockId).toBe(id);
    // The page never moved.
    expect(state.view.momentum.isActive).toBe(false);

    session.sidewaysFling!.lastTime -= 16;
    const coasted = stepSidewaysFling(state, viewport, session);
    expect(tableScrollX(coasted, id, layoutOf(state))).toBeGreaterThan(80);
  });

  it("lets a finger hold and drag the scrollbar thumb, as a mouse does", () => {
    let state = stateOf(WIDE);
    const id = blockOf(state).id;
    const layout = layoutOf(state);
    const origin = { x: styles.canvas.paddingLeft, y: 0 };
    const regions = node.regions({
      ...scrollCtx(state),
      viewport,
      origin,
    } as never) as readonly NodeHitRegion[];
    const thumbRegion = regions.find((r) => r.id === "table-scrollbar")!;
    const thumb = tableScrollbar(layout, origin, viewport.height)!;
    // A finger gets a wider target than the 4px bar, and the page
    // scrollbar's hold before it takes over.
    const press = { x: thumb.x + 10, y: thumb.y + thumb.height + 12 };
    expect(thumbRegion.hitTest(press, "mouse")).toBeNull();
    const hit = thumbRegion.hitTest(press, "touch");
    expect(hit).not.toBeNull();
    expect(thumbRegion.drag?.touchHoldMs).toBeGreaterThan(0);
    expect(thumbRegion.drag?.cursor).toBe("grabbing");

    const session = createInteractionSession(createChromeRegionRegistry());
    session.captured = { region: thumbRegion as never, hit };
    const ctx = () => ({ state, viewport, documentHeight: 2000, session });
    state = thumbRegion.drag!.onStart(hit, press, ctx())!.state;
    expect(state.ui.nodeViewState[id]).toMatchObject({
      scrollbarDrag: "touch",
    });

    state = thumbRegion.drag!.onMove(
      { x: press.x + 20, y: press.y },
      ctx(),
    )!.state;
    expect(tableScrollX(state, id, layout)).toBeCloseTo(20 * thumb.scale);

    state = thumbRegion.drag!.onEnd(null, ctx())!.state;
    expect(state.ui.nodeViewState[id]).not.toHaveProperty("scrollbarDrag");
    expect(tableScrollX(state, id, layout)).toBeCloseTo(20 * thumb.scale);
  });

  it("leaves a drag over a table that fits to the page", () => {
    const state = stateOf(NARROW);
    const session = createInteractionSession(createChromeRegionRegistry());
    const start = pointOnTable(state, 200);
    expect(
      touchStartsOwnedGesture(start, {
        state,
        viewport,
        documentHeight: 2000,
        session,
      }),
    ).toBe(false);
  });

  it("scrolls a caret moved into a hidden column into view", () => {
    const state = caretInColumn(stateOf(WIDE), 7);
    const id = blockOf(state).id;
    const layout = layoutOf(state);
    const revealed = revealCaretSideways(
      state,
      viewport,
      state.document.contentSelection!.focus,
    );
    const shown = viewedTableLayout(layout, revealed, id);
    const cell = shown.rows[0].cells[7];
    // The whole cell, right against the window's right edge.
    expect(cell.x).toBeGreaterThanOrEqual(0);
    expect(cell.x + cell.width).toBe(MAX_WIDTH);
  });

  it("leaves the table alone when the caret already shows", () => {
    const state = caretInColumn(stateOf(WIDE), 1);
    const revealed = revealCaretSideways(
      state,
      viewport,
      state.document.contentSelection!.focus,
    );
    expect(revealed).toBe(state);
  });
});
