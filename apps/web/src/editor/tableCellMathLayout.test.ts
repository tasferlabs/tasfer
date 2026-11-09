/**
 * A formula in a table cell is measured as the formula, not as its anchor.
 *
 * Canvas output itself is not observable here, so this pins the input the
 * painter and the caret both read: the cell's laid-out line. Without the table
 * block's attachments a formula is one zero-width placeholder; with them it
 * reserves its rendered width and height.
 */

import { vi } from "vitest";

// Text measurement needs a canvas context before the engine's modules load;
// this app's test environment is plain node.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.document !== "undefined") return;
  const element = () => ({
    // Width proportional to length, so measured widths mean something.
    getContext: () => ({
      measureText: (text: string) => ({ width: text.length * 7 }),
    }),
    style: {},
    setAttribute: () => {},
    appendChild: () => {},
  });
  g.getComputedStyle = () => ({ getPropertyValue: () => "" });
  g.document = {
    documentElement: {},
    location: "http://localhost/",
    getElementsByTagName: () => [],
    createElement: element,
    createElementNS: element,
    addEventListener: () => {},
  };
});

import { appSchema } from "../editorSchema";
import { createNodeRegistry } from "@tasfer/editor";
import { currentFontFamily } from "@tasfer/editor/fonts";
import { createMarkRegistry } from "@tasfer/editor/rendering/marks";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import { createInitialState } from "@tasfer/editor/state-utils";
import { getEditorStyles } from "@tasfer/editor/styles";
import { layoutTable } from "@tasfer/table/geometry";
import { getTableDocument } from "@tasfer/table/structured";
import { describe, expect, it } from "vitest";
import {
  EXTEND_SELECTION_LEFT,
  MOVE_CURSOR_DOWN,
  MOVE_CURSOR_LEFT,
} from "@tasfer/editor/actions/keyboard-actions";
import { DELETE_BACKWARD } from "@tasfer/editor/actions/edit-actions";
import { POINTER_MOVE } from "@tasfer/editor/actions/pointer-actions";
import type { NodeLayout } from "@tasfer/editor/rendering/nodes/Node";
import type { EditorState, ViewportState } from "@tasfer/editor/state-types";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { invertOperations } from "@tasfer/editor/sync/inverse";
import { applyOp } from "@tasfer/editor/sync/reducer";
import { createCRDTbinding } from "@tasfer/editor/sync/sync";
import type { TableCellLayout, TableLayout } from "@tasfer/table/geometry";
import {
  tableCaretFromContentPoint,
  tableCaretToContentSelection,
  tableCellIds,
} from "@tasfer/table/selection";
import {
  replacementRunForContent,
  textCaretRect,
} from "@tasfer/editor/text-layout";

describe("a formula in a table cell", () => {
  it("lays out at the formula's own size, read from the table block", () => {
    const page = loadPage(
      ["| A |", "| --- |", "| $\\frac{a+b+c+d}{e}$ |"].join("\n"),
      appSchema.data,
    );
    const state = createInitialState(page, {
      schema: appSchema.data,
      nodes: createNodeRegistry(appSchema.nodes),
      marks: createMarkRegistry(appSchema.marks),
    });
    const styles = getEditorStyles(state);
    const block = page.blocks[0];
    const ctx = {
      maxWidth: 600,
      style: styles.blocks.table,
      fontFamily: currentFontFamily(styles),
      fonts: styles.fonts,
      marks: state.marks,
    };

    const placeholder = layoutTable(getTableDocument(block), ctx).cells[1];
    const formula = layoutTable(getTableDocument(block), {
      ...ctx,
      attachments: block.structuredContent,
    }).cells[1];

    expect(placeholder.lines[0].width).toBe(0);
    expect(formula.lines[0].width).toBeGreaterThan(20);
    // A fraction is taller than a line of text, and the row makes room.
    expect(formula.height).toBeGreaterThan(placeholder.height);
  });
});

// ─── Inside a cell's formula ─────────────────────────────────────────────────

const SOURCE = ["| A |", "| --- |", "| a $x+y$ b |", "| below |"].join("\n");

