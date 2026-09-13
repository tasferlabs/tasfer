/**
 * Touch selection handles for text selected inside a table cell.
 *
 * A cell range lives in the nested content selection, not the flat one, so the
 * handles, their grab targets and "is this tap on the selection" all come from
 * the band the table reports through `contentSelectionGeometry`.
 */

import {
  tableCaretFromContentPoint,
  tableCellIds,
  tableRangeToContentSelection,
} from "./selection";
import { getTableDocument } from "./structured";
import { tableExtension } from "./table-extension";
import { createActionBus } from "@tasfer/editor/action-bus";
import { dragContentHandleToPoint } from "@tasfer/editor/events/chromeRegions";
import { getSelectionHandleAtPoint } from "@tasfer/editor/events/eventUtils";
import { createNodeRegistry } from "@tasfer/editor/rendering/nodes";
import { baseSchema } from "@tasfer/editor/schema";
import {
  contentSelectionHandlePositions,
  getContentSelectionDocumentGeometry,
  isPointWithinSelectionRects,
} from "@tasfer/editor/selection";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import type { EditorState, ViewportState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { resolveTheme } from "@tasfer/editor/styles";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  const dom = (globalThis as unknown as { document: Record<string, unknown> })
    .document;
  if (!dom.body) dom.body = { appendChild: () => {}, removeChild: () => {} };
});

const schema = baseSchema.use(tableExtension());
const styles = resolveTheme({});
const MAX_WIDTH = 600;
const viewport: ViewportState = {
  width: MAX_WIDTH + styles.canvas.paddingLeft + styles.canvas.paddingRight,
  height: 800,
  scrollY: 0,
} as ViewportState;

const TABLE = [
  "| Fruit basket | Price |",
  "| --- | --- |",
  "| Green apples and pears | 1.20 |",
].join("\n");

/** A range in the cell at `cell`, from `anchor` to `focus` characters in. */
function selected(cell: number, anchor: number, focus: number): EditorState {
  const state = createInitialState(loadPage(TABLE, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
  });
  const block = state.document.page.blocks[0];
  const document = getTableDocument(block)!;
  const cellId = tableCellIds(document)[cell];
  return updateContentSelection(
    { ...state, actionBus: createActionBus() },
    tableRangeToContentSelection(
      document,
      block.id,
      { cellId, offset: anchor },
      { cellId, offset: focus },
    )!,
  );
}

function offsets(state: EditorState) {
  const selection = state.document.contentSelection!;
  const document = getTableDocument(state.document.page.blocks[0])!;
  return {
    anchor: tableCaretFromContentPoint(document, selection.anchor)!.offset,
    focus: tableCaretFromContentPoint(document, selection.focus)!.offset,
  };
}

describe("selection handles on a range inside a cell", () => {
  it("hangs the handles off the selected band", () => {
    const state = selected(2, 0, 5); // "Green"
    const geometry = getContentSelectionDocumentGeometry(state, viewport)!;
    expect(geometry).not.toBeNull();
    expect(geometry.isForward).toBe(true);
    expect(geometry.end.x).toBeGreaterThan(geometry.start.x);

    const handles = contentSelectionHandlePositions(geometry);
    expect(handles.anchor.isTop).toBe(true);
    expect(handles.focus.isTop).toBe(false);
  });

  it("grabs either handle by its ball", () => {
    const state = selected(2, 0, 5);
    const { anchor, focus } = contentSelectionHandlePositions(
      getContentSelectionDocumentGeometry(state, viewport)!,
    );
    const { size, stemHeight } = styles.selection.handles;

    expect(
      getSelectionHandleAtPoint(
        anchor.x,
        anchor.y - stemHeight - size / 2,
        state,
        viewport,
      ),
    ).toBe("anchor");
    expect(
      getSelectionHandleAtPoint(
        focus.x,
        focus.y + focus.height + stemHeight + size / 2,
        state,
        viewport,
      ),
    ).toBe("focus");
  });

  it("knows a tap on the band is on the selection", () => {
    const state = selected(2, 0, 5);
    const [band] = getContentSelectionDocumentGeometry(state, viewport)!.rects;

    expect(
      isPointWithinSelectionRects(
        band.x + band.width / 2,
        band.y + band.height / 2,
        state,
        viewport,
      ),
    ).toBe(true);
    expect(
      isPointWithinSelectionRects(
        band.x + band.width + 200,
        band.y + band.height / 2,
        state,
        viewport,
      ),
    ).toBe(false);
  });

  it("drags the focus handle along the cell and keeps the anchor", () => {
    const state = selected(2, 0, 5);
    const { focus } = contentSelectionHandlePositions(
      getContentSelectionDocumentGeometry(state, viewport)!,
    );

    const next = dragContentHandleToPoint(
      state,
      focus.x + 60,
      focus.y + focus.height / 2,
      viewport,
    );

    expect(next.document.selection).toBeNull();
    const range = offsets(next);
    expect(range.anchor).toBe(0);
    expect(range.focus).toBeGreaterThan(5);
  });
});
