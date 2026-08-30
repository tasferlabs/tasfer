/**
 * The outer-edge "add" strips: where they sit, when they are offered at all,
 * and what a click on one does to the grid.
 */

import { tableEdgeStrips, withinEdgeBox } from "./edge-adders";
import { readTable } from "./structured";
import { getTableDocument } from "./structured";
import { tableExtension } from "./table-extension";
import { TableNode } from "./TableNode";
import { createNodeRegistry } from "@tasfer/editor";
import type { NodeHitRegion } from "@tasfer/editor/rendering/nodes/Node";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import type { EditorState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { resolveTheme } from "@tasfer/editor/styles";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(tableExtension());
const styles = resolveTheme({});
const node = new TableNode();
const MAX_WIDTH = 600;
const ORIGIN = { x: 40, y: 100 };
const TABLE = ["| A | B |", "| --- | --- |", "| one | two |"].join("\n");

function stateOf(markdown = TABLE): EditorState {
  return createInitialState(loadPage(markdown, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
  });
}

function layoutOf(state: EditorState) {
  return node.layout({
    block: state.document.page.blocks[0],
    blockIndex: 0,
    maxWidth: MAX_WIDTH,
    isFirst: true,
    styles,
    marks: state.marks,
  });
}

function regionCtx(state: EditorState) {
  return {
    block: state.document.page.blocks[0],
    blockIndex: 0,
    maxWidth: MAX_WIDTH,
    isFirst: true,
    styles,
    marks: state.marks,
    state,
    viewport: { width: 800, height: 600, scrollY: 0 },
    origin: ORIGIN,
  } as never;
}

/** The edge-strip region a table declares, by its registered id. */
function edgeRegion(state: EditorState) {
  const regions = node.regions(regionCtx(state)) as readonly NodeHitRegion[];
  return regions.find((region) => region.id === "table-edge-add")!;
}

/** The grid, as row/column counts, after a state change. */
function shapeOf(state: EditorState) {
  const view = readTable(getTableDocument(state.document.page.blocks[0])!);
  return { rows: view.rows.length, columns: view.columns.length };
}

describe("edge strip geometry", () => {
  it("offers a strip past the right edge and below the last row", () => {
    const layout = layoutOf(stateOf());
    const strips = tableEdgeStrips(layout, ORIGIN, 40);

    expect(strips.map((strip) => strip.edge)).toEqual(["right", "bottom"]);
    const [right, bottom] = strips;
    // Clear of the grid on both counts — a strip never covers a cell.
    expect(right.x).toBeGreaterThan(ORIGIN.x + layout.gridWidth);
    expect(bottom.y).toBeGreaterThan(
      ORIGIN.y + layout.gridTop + layout.gridHeight,
    );
    expect(right.height).toBe(layout.gridHeight);
    expect(bottom.width).toBe(layout.gridWidth);
  });

  it("catches the pointer from the grid's border outward, never over it", () => {
    const layout = layoutOf(stateOf());
    const [right, bottom] = tableEdgeStrips(layout, ORIGIN, 40);
    const gridRight = ORIGIN.x + layout.gridWidth;
    const gridBottom = ORIGIN.y + layout.gridTop + layout.gridHeight;
    const midY = ORIGIN.y + layout.gridTop + layout.gridHeight / 2;

    expect(withinEdgeBox(right.hit, { x: gridRight + 2, y: midY })).toBe(true);
    // One pixel inside the last column still belongs to the cell.
    expect(withinEdgeBox(right.hit, { x: gridRight - 1, y: midY })).toBe(false);
    expect(
      withinEdgeBox(bottom.hit, { x: ORIGIN.x + 10, y: gridBottom + 2 }),
    ).toBe(true);
    expect(
      withinEdgeBox(bottom.hit, { x: ORIGIN.x + 10, y: gridBottom - 1 }),
    ).toBe(false);
  });

  it("stays near the table on a page with a wide margin", () => {
    const layout = layoutOf(stateOf());
    const [right] = tableEdgeStrips(layout, ORIGIN, 400);

    // A narrow reading column centers itself, leaving hundreds of pixels of
    // gutter; the strip must not follow the pointer across all of it.
    expect(right.hit.width).toBeLessThanOrEqual(28);
  });

  it("leaves an edge out when there is no room for a band", () => {
    const layout = layoutOf(stateOf());
    const strips = tableEdgeStrips(layout, ORIGIN, 6);

    expect(strips.map((strip) => strip.edge)).toEqual(["bottom"]);
  });
});

describe("edge strip region", () => {
  it("declines a touch, which has no hover to reveal the strip with", () => {
    const state = stateOf();
    const layout = layoutOf(state);
    const p = { x: ORIGIN.x + layout.gridWidth + 4, y: ORIGIN.y + 20 };

    expect(edgeRegion(state).hitTest(p, "mouse")).not.toBeNull();
    expect(edgeRegion(state).hitTest(p, "touch")).toBeNull();
  });

  it("declines in a read-only editor", () => {
    const state = stateOf();
    const layout = layoutOf(state);
    const readonly = {
      ...state,
      ui: { ...state.ui, isReadonlyBase: true },
    } as EditorState;
    const p = { x: ORIGIN.x + layout.gridWidth + 4, y: ORIGIN.y + 20 };

    expect(edgeRegion(readonly).hitTest(p, "mouse")).toBeNull();
  });

  it("names the hovered edge so paint can light the same band", () => {
    const state = stateOf();
    const layout = layoutOf(state);
    const hit = edgeRegion(state).hitTest(
      { x: ORIGIN.x + layout.gridWidth + 4, y: ORIGIN.y + 20 },
      "mouse",
    )!;
    const hover = edgeRegion(state).hover!(hit)!;

    expect(hover.cursor).toBe("pointer");
    expect(hover.target).toBe(
      `${state.document.page.blocks[0].id}:edge-add:right`,
    );
  });

  it("is still offered on a single-column grid, which cannot be resized", () => {
    const state = stateOf(["| A |", "| --- |", "| one |"].join("\n"));
    const ids = (
      node.regions(regionCtx(state)) as readonly NodeHitRegion[]
    ).map((region) => region.id);

    expect(ids).toEqual(["table-edge-add"]);
  });
});

describe("clicking an edge strip", () => {
  /** Click the given edge and return the grid it leaves behind. */
  function click(edge: "right" | "bottom") {
    const state = stateOf();
    const layout = layoutOf(state);
    const region = edgeRegion(state);
    const p =
      edge === "right"
        ? { x: ORIGIN.x + layout.gridWidth + 4, y: ORIGIN.y + 20 }
        : {
            x: ORIGIN.x + 20,
            y: ORIGIN.y + layout.gridTop + layout.gridHeight + 4,
          };
    const hit = region.hitTest(p, "mouse")!;
    const result = region.onTap!(hit, p, 1, {
      state,
      viewport: { width: 800, height: 600, scrollY: 0 },
    } as never)!;
    return { before: shapeOf(state), after: shapeOf(result.state), result };
  }

  it("adds a column past the last one", () => {
    const { before, after, result } = click("right");

    expect(before).toEqual({ rows: 2, columns: 2 });
    expect(after).toEqual({ rows: 2, columns: 3 });
    // The grid grew through ordinary content_edit operations, so the edit
    // merges, syncs and undoes like a typed character.
    expect(result.ops!.length).toBeGreaterThan(0);
  });

  it("adds a row below the last one", () => {
    const { before, after } = click("bottom");

    expect(before).toEqual({ rows: 2, columns: 2 });
    expect(after).toEqual({ rows: 3, columns: 2 });
  });

  it("lands the caret in the cell it just made", () => {
    const { result } = click("right");
    const focus = result.state.document.contentSelection?.focus;
    const document = getTableDocument(result.state.document.page.blocks[0])!;
    const header = readTable(document).rows[0].cells;

    expect(focus?.kind).toBe("text");
    expect(focus && focus.kind === "text" ? focus.nodeId : null).toBe(
      header[header.length - 1]!.id,
    );
  });

  it("acts on the table under the pointer, not the caret's own", () => {
    // No caret anywhere: the strip names its own block, so the command still
    // resolves a table to edit.
    const { after } = click("right");

    expect(after.columns).toBe(3);
  });
});
