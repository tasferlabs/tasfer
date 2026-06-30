/**
 * Characters the tex engine can't render (Arabic, CJK, emoji) must be discarded
 * on input in math content rather than committed to the CRDT. Left in, they lay
 * out as zero-width, caret-less glyphs — invisible "latent" source the user can
 * neither see nor delete. Renderable characters are unaffected.
 */
import { insertText } from "../actions/actions";
import { moveCursorToPosition } from "../selection";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { insertCharsAtPosition } from "../sync/crdt-utils";
import { createCRDTbinding, createSyncEngine } from "../sync/sync";
import { describe, expect, it } from "vitest";

/** A block-equation editor state holding `latex`, with the caret at `caret`. */
function mathState(latex: string, caret: number) {
  const binding = createCRDTbinding("math-latent", "peer-1");
  const engine = createSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "math", { displayMode: true });
  engine.emit([blockOp]);
  const blockId = blockOp.blockId;
  let page = engine.getState();
  if (latex) {
    page = insertCharsAtPosition(page, blockId, 0, latex, binding).newPage;
  }
  let state = createInitialState(page, { crdtBinding: binding });
  state = moveCursorToPosition(state, 0, caret);
  return { state, blockId };
}

function latexOf(state: EditorState) {
  return getVisibleTextFromRuns(state.document.page.blocks[0].charRuns);
}

describe("math latent-character guard", () => {
  it("discards an unrenderable character typed into a formula", () => {
    const { state } = mathState("x", 1);
    for (const ch of ["ع", "中", "😀"]) {
      const after = insertText(state, ch).state;
      expect(latexOf(after)).toBe("x"); // nothing committed
    }
  });

  it("strips unrenderable characters from a mixed insertion, keeping the rest", () => {
    const { state } = mathState("", 0);
    const after = insertText(state, "aعb").state;
    expect(latexOf(after)).toBe("ab");
  });

  it("still inserts renderable characters normally", () => {
    const { state } = mathState("x", 1);
    const after = insertText(state, "y").state;
    expect(latexOf(after)).toBe("xy");
  });
});
