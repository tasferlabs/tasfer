/**
 * Text being composed through an IME, shown in its cell before it commits.
 *
 * Paragraphs draw the composition in place with an underline; a cell draws it
 * the same way through the shared text engine. The preview is paint and caret
 * only: nothing reaches the document until the composition ends.
 */

import {
  cellCaretX,
  tableCaretFromContentPoint,
  tableCaretToContentPoint,
} from "./selection";
import { type TableBlock, TableNode } from "./TableNode";
import {
  cellIds,
  editorOf,
  selectInCell,
  tableDocument,
  tableSource,
} from "./text-safety/harness";
import {
  COMPOSITION_START,
  COMPOSITION_UPDATE,
} from "@tasfer/editor/actions/input-actions";
import type { EditorState } from "@tasfer/editor/state-types";
import { resolveTheme } from "@tasfer/editor/styles";
import { getVisibleTextFromChars } from "@tasfer/editor/sync/char-runs";
import { describe, expect, it } from "vitest";

const node = new TableNode();
const styles = resolveTheme({});
const MAX_WIDTH = 600;
const CELL = 2;

function ctxOf(state: EditorState) {
  const block = state.document.page.blocks[0];
  return {
    state,
    block,
    blockIndex: 0,
    maxWidth: MAX_WIDTH,
    isFirst: true,
    styles,
    marks: state.marks,
  };
}

function compose(state: EditorState, ...updates: string[]): EditorState {
  const [first, ...rest] = updates;
  state = state.actionBus.dispatchState(COMPOSITION_START, state, {
    data: first,
  }).state;
  for (const data of rest) {
    state = state.actionBus.dispatchState(COMPOSITION_UPDATE, state, {
      data,
    }).state;
  }
  return state;
}

/** What paint draws: the layout it paints from, captured off the line boxes. */
function paintOf(state: EditorState) {
  const calls: { key: string; args: unknown[] }[] = [];
  const ctx = new Proxy(
    {},
    {
      get: (_target, key: string) => {
        if (key === "canvas") return {};
        if (key === "measureText") {
          return (text: string) => ({ width: text.length * 7 });
        }
        return (...args: unknown[]) => {
          calls.push({ key, args });
        };
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  const c = ctxOf(state);
  const layout = node.layout(c);
  const rendered = node.paint(layout, {
    ...c,
    ctx,
    origin: { x: 0, y: 0 },
    requestRedraw: () => {},
  });
  return { calls, rendered, layout };
}

function cellLineTexts(state: EditorState): string[] {
  const { rendered, layout } = paintOf(state);
  const cell = layout.cells[CELL];
  return rendered.lines
    .filter(
      (line) =>
        line.y >= cell.y &&
        line.y < cell.y + cell.height &&
        line.x >= cell.x &&
        line.x < cell.x + cell.width,
    )
    .map((line) => line.text);
}

function localCaretX(state: EditorState): number {
  const c = ctxOf(state);
  const rect = node.contentCaretRect(
    node.layout(c),
    state.document.contentSelection!.focus,
    { ...c, block: c.block as unknown as TableBlock, origin: { x: 0, y: 0 } },
  );
  return rect!.x;
}

describe("IME composition in a cell", () => {
  it("draws the composing text at the caret before it commits", () => {
    const state = compose(
      selectInCell(editorOf(tableSource("one")), CELL, 3, 3),
      "ك",
      "كت",
    );

    expect(cellLineTexts(state)).toEqual(["oneكت"]);
    // Nothing is stored yet.
    const { document } = tableDocument(state);
    const id = cellIds(state)[CELL];
    expect(
      document.nodes[id].textFields.text.map((run) => run.text).join(""),
    ).toBe("one");
  });

  it("underlines the composing text", () => {
    const plain = selectInCell(editorOf(tableSource("one")), CELL, 3, 3);
    const composing = compose(plain, "にほ");
    const strokes = (state: EditorState) =>
      paintOf(state).calls.filter((call) => call.key === "stroke").length;

    expect(strokes(composing)).toBe(strokes(plain) + 1);
  });

  it("puts the caret after the composing text", () => {
    const plain = selectInCell(editorOf(tableSource("one two")), CELL, 3, 3);
    const composing = compose(plain, "xyz");

    expect(localCaretX(composing)).toBeGreaterThan(localCaretX(plain));
    // The same x the caret would take after "onexyz" if it were stored.
    const typed = editorOf(tableSource("onexyz two"));
    const typedLayout = node.layout(ctxOf(typed));
    expect(localCaretX(composing)).toBeCloseTo(
      cellCaretX(typedLayout.cells[CELL], 6),
      6,
    );
  });

  it("stands in for a selected range the commit will replace", () => {
    const state = compose(
      selectInCell(editorOf(tableSource("one two")), CELL, 0, 3),
      "日本",
    );

    expect(cellLineTexts(state)).toEqual(["日本 two"]);
  });

  it("keeps a peer's caret on the text it was next to", () => {
    const state = compose(
      selectInCell(editorOf(tableSource("one two")), CELL, 3, 3),
      "xyz",
    );
    const { block, document } = tableDocument(state);
    const id = cellIds(state)[CELL];
    // A caret after "two" — past the composition.
    const peer = tableCaretToContentPoint(document, block.id, {
      cellId: id,
      offset: 7,
    })!;
    const c = ctxOf(state);
    const rect = node.contentCaretRect(node.layout(c), peer, {
      ...c,
      block: c.block as unknown as TableBlock,
      origin: { x: 0, y: 0 },
    });
    const typed = editorOf(tableSource("onexyz two"));
    const typedLayout = node.layout(ctxOf(typed));

    expect(tableCaretFromContentPoint(document, peer)?.offset).toBe(7);
    expect(rect!.x).toBeCloseTo(cellCaretX(typedLayout.cells[CELL], 10), 6);
  });

  it("draws the stored text once the composition is cancelled", () => {
    const plain = selectInCell(editorOf(tableSource("one")), CELL, 3, 3);
    const cancelled = compose(plain, "ك", "");

    expect(cellLineTexts(cancelled)).toEqual(["one"]);
    expect(
      getVisibleTextFromChars(paintOf(cancelled).layout.cells[CELL].chars),
    ).toBe("one");
  });
});
