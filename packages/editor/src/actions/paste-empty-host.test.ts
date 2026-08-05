/**
 * Pasting into an empty block should land the content in place. Two artifacts
 * this guards against: a leading blank line in the payload leaving a stray empty
 * line above the paste, and the empty host forcing the first pasted block to
 * merge into its (paragraph) type — which dropped a pasted checklist's first
 * checkbox. See the trim + empty-host retype in `insertBlocksAtCursor`.
 */

import { moveCursorToPosition } from "../selection";
import type { Block, CharRun } from "../serlization/loadPage";
import { loadPage } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { applyOps, getVisibleBlocks } from "../sync/reducer";
import { pasteFromClipboardEvent } from "./clipboard";
import { describe, expect, it } from "vitest";

function pasteText(state: EditorState, text: string) {
  return pasteFromClipboardEvent(state, {} as ClipboardEvent, {
    html: "",
    text,
    imageFile: null,
  });
}

function blockText(b: Block): string {
  return getVisibleTextFromRuns((b as { charRuns: CharRun[] }).charRuns);
}

/** Empty paragraph, caret at its start — the "Type '/' for actions." block. */
function emptyDoc(): EditorState {
  return moveCursorToPosition(createInitialState(loadPage("\n")), 0, 0);
}

describe("paste into an empty block", () => {
  it("drops a checklist in place — no stray empty line, checkboxes kept", () => {
    const state = emptyDoc();
    const result = pasteText(state, "- [ ] a\n- [ ] b\n- [ ] c");
    expect(result).not.toBeNull();

    const blocks = getVisibleBlocks(result!.state.document.page);
    expect(blocks.map((b) => b.type)).toEqual([
      "todo_list",
      "todo_list",
      "todo_list",
    ]);
    expect(blocks.map(blockText)).toEqual(["a", "b", "c"]);

    // Convergence: replaying the ops reconstructs the same blocks.
    const replayed = applyOps(state.document.page, result!.ops);
    expect(getVisibleBlocks(replayed).map((b) => b.type)).toEqual([
      "todo_list",
      "todo_list",
      "todo_list",
    ]);
    expect(getVisibleBlocks(replayed).map(blockText)).toEqual(["a", "b", "c"]);
  });

  it("trims a leading blank line instead of keeping it as an empty line", () => {
    const state = emptyDoc();
    const result = pasteText(state, "\n- [ ] a\n- [ ] b");

    const blocks = getVisibleBlocks(result!.state.document.page);
    // No leading empty paragraph; both items are todos in place.
    expect(blocks.map((b) => b.type)).toEqual(["todo_list", "todo_list"]);
    expect(blocks.map(blockText)).toEqual(["a", "b"]);
  });

  it("keeps a single pasted todo as a todo (checkbox), not a paragraph", () => {
    const state = emptyDoc();
    const result = pasteText(state, "- [ ] only");

    const blocks = getVisibleBlocks(result!.state.document.page);
    expect(blocks.map((b) => b.type)).toEqual(["todo_list"]);
    expect(blockText(blocks[0])).toBe("only");
  });

  it("adopts the checked state of the first pasted item", () => {
    const state = emptyDoc();
    const result = pasteText(state, "- [x] done\n- [ ] todo");

    const [first, second] = getVisibleBlocks(result!.state.document.page);
    expect(first.type).toBe("todo_list");
    expect((first as { checked?: boolean }).checked).toBe(true);
    expect((second as { checked?: boolean }).checked).toBe(false);
  });

  it("leaves plain paragraphs unchanged (no regression)", () => {
    const state = emptyDoc();
    const result = pasteText(state, "Alpha\nBravo");

    const blocks = getVisibleBlocks(result!.state.document.page);
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
    expect(blocks.map(blockText)).toEqual(["Alpha", "Bravo"]);
  });

  it("does not retype a NON-empty host — first block still merges", () => {
    // Caret at end of "Start"; the host has content, so no in-place replace.
    const state = moveCursorToPosition(
      createInitialState(loadPage("Start\n")),
      0,
      5,
    );
    const result = pasteText(state, "- [ ] a\n- [ ] b");

    const blocks = getVisibleBlocks(result!.state.document.page);
    // Host keeps its paragraph type and absorbs the first pasted line's text.
    expect(blocks[0].type).toBe("paragraph");
    expect(blockText(blocks[0])).toBe("Starta");
    expect(blocks[1].type).toBe("todo_list");
    expect(blockText(blocks[1])).toBe("b");
  });
});
