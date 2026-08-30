/**
 * The table's overlay slot: where the inline controls anchor, and when the
 * table declares none at all.
 */

import { tableExtension } from "./table-extension";
import { TableNode } from "./TableNode";
import { TABLE_TOOLS_OVERLAY, type TableToolsOverlayData } from "./overlays";
import { getTableDocument } from "./structured";
import { createNodeRegistry } from "@tasfer/editor";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import type { EditorState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { resolveTheme } from "@tasfer/editor/styles";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(tableExtension());
const styles = resolveTheme({});
const node = new TableNode();
const MAX_WIDTH = 600;
const TABLE = [
  "| A | B |",
  "| --- | --- |",
  "| one | two |",
  "| three | four |",
].join("\n");

function stateOf(): EditorState {
  return createInitialState(loadPage(TABLE, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
  });
}

/** Put the caret in the cell at row-major index `at`. */
function caretIn(state: EditorState, at: number): EditorState {
  const block = state.document.page.blocks[0];
  const document = getTableDocument(block)!;
  const layout = node.layout({
    block,
    blockIndex: 0,
    maxWidth: MAX_WIDTH,
    isFirst: true,
    styles,
    marks: state.marks,
  });
  const cellId = layout.cells[at].cellId!;
  const point = {
    kind: "text" as const,
    blockId: block.id,
    contentId: document.rootId,
    nodeId: cellId,
    field: "text",
    afterCharId: null,
    affinity: "forward" as const,
  };
  return updateContentSelection(state, { anchor: point, focus: point });
}

function overlaysFor(state: EditorState) {
  return (
    node.overlays?.({
      block: state.document.page.blocks[0],
      blockIndex: 0,
      maxWidth: MAX_WIDTH,
      isFirst: true,
      styles,
      marks: state.marks,
      state,
      origin: { x: 12, y: 40 },
    } as never) ?? []
  );
}

describe("table tools overlay", () => {
  it("declares no overlay when the caret is elsewhere", () => {
    expect(overlaysFor(stateOf())).toEqual([]);
  });

  it("anchors to the cell the caret is in", () => {
    const state = caretIn(stateOf(), 3); // second row, second column
    const [overlay] = overlaysFor(state);
    const layout = node.layout({
      block: state.document.page.blocks[0],
      blockIndex: 0,
      maxWidth: MAX_WIDTH,
      isFirst: true,
      styles,
      marks: state.marks,
    });
    const cell = layout.cells[3];

    expect(overlay.key).toBe(TABLE_TOOLS_OVERLAY);
    expect(overlay.rect.x).toBe(12 + cell.x);
    expect(overlay.rect.y).toBe(40 + cell.y);
    expect(overlay.rect.width).toBe(cell.width);
  });

  it("follows the caret from cell to cell", () => {
    const first = overlaysFor(caretIn(stateOf(), 0))[0];
    const later = overlaysFor(caretIn(stateOf(), 3))[0];

    expect(later.rect.x).not.toBe(first.rect.x);
    expect(later.rect.y).not.toBe(first.rect.y);
  });

  it("carries the grid shape the controls act on", () => {
    const [overlay] = overlaysFor(caretIn(stateOf(), 3));
    const data = overlay.data as TableToolsOverlayData;

    expect(data.shape.rows).toBe(3);
    expect(data.shape.columns).toBe(2);
    expect(data.shape.rowIndex).toBe(1);
    expect(data.shape.columnIndex).toBe(1);
    // The whole grid's box, so the bar can clamp itself to the table.
    expect(data.grid.width).toBeGreaterThan(0);
    expect(data.grid.height).toBeGreaterThan(0);
  });

  it("declares no overlay in a read-only editor", () => {
    const state = caretIn(stateOf(), 0);
    const readonly = {
      ...state,
      ui: { ...state.ui, isReadonlyBase: true },
    } as EditorState;

    expect(overlaysFor(readonly)).toEqual([]);
  });
});
