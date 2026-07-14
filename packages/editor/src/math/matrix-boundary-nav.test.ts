import { insertText } from "../actions/actions";
import { handleKeyDown } from "../events/keysEvents";
import { mathExtension } from "../math-extension";
import { INSERT_MATH_COMMAND } from "../nodes/MathNode";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import { baseSchema } from "../schema";
import { moveCursorToPosition } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState, ViewportState } from "../state-types";
import { createInitialState } from "../state-utils";
import { createCRDTbinding } from "../sync/sync";
import {
  getMathStructuredDocument,
  structuredToMathDocument,
} from "./structured";
import { describe, expect, it } from "vitest";

const treeMathSchema = baseSchema.use(mathExtension());
const viewport: ViewportState = {
  width: 800,
  height: 600,
  scrollY: 0,
  documentHeight: 2000,
};

function keydown(key: string): Event {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as Event;
}

function treeState(markdown: string): EditorState {
  return createInitialState(loadPage(markdown, treeMathSchema.data), {
    schema: treeMathSchema.data,
    nodes: createNodeRegistry(treeMathSchema.nodes),
    marks: createMarkRegistry(treeMathSchema.marks),
    crdtBinding: createCRDTbinding("default-page", "tree-test"),
  });
}

function mathBlockIndex(state: EditorState): number {
  return state.document.page.blocks.findIndex(
    (b) => !b.deleted && (b.type as string) === "math",
  );
}

function cellLabel(state: EditorState): string {
  const mi = mathBlockIndex(state);
  const document = getMathStructuredDocument(state.document.page.blocks[mi]);
  const f = state.document.contentSelection?.focus as
    | Record<string, unknown>
    | undefined;
  if (!document || !f) {
    const pos = state.document.cursor?.position;
    return `LEGACY block=${pos?.blockIndex} text=${pos?.textIndex}`;
  }
  const math = structuredToMathDocument(document);
  const matrix = math?.root.body.children.find((c) => c.type === "matrix");
  const labels: Record<string, string> = {};
  const names = [
    ["TL", "TR"],
    ["BL", "BR"],
  ];
  if (matrix?.type === "matrix") {
    matrix.rows.forEach((row, r) =>
      row.cells.forEach((cell, c) => {
        labels[cell.body.id] = names[r]?.[c] ?? `r${r}c${c}`;
      }),
    );
  }
  const parentId = (f.parentId ?? f.nodeId) as string | undefined;
  return parentId && labels[parentId] ? `CELL:${labels[parentId]}` : `ROOT-GAP`;
}

/** Build a doc: paragraph, materialized 2x2 pmatrix, paragraph. Caret ends
 *  focused inside a cell of the matrix. */
function docWithMatrix(): EditorState {
  let state = treeState("before\n\n$$\n\n$$\n\nafter");
  const mi = mathBlockIndex(state);
  state = moveCursorToPosition(state, mi, 0);
  state = state.actionBus.dispatchState(INSERT_MATH_COMMAND, state, {
    text: String.raw`\begin{pmatrix}{}&{}\\{}&{}\end{pmatrix}`,
    caretOffset: 16,
  }).state;
  // ensure materialized
  state = insertText(state, "").state;
  return { ...state, view: { ...state.view, isFocused: true } };
}

/** Press `key` `n` times, collecting the distinct cells the caret visits. */
function cellsVisited(
  state: EditorState,
  key: string,
  presses: number,
): string[] {
  const seen: string[] = [];
  let s = state;
  for (let i = 0; i < presses; i++) {
    s = handleKeyDown(s, viewport, keydown(key)).state;
    const label = cellLabel(s);
    if (label.startsWith("CELL:") && seen[seen.length - 1] !== label) {
      seen.push(label);
    }
  }
  return seen;
}

describe("matrix block-boundary navigation", () => {
  it("steps sequentially top-to-bottom entering from the block before", () => {
    let state = docWithMatrix();
    const mi = mathBlockIndex(state);
    state = moveCursorToPosition(
      { ...state, document: { ...state.document, contentSelection: null } },
      mi - 1,
      "before".length,
    );
    state = { ...state, view: { ...state.view, isFocused: true } };
    expect(cellsVisited(state, "ArrowRight", 6)).toEqual([
      "CELL:TL",
      "CELL:TR",
      "CELL:BL",
      "CELL:BR",
    ]);
  });

  it("steps sequentially bottom-to-top entering from the block after", () => {
    let state = docWithMatrix();
    const mi = mathBlockIndex(state);
    state = moveCursorToPosition(
      { ...state, document: { ...state.document, contentSelection: null } },
      mi + 1,
      0,
    );
    state = { ...state, view: { ...state.view, isFocused: true } };
    // Entering from the right must reach the LAST cell first, then walk back.
    expect(cellsVisited(state, "ArrowLeft", 6)).toEqual([
      "CELL:BR",
      "CELL:BL",
      "CELL:TR",
      "CELL:TL",
    ]);
  });
});
