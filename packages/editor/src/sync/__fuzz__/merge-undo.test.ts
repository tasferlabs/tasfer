/**
 * Regression for "blocks jump down" after undo of a merge.
 *
 * Symptom: user presses Backspace at the start of a paragraph (merging it
 * into the previous paragraph), then Cmd+Z. The merged-into block keeps the
 * merged content AND an empty paragraph appears below it where the merged
 * block used to live.
 *
 * Root cause (historical): the old merge logic locally spliced the merged
 * content onto blockToPreserve.charRuns and removed blockToDelete from the
 * array, but only emitted `block_delete blockToDelete`. The captured inverse
 * for that op only restores an empty paragraph (paragraph's only registered
 * field is `type`, so no content travels with the inverse) and the local
 * charRuns-splice is never undone.
 *
 * Fix: merge through real ops — text_insert for the moved content + format
 * spans + block_delete — and apply via applyOps. The inverse text_delete
 * captured for the text_insert reverses the chars-moving as part of the
 * same undo group. This test drives the fixed path against the lower-level
 * ops so we don't need to spin up the canvas editor.
 */

import { invertOperations, refreshOps } from "../../inverse";
import { type Page } from "../../serlization/loadPage";
import type { BlockInsert, Operation, TextInsert } from "../../state-types";
import { isTextualBlock } from "../block-registry";
import { getVisibleLengthFromRuns, iterateVisibleChars } from "../char-runs";
import { insertCharsAtPosition } from "../crdt-utils";
import { applyOp, applyOps, createEmptyPageState } from "../reducer";
import { createCRDTbinding } from "../sync";
import { describe, expect, it } from "vitest";

function visibleTexts(p: Page): string[] {
  return p.blocks
    .filter((b) => !b.deleted)
    .map((b) =>
      isTextualBlock(b)
        ? [...iterateVisibleChars(b.charRuns)].map((c) => c.char).join("")
        : "[visual]",
    );
}

describe("merge via real ops + undo", () => {
  it("undo restores both paragraphs with their content", () => {
    const binding = createCRDTbinding("merge-undo-repro", "p001");
    const pageId = binding.pageId;

    // Build initial page A="hello", B="world" via real ops so all char IDs
    // come from a single id-gen stream.
    function makeBlockInsert(
      afterBlockId: string | null,
      blockId: string,
    ): BlockInsert {
      return {
        op: "block_insert",
        id: binding.nextId(),
        clock: binding.getClock(),
        pageId,
        afterBlockId,
        blockId,
        blockType: "paragraph",
      };
    }
    function makeTextInsert(
      blockId: string,
      afterCharId: string | null,
      text: string,
    ): TextInsert {
      const firstId = binding.nextId();
      const peerId = firstId.split(":")[0];
      const startCounter = parseInt(firstId.split(":")[1], 10);
      for (let i = 1; i < text.length; i++) binding.nextId();
      return {
        op: "text_insert",
        id: binding.nextId(),
        clock: binding.getClock(),
        pageId,
        blockId,
        afterCharId,
        charRuns: [{ peerId, startCounter, text }],
      };
    }

    const aId = binding.nextId();
    const bId = binding.nextId();
    const initOps: Operation[] = [
      makeBlockInsert(null, aId),
      makeTextInsert(aId, null, "hello"),
      makeBlockInsert(aId, bId),
      makeTextInsert(bId, null, "world"),
    ];
    const initial = applyOps(createEmptyPageState(pageId), initOps);
    expect(visibleTexts(initial)).toEqual(["hello", "world"]);

    // Merge B into A through real ops: text_insert of B's content at the
    // end of A, then block_delete B — applied via applyOps.
    let pageAcc = initial;
    const mergeOps: Operation[] = [];

    const A = pageAcc.blocks.find((b) => b.id === aId)!;
    const B = pageAcc.blocks.find((b) => b.id === bId)!;
    expect(isTextualBlock(A)).toBe(true);
    expect(isTextualBlock(B)).toBe(true);
    if (!isTextualBlock(A) || !isTextualBlock(B)) return;

    const bText = [...iterateVisibleChars(B.charRuns)]
      .map((c) => c.char)
      .join("");
    const aLen = getVisibleLengthFromRuns(A.charRuns);
    const { newPage, op: insertOp } = insertCharsAtPosition(
      pageAcc,
      aId,
      aLen,
      bText,
      binding,
    );
    pageAcc = newPage;
    mergeOps.push(insertOp);

    const blockDelOp: Operation = {
      op: "block_delete",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId,
      blockId: bId,
    };
    mergeOps.push(blockDelOp);
    pageAcc = applyOps(pageAcc, [blockDelOp]);
    expect(visibleTexts(pageAcc)).toEqual(["helloworld"]);

    // Undo: invert the merge ops against the pre-merge state (the same
    // capture point recordUndoOps uses), re-stamp, and apply.
    const inverses = invertOperations(mergeOps, initial, applyOp, binding);
    const stamped = refreshOps(inverses, binding);
    const afterUndo = applyOps(pageAcc, stamped);
    expect(visibleTexts(afterUndo)).toEqual(["hello", "world"]);
  });
});
