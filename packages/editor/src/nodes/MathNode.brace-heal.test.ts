/**
 * Brace auto-heal for block equations: an unclosed grouping `{` makes its group
 * run to the end of the source, so every trailing offset sits INSIDE the open
 * group and the caret can never rest after the construct — nothing can be typed
 * to its right (the reported "can't add content on the right"). Well-formed
 * editing never produces this (typed braces escape to `\{`/`\}`, materialization
 * inserts balanced pairs), so it only enters through pasted / imported source.
 * The math node closes the dangling groups as CRDT ops on the next edit (and on
 * import), restoring the missing right-side caret stop. Render-neutral.
 */
import { insertText } from "../actions/actions";
import { DELETE_BACKWARD } from "../actions/edit-actions";
import { moveCursorToPosition } from "../selection";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { insertCharsAtPosition } from "../sync/crdt-utils";
import { createCRDTbinding, createSyncEngine } from "../sync/sync";
import { mathBalancedLatex, mathCaretStep } from "./math";
import { describe, expect, it } from "vitest";

/** A block-equation editor state holding `latex`, with the caret at `caret`. */
function mathState(latex: string, caret: number) {
  const binding = createCRDTbinding("math-brace-heal", "peer-1");
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

function latexOf(state: EditorState, blockIndex = 0) {
  return getVisibleTextFromRuns(
    state.document.page.blocks[blockIndex].charRuns,
  );
}

const BROKEN = "\\frac{a}{b}+\\sqrt{H}-\\frac{aaaa}{bbbb+\\frac{a}{b}";

describe("block-equation brace auto-heal", () => {
  it("appends the missing } when typing inside an imbalanced equation", () => {
    // Caret in the open denominator (`…bbbb+…`), type a char there.
    const { state } = mathState(
      BROKEN,
      "\\frac{a}{b}+\\sqrt{H}-\\frac{aaaa}{bbbb".length,
    );
    const after = insertText(state, "c").state;
    const healed = latexOf(after);

    // The typed char landed in the denominator AND the dangling group closed.
    expect(healed).toBe(
      "\\frac{a}{b}+\\sqrt{H}-\\frac{aaaa}{bbbbc+\\frac{a}{b}}",
    );
    // Braces are now balanced.
    const open = (healed.match(/(?<!\\)\{/g) ?? []).length;
    const close = (healed.match(/(?<!\\)\}/g) ?? []).length;
    expect(open).toBe(close);
  });

  it("restores a caret stop PAST the whole fraction (the right-side exit)", () => {
    const { state } = mathState(BROKEN, BROKEN.length);
    // Type at the end (inside the open group), which heals the equation.
    const after = insertText(state, "x").state;
    const healed = latexOf(after);
    const block = after.document.page.blocks[0];

    // There is now a top-level caret position at the very end, and stepping right
    // from just before the trailing `}` reaches it — i.e. you can get outside the
    // fraction. Before the heal the source end sat inside the open group with no
    // stop beyond it.
    expect(healed.endsWith("}")).toBe(true);
    const beforeClose = healed.length - 1;
    expect(mathCaretStep(block, beforeClose, "right")).toBe(healed.length);
  });

  it("heals on delete too (any edit balances the block)", () => {
    // Backspace somewhere harmless (the trailing `b`'s leaf) still triggers the
    // delete-path heal, closing the dangling denominator group.
    const { state } = mathState(BROKEN, BROKEN.length);
    const after = state.actionBus.dispatchState(DELETE_BACKWARD, state).state;
    const healed = latexOf(after);
    const open = (healed.match(/(?<!\\)\{/g) ?? []).length;
    const close = (healed.match(/(?<!\\)\}/g) ?? []).length;
    expect(open).toBe(close);
  });

  it("leaves a balanced equation untouched", () => {
    const good = "\\frac{a}{b}+1";
    const { state } = mathState(good, good.length);
    const after = insertText(state, "2").state;
    expect(latexOf(after)).toBe("\\frac{a}{b}+12");
  });

  it("import heals unbalanced source (mathBalancedLatex)", () => {
    expect(mathBalancedLatex(BROKEN)).toBe(BROKEN + "}");
    expect(mathBalancedLatex("\\frac{a}{b}")).toBe("\\frac{a}{b}");
  });
});