function open(): EditorState {
  const page = loadPage(SOURCE, appSchema.data);
  return createInitialState(page, {
    schema: appSchema.data,
    nodes: createNodeRegistry(appSchema.nodes),
    marks: createMarkRegistry(appSchema.marks),
    crdtBinding: createCRDTbinding(page.id, "local"),
  });
}

function nodeCtx(state: EditorState) {
  const styles = getEditorStyles(state);
  const block = state.document.page.blocks[0];
  return {
    block: block as never,
    blockIndex: 0,
    maxWidth: 600,
    isFirst: true,
    styles,
    marks: state.marks,
    state,
    origin: { x: 0, y: 0 },
  };
}

const table = (state: EditorState) => state.nodes.get("table")!;

function laidOut(state: EditorState): TableLayout {
  return table(state).layout(nodeCtx(state)) as TableLayout;
}

/** The formula's cell, its attachment id and its run's box in the cell. */
function formula(state: EditorState) {
  const layout = laidOut(state);
  const block = state.document.page.blocks[0];
  const contentId = Object.keys(block.structuredContent ?? {}).find(
    (id) => block.structuredContent![id].kind === "math",
  )!;
  const cell = layout.cells.find((candidate) =>
    replacementRunForContent(candidate.text, contentId),
  ) as TableCellLayout;
  const run = replacementRunForContent(cell.text, contentId)!;
  const left = cell.textX + textCaretRect(cell.text, run.start).x;
  const right = cell.textX + textCaretRect(cell.text, run.end).x;
  const line = cell.text.lines[0];
  const baseline = cell.textY + line.y + (line.baselineOffset ?? 0);
  return { layout, cell, contentId, left, right, baseline };
}

/** Caret in the body cell just after the formula, then ← into it. */
function inside(state: EditorState): EditorState {
  const block = state.document.page.blocks[0];
  const document = getTableDocument(block)!;
  const cellId = tableCellIds(document)[1];
  const after = updateContentSelection(
    state,
    tableCaretToContentSelection(document, block.id, { cellId, offset: 3 }),
  );
  return after.actionBus.dispatchState(MOVE_CURSOR_LEFT, after).state;
}

const VIEWPORT = { width: 700, height: 800 } as ViewportState;

