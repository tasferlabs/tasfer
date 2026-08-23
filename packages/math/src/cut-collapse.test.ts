/**
 * Cutting/deleting a range that covers whole trailing lines should not strand
 * an empty block. When the merge that ends a multi-block delete empties the
 * survivor and the selection began at that block's start, the survivor collapses
 * into the previous line (the caret lands at its end) instead of leaving, say,
 * an empty checkbox behind. See the collapse branch in `deleteSelectedText`.
 */

import { mathTestStateOptions } from "./__testutils__/math";
import { deleteSelectedText } from "@tasfer/editor/actions/actions";
import type { Block, Page } from "@tasfer/editor/serlization/loadPage";
import type {
  CursorState,
  EditorState,
  Position,
} from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { getVisibleTextFromRuns } from "@tasfer/editor/sync/char-runs";
import { describe, expect, it } from "vitest";

function todo(id: string, counter: number, text: string): Block {
  return {
    id,
    orderKey: id,
    deleted: false,
    type: "todo_list",
    charRuns: [{ peerId: "peer", startCounter: counter, text }],
    formats: [],
    checked: false,
    indent: 0,
  };
}

function paragraph(id: string, counter: number, text: string): Block {
  return {
    id,
    orderKey: id,
    deleted: false,
    type: "paragraph",
    charRuns: [{ peerId: "peer", startCounter: counter, text }],
    formats: [],
  };
}

function pageWith(...blocks: Block[]): Page {
  return { id: "page-1", title: "t", blocks };
}

function at(blockIndex: number, textIndex: number): Position {
  return { blockIndex, textIndex };
}

function cursorAt(position: Position): CursorState {
  return { position, lastUpdate: 0 };
}

function stateWith(page: Page, anchor: Position, focus: Position): EditorState {
  const state = createInitialState(page, mathTestStateOptions());
  return {
    ...state,
    document: {
      ...state.document,
      cursor: cursorAt(focus),
      selection: { anchor, focus, isForward: true, isCollapsed: false },
    },
  };
}

function visible(state: EditorState): Block[] {
  return state.document.page.blocks.filter((b) => !b.deleted);
}

function text(block: Block): string {
  if (!("charRuns" in block)) throw new Error("not a textual block");
  return getVisibleTextFromRuns(block.charRuns);
}

describe("deleteSelectedText — trailing-line collapse", () => {
  it("removes the survivor and drops the caret on the previous line when whole todos are cut", () => {
    // Select the full text of the last two todos: (1,0) → (2, "cut B".length)
    const state = stateWith(
      pageWith(
        todo("prev", 0, "keep me"),
        todo("a", 100, "cut A"),
        todo("b", 200, "cut B"),
      ),
      at(1, 0),
      at(2, 5),
    );

    const { state: next } = deleteSelectedText(state);
    const rest = visible(next);

    expect(rest).toHaveLength(1);
    expect(text(rest[0])).toBe("keep me");
    // Caret sits at the end of the surviving previous line, not in a leftover.
    expect(next.document.cursor?.position).toEqual(at(0, "keep me".length));
  });

  it("collapses regardless of block type (paragraphs behave the same)", () => {
    const state = stateWith(
      pageWith(
        paragraph("prev", 0, "alpha"),
        paragraph("a", 100, "beta"),
        paragraph("b", 200, "gamma"),
      ),
      at(1, 0),
      at(2, 5),
    );

    const rest = visible(deleteSelectedText(state).state);
    expect(rest).toHaveLength(1);
    expect(text(rest[0])).toBe("alpha");
  });

  it("keeps the survivor when text remains after the selection end", () => {
    // End inside the last block ("cut B" → keep "t B"): survivor is non-empty.
    const state = stateWith(
      pageWith(
        todo("prev", 0, "keep me"),
        todo("a", 100, "cut A"),
        todo("b", 200, "cut B"),
      ),
      at(1, 0),
      at(2, 2),
    );

    const rest = visible(deleteSelectedText(state).state);
    expect(rest).toHaveLength(2);
    expect(text(rest[1])).toBe("t B");
  });

  it("keeps one empty item when the selection starts mid-line", () => {
    // Start at (1,2): survivor retains "cu", so nothing collapses.
    const state = stateWith(
      pageWith(todo("a", 100, "cut A"), todo("b", 200, "cut B")),
      at(0, 2),
      at(1, 5),
    );

    const rest = visible(deleteSelectedText(state).state);
    expect(rest).toHaveLength(1);
    expect(text(rest[0])).toBe("cu");
  });

  it("keeps one empty item when there is no preceding block", () => {
    const state = stateWith(
      pageWith(todo("a", 100, "cut A"), todo("b", 200, "cut B")),
      at(0, 0),
      at(1, 5),
    );

    const rest = visible(deleteSelectedText(state).state);
    expect(rest).toHaveLength(1);
    expect(text(rest[0])).toBe("");
  });
});
