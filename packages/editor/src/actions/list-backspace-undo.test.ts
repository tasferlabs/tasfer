/**
 * Backspace at the start of a list item leaves the list — outdent first, then
 * become a paragraph. That change has to travel as a `block_set` op: one made
 * by splicing the page locally is invisible to undo (which then takes back the
 * edit before it instead, jumping the caret), to peers, and to a reload.
 */

import { baseSchema } from "../schema";
import { moveCursorToPosition } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { recordUndoOps, undoState } from "../sync/crdt-undo";
import { applyOps } from "../sync/reducer";
import { insertText } from "./actions";
import { DELETE_BACKWARD } from "./edit-actions";
import { describe, expect, it } from "vitest";

function load(md: string): EditorState {
  if (md === "") {
    // An empty bullet doesn't survive a markdown parse — type it instead.
    const empty = createInitialState(loadPage("", baseSchema.data), {
      schema: baseSchema.data,
    });
    let s = moveCursorToPosition(empty, 0, 0);
    for (const ch of "- ") s = insertText(s, ch).state;
    expect(summary(s)).toEqual(["bullet_list:"]);
    return s;
  }
  const page = loadPage(md, baseSchema.data);
  return createInitialState(page, { schema: baseSchema.data });
}

/** Backspace at the start of `blockIndex`, recorded the way the editor does. */
function backspaceAt(state: EditorState, blockIndex: number) {
  const before = moveCursorToPosition(state, blockIndex, 0);
  const result = before.actionBus.dispatchState(DELETE_BACKWARD, before);
  const after = recordUndoOps(
    before,
    result.state,
    result.ops,
    before.CRDTbinding.getPeerId(),
  );
  return { before, after, ops: result.ops };
}

function summary(state: EditorState) {
  return state.document.page.blocks
    .filter((b) => !b.deleted)
    .map((b) => {
      const indent = (b as { indent?: number }).indent;
      const text = getVisibleTextFromRuns((b as { charRuns?: [] }).charRuns);
      return `${b.type}${indent ? `@${indent}` : ""}:${text}`;
    });
}

describe("Backspace at the start of a list item", () => {
  it.each([
    ["the first item", "- one\n- two", 0, ["paragraph:one", "bullet_list:two"]],
    ["a later item", "- one\n- two", 1, ["bullet_list:one", "paragraph:two"]],
    ["an empty only item", "", 0, ["paragraph:"]],
    [
      "an indented item",
      "- one\n  - two",
      1,
      ["bullet_list:one", "bullet_list:two"],
    ],
  ])(
    "%s: emits ops that rebuild it and undo restores it",
    (_, md, index, expected) => {
      const start = load(md);
      const { before, after, ops } = backspaceAt(start, index);
      expect(ops.length).toBeGreaterThan(0);
      expect(summary(after)).toEqual(expected);

      // A peer replaying the ops sees the same document.
      const replayed = applyOps(before.document.page, ops, before.schema);
      expect(
        summary({ ...after, document: { ...after.document, page: replayed } }),
      ).toEqual(summary(after));

      // Undo takes back exactly this, and the caret stays on the item.
      const undone = undoState(after).state;
      expect(summary(undone)).toEqual(summary(before));
      expect(undone.document.cursor?.position).toEqual({
        blockIndex: index,
        textIndex: 0,
      });
    },
  );

  it("undo brings back a todo's check mark", () => {
    const start = load("- [x] done");
    expect(
      (start.document.page.blocks[0] as { checked?: boolean }).checked,
    ).toBe(true);
    const { after } = backspaceAt(start, 0);
    expect(summary(after)).toEqual(["paragraph:done"]);

    const undone = undoState(after).state;
    const restored = undone.document.page.blocks[0] as {
      type: string;
      checked?: boolean;
    };
    expect(restored.type).toBe("todo_list");
    expect(restored.checked).toBe(true);
  });
});