describe("the caret inside a cell's formula", () => {
  it("lands inside the formula for a click on it, and in the text beside it", () => {
    const state = open();
    const { layout, contentId, left, right, baseline } = formula(state);
    const hit = (x: number) =>
      table(state).contentSelectionFromPoint!(
        layout as NodeLayout,
        { x, y: baseline - 3 },
        nodeCtx(state),
        { pointerType: "mouse" },
      );
    expect(hit((left + right) / 2)?.focus.contentId).toBe(contentId);
    const beside = hit(left - 10);
    expect(beside?.focus.contentId).not.toBe(contentId);
    expect(beside?.focus.kind).toBe("text");
  });

  it("is drawn inside the formula's box, in its cell", () => {
    const state = inside(open());
    const { layout, left, right, cell } = formula(state);
    const point = state.document.contentSelection!.focus;
    const rect = table(state).contentCaretRect!(
      layout as NodeLayout,
      point,
      nodeCtx(state),
    );
    expect(rect).not.toBeNull();
    expect(rect!.x).toBeGreaterThanOrEqual(left - 1);
    expect(rect!.x).toBeLessThanOrEqual(right + 1);
    expect(rect!.y).toBeGreaterThanOrEqual(cell.y);
    expect(rect!.height).toBeGreaterThan(0);
  });

  it("highlights a range inside the formula within its box", () => {
    const entered = inside(open());
    const state = entered.actionBus.dispatchState(
      EXTEND_SELECTION_LEFT,
      entered,
    ).state;
    const selection = state.document.contentSelection!;
    const { layout, left, right } = formula(state);
    expect(selection.anchor.contentId).toBe(selection.focus.contentId);
    const geometry = table(state).contentSelectionGeometry!(
      layout as NodeLayout,
      selection,
      nodeCtx(state),
    );
    expect(geometry?.rects.length).toBeGreaterThan(0);
    for (const rect of geometry!.rects) {
      expect(rect.x).toBeGreaterThanOrEqual(left - 1);
      expect(rect.x + rect.width).toBeLessThanOrEqual(right + 1);
    }
  });

  it("reports a range inside the formula's direction, for its touch handles", () => {
    const entered = inside(open());
    // Shift+← from the formula's end grows the range backward.
    const state = entered.actionBus.dispatchState(
      EXTEND_SELECTION_LEFT,
      entered,
    ).state;
    const backward = state.document.contentSelection!;
    const { layout } = formula(state);
    const direction = (selection: typeof backward) =>
      table(state).contentSelectionGeometry!(
        layout as NodeLayout,
        selection,
        nodeCtx(state),
      )?.isForward;
    expect(direction(backward)).toBe(false);
    expect(
      direction({
        ...backward,
        anchor: backward.focus,
        focus: backward.anchor,
      }),
    ).toBe(true);
  });

  it("moves to the cell below on Down once the formula has no row below", () => {
    const state = inside(open());
    const down = state.actionBus.dispatchState(MOVE_CURSOR_DOWN, state, {
      viewport: VIEWPORT,
    }).state;
    const block = down.document.page.blocks[0];
    const document = getTableDocument(block)!;
    const caret = tableCaretFromContentPoint(
      document,
      down.document.contentSelection!.focus,
    );
    expect(caret?.cellId).toBe(tableCellIds(document)[2]);
  });

  it("brings a formula deleted whole back on undo", () => {
    const before = open();
    const block = before.document.page.blocks[0];
    const document = getTableDocument(block)!;
    let state = updateContentSelection(
      before,
      tableCaretToContentSelection(document, block.id, {
        cellId: tableCellIds(document)[1],
        offset: 3,
      }),
    );
    const ops = [];
    // A Backspace per symbol, and one for the empty formula.
    for (let press = 0; press < 4; press++) {
      const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);
      state = result.state;
      ops.push(...result.ops);
    }
    expect(formulaCount(state)).toBe(0);
    const inverses = invertOperations(
      ops,
      before.document.page,
      (page, op) => applyOp(page, op, appSchema.data),
      before.CRDTbinding,
      appSchema.data,
    );
    let page = state.document.page;
    for (const op of inverses) page = applyOp(page, op, appSchema.data);
    const restored = { ...state, document: { ...state.document, page } };
    // Applying ops by hand skips the editor's layout invalidation.
    page.blocks[0].cachedLayout = undefined;
    expect(formulaCount(restored)).toBe(1);
    expect(formula(restored).cell).toBeDefined();
  });

  it("lights the formula under the pointer, with the hand cursor's hover state", () => {
    const state = open();
    const { layout, contentId, left, right, baseline } = formula(state);
    const at = (x: number) =>
      state.actionBus.dispatchState(POINTER_MOVE, state, {
        canvasX: x,
        canvasY: baseline,
        textPosition: null,
        blockUnderPoint: 0,
        atomicBlock: null,
        viewport: VIEWPORT,
        resolveCoords: () => null,
        resolveContentSelection: () =>
          table(state).contentSelectionFromPoint!(
            layout as NodeLayout,
            { x, y: baseline - 3 },
            nodeCtx(state),
            { pointerType: "mouse" },
          ),
        modifiers: { ctrlOrMeta: false },
      }).state.ui.inlineMathHover;
    expect(at((left + right) / 2)).toMatchObject({ blockIndex: 0, contentId });
    expect(at(left - 10)).toBeNull();
  });
});

/** Formulas still showing in the grid. */
function formulaCount(state: EditorState): number {
  const layout = laidOut(state);
  const block = state.document.page.blocks[0];
  return Object.keys(block.structuredContent ?? {}).filter(
    (id) =>
      block.structuredContent![id].kind === "math" &&
      layout.cells.some((cell) => replacementRunForContent(cell.text, id)),
  ).length;
}
