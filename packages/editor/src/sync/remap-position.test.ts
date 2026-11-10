/**
 * `remapPosition` carries a caret across a page update from a peer: it follows
 * the character it sits after, not its offset.
 */
import "../entries/editor";
import { deleteSelectedText, insertText } from "../actions/actions";
import { moveCursorToPosition } from "../selection";
import { loadPage, type Page } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { remapPosition } from "./crdt-utils";
import { applyOps } from "./reducer";
import { describe, expect, it } from "vitest";

function peerChange(
  markdown: string,
  edit: (peer: EditorState) => { state: EditorState; ops: unknown[] },
): { before: Page; after: Page } {
  const before = loadPage(markdown);
  const { ops } = edit(createInitialState(before));
  return { before, after: applyOps(before, ops as never) };
}

function select(state: EditorState, from: number, to: number): EditorState {
  return {
    ...state,
    document: {
      ...state.document,
      cursor: null,
      selection: {
        anchor: { blockIndex: 0, textIndex: from },
        focus: { blockIndex: 0, textIndex: to },
        isForward: true,
        isCollapsed: false,
        lastUpdate: 0,
      },
    },
  };
}

function at(textIndex: number, blockIndex = 0) {
  return { blockIndex, textIndex };
}

describe("remapPosition", () => {
  it("moves with text the peer typed before it", () => {
    const { before, after } = peerChange("hello world", (p) =>
      insertText(moveCursorToPosition(p, 0, 0), "AB "),
    );
    expect(remapPosition(before, after, at(5))).toEqual(at(8));
  });

  it("stays put for text typed after it", () => {
    const { before, after } = peerChange("hello world", (p) =>
      insertText(moveCursorToPosition(p, 0, 11), "!"),
    );
    expect(remapPosition(before, after, at(5))).toEqual(at(5));
  });

  it("stays before text the peer typed exactly at it", () => {
    const { before, after } = peerChange("hello world", (p) =>
      insertText(moveCursorToPosition(p, 0, 5), "XYZ"),
    );
    expect(remapPosition(before, after, at(5))).toEqual(at(5));
  });

  it("lands where the deleted text was when the peer deleted around it", () => {
    // "hello world" → peer deletes "lo wo": the caret after "hello" sat on a
    // deleted character and lands at the deletion point.
    const { before, after } = peerChange("hello world", (p) =>
      deleteSelectedText(select(p, 3, 8)),
    );
    expect(remapPosition(before, after, at(5))).toEqual(at(3));
    // And one after the deleted range shifts back by its length.
    expect(remapPosition(before, after, at(10))).toEqual(at(5));
  });

  it("clamps an offset past the end of the block to its end", () => {
    const { before, after } = peerChange("hello", (p) =>
      insertText(moveCursorToPosition(p, 0, 0), "A"),
    );
    expect(remapPosition(before, after, at(99))).toEqual(at(6));
  });

  it("returns null when the block is gone", () => {
    const before = loadPage("hello");
    const after: Page = {
      ...before,
      blocks: before.blocks.map((b) => ({ ...b, deleted: true })),
    };
    expect(remapPosition(before, after, at(2))).toBeNull();
  });
});
