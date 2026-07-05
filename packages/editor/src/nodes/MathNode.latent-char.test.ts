/**
 * Text the math fonts can't render (Arabic, CJK, emoji) is wrapped into a
 * `\text{…}` run on input — the host font typesets it (see `@cypherkit/tex`'s
 * text fallback) — instead of being committed bare, where it would lay out as a
 * zero-width, caret-less "latent" glyph. Code points that are neither math nor
 * real text (control/format chars) are still discarded. Renderable math
 * characters are unaffected.
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
  it("wraps a text character (Arabic, CJK, emoji) into a \\text run", () => {
    for (const ch of ["ع", "中", "😀"]) {
      const { state } = mathState("x", 1);
      const after = insertText(state, ch).state;
      // Committed as \text{…} (host-font typeset), not dropped as a latent glyph.
      expect(latexOf(after)).toBe(`x\\text{${ch}}`);
    }
  });

  it("still discards a code point that is neither math nor text (control/format)", () => {
    const { state } = mathState("x", 1);
    // U+200B ZERO WIDTH SPACE — no math glyph, and not real text → dropped.
    const after = insertText(state, "\u200B").state;
    expect(latexOf(after)).toBe("x");
  });

  it("strips unrenderable characters from a mixed insertion, keeping the rest", () => {
    // A mixed math+text burst (rare outside IME) takes the math path, which keeps
    // the math-renderable chars and drops the rest — it is not wrapped.
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
