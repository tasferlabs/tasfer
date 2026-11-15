/**
 * "Edit matrix" for a formula held from the nested text around it.
 *
 * A formula in a node's nested text (here a table cell, the one such node the
 * app ships) is one character in that text plus its own document. With the
 * caret inside the formula the matrix is found as in a paragraph; with the
 * formula held from the text's side — a range over that one character — the
 * lookup used to find no matrix, so the context menu offered no "Edit matrix".
 * These pin that the held formula is found through the editor's mark read, and
 * that the matrix editor's resize then works on it.
 */

import { appSchema, type AppEditor } from "../editorSchema";
import { heldFormula } from "./treeMath";
import {
  RESIZE_MATH_MATRIX,
  mathContentSelectionFromSourceOffset,
  mathMatrixContextInRange,
} from "@tasfer/math";
import {
  getStructuredMathMarkSource,
  mathMarkContentId,
} from "@tasfer/math/data";
import { createNodeRegistry } from "@tasfer/editor";
import { loadPage, type Block } from "@tasfer/editor/serlization/loadPage";
import { createMarkRegistry } from "@tasfer/editor/rendering/marks";
import type { EditorState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { getCharIdAtVisiblePosition } from "@tasfer/editor/sync/char-runs";
import { canonicalizeStructuredDocument } from "@tasfer/editor/sync/structured-content";
import { createCRDTbinding } from "@tasfer/editor/sync/sync";
import { queryMarkInfos } from "@tasfer/editor/positions";
import {
  CELL_TEXT_FIELD,
  getTableDocument,
  readTable,
} from "@tasfer/table/structured";
import { describe, expect, it } from "vitest";

/** The body cell holds `a ` + a 2×2 matrix formula + ` b`; the formula is offset 2. */
const SOURCE = [
  "| A |",
  "| --- |",
  String.raw`| a $\begin{pmatrix}a&b\\c&d\end{pmatrix}$ b |`,
].join("\n");
const CHIP = 2;
/** Same cell layout, with a 2×2 pmatrix then a 1×3 bmatrix in one formula. */
const TWO_GRIDS = [
  "| A |",
  "| --- |",
  String.raw`| a $\begin{pmatrix}a&b\\c&d\end{pmatrix}\begin{bmatrix}x&y&z\end{bmatrix}$ b |`,
].join("\n");

function editorOver(source: string): EditorState {
  const page = loadPage(source, appSchema.data);
  return createInitialState(page, {
    schema: appSchema.data,
    nodes: createNodeRegistry(appSchema.nodes),
    marks: createMarkRegistry(appSchema.marks),
    crdtBinding: createCRDTbinding(page.id, "local"),
  });
}

function tableIn(state: EditorState): Block {
  const block = state.document.page.blocks.find(
    (candidate) => (candidate.type as string) === "table",
  );
  if (!block) throw new Error("expected a table block");
  return block;
}

/** The read side of the app editor the helper uses, over a bare state. */
function readerOver(state: EditorState): AppEditor {
  const block = (id: string) =>
    state.document.page.blocks.find((b) => b.id === id && !b.deleted);
  return {
    state: { contentSelection: state.document.contentSelection },
    query: {
      block: ({ block: id }: { block: string }) => block(id),
      content: (blockId: string, contentId: string) => {
        const document = block(blockId)?.structuredContent?.[contentId];
        return document ? canonicalizeStructuredDocument(document) : null;
      },
      marks: (at: "selection") => queryMarkInfos(state, at),
    },
  } as unknown as AppEditor;
}

/** A range over visible offsets in the body cell's own text. */
function selectInCell(state: EditorState, anchor: number, focus: number) {
  const block = tableIn(state);
  const document = getTableDocument(block)!;
  const cell = readTable(document).rows[1].cells[0]!;
  const point = (offset: number) => ({
    kind: "text" as const,
    blockId: block.id,
    contentId: document.rootId,
    nodeId: cell.id,
    field: CELL_TEXT_FIELD,
    afterCharId: getCharIdAtVisiblePosition(
      [...cell.textFields[CELL_TEXT_FIELD]],
      offset,
    ),
    affinity: "forward" as const,
  });
  return updateContentSelection(state, {
    anchor: point(anchor),
    focus: point(focus),
  });
}

/** The cell's one formula, as LaTeX. */
function cellFormula(state: EditorState): string | undefined {
  const block = tableIn(state);
  const document = getTableDocument(block)!;
  const cell = readTable(document).rows[1].cells[0]!;
  const span = cell.markFields?.[CELL_TEXT_FIELD]?.find(
    (candidate) => candidate.format.type === "math",
  );
  return span && mathMarkContentId(span.format)
    ? getStructuredMathMarkSource(span.format, block.structuredContent)
    : undefined;
}

describe("Edit matrix on a formula held from nested text", () => {
  it("finds the matrix of a formula held from the cell's side", () => {
    const held = selectInCell(editorOver(SOURCE), CHIP, CHIP + 1);
    const formula = heldFormula(readerOver(held));
    expect(formula?.source).toBe(
      String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
    );
    const ctx = mathMatrixContextInRange(
      formula!.source,
      0,
      formula!.source.length,
    );
    expect(ctx).toMatchObject({ env: "pmatrix", rows: 2, cols: 2 });
  });

  it("finds it when the range runs past the formula into the cell's text", () => {
    const held = selectInCell(editorOver(SOURCE), 0, CHIP + 3);
    expect(heldFormula(readerOver(held))).not.toBeNull();
  });

  it("finds nothing for a range that misses the formula", () => {
    const plain = selectInCell(editorOver(SOURCE), 0, CHIP);
    expect(heldFormula(readerOver(plain))).toBeNull();
  });

  it("takes the first grid of a held formula with two", () => {
    const two = selectInCell(editorOver(TWO_GRIDS), CHIP, CHIP + 1);
    const formula = heldFormula(readerOver(two))!;
    const ctx = mathMatrixContextInRange(
      formula.source,
      0,
      formula.source.length,
    );
    expect(ctx).toMatchObject({ env: "pmatrix", rows: 2, cols: 2 });
  });

  it("resizes the matrix once the selection holds it inside the formula", () => {
    const held = selectInCell(editorOver(SOURCE), CHIP, CHIP + 1);
    const formula = heldFormula(readerOver(held))!;
    const { span } = mathMatrixContextInRange(
      formula.source,
      0,
      formula.source.length,
    )!;
    // What opening the matrix editor does: hold the matrix inside the formula.
    const at = (offset: number) =>
      mathContentSelectionFromSourceOffset(
        formula.blockId,
        formula.contentId,
        formula.document,
        offset,
      )!;
    const inside = updateContentSelection(held, {
      ...at(span.start),
      focus: at(span.end).focus,
    });
    const result = inside.actionBus.dispatchState(RESIZE_MATH_MATRIX, inside, {
      rows: 3,
      cols: 2,
    });
    expect(result.claimed).toBe(true);
    expect(cellFormula(result.state)).toBe(
      String.raw`\begin{pmatrix}a&b\\c&d\\&\end{pmatrix}`,
    );
  });
});
