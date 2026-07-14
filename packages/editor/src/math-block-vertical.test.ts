/**
 * Vertical caret navigation *inside a block (display) equation*. A `$$…$$`
 * math block owns no flat text — its content is the block-authority tree — so
 * the caret lives in nested ContentPoints, and ArrowUp / ArrowDown must
 * descend through the equation's stacked construct slots (a fraction's
 * halves, a super/subscript pair) before exiting to the neighbouring blocks.
 * These drive the real MOVE_CURSOR_UP/DOWN actions over a fabricated state
 * (no canvas mount).
 */
import { createMathTestState, loadMathPage } from "./__testutils__/math";
import { MOVE_CURSOR_DOWN, MOVE_CURSOR_UP } from "./actions/keyboard-actions";
import {
  getMathStructuredDocument,
  getStructuredMathSource,
  structuredToMathDocument,
} from "./math/structured";
import {
  contentPointToMathTreeCaret,
  mathContentSelectionFromSourceOffset,
} from "./math/tree-selection";
import type { EditorState, ViewportState } from "./state-types";
import { updateContentSelection } from "./structured-selection";
import { describe, expect, it } from "vitest";

const viewport: ViewportState = {
  width: 800,
  height: 600,
  scrollY: 0,
  documentHeight: 2_000,
};

// Nested caret at a LaTeX source offset of the equation in `blockIndex`.
function placeTreeCaret(
  state: EditorState,
  blockIndex: number,
  sourceOffset: number,
): EditorState {
  const block = state.document.page.blocks[blockIndex];
  const document = getMathStructuredDocument(block);
  if (!document) throw new Error("expected a block-authority math document");
  const selection = mathContentSelectionFromSourceOffset(
    block.id,
    document.rootId,
    document,
    sourceOffset,
  );
  if (!selection) {
    throw new Error(`no tree caret at source offset ${sourceOffset}`);
  }
  return updateContentSelection(state, selection);
}

// The identity row the caret currently rests in.
function focusRowId(state: EditorState, blockIndex: number): string {
  const focus = state.document.contentSelection?.focus;
  const document = getMathStructuredDocument(
    state.document.page.blocks[blockIndex],
  );
  if (!focus || !document) throw new Error("expected a nested caret");
  const caret = contentPointToMathTreeCaret(document, focus);
  if (!caret) throw new Error("expected a resolvable tree caret");
  return caret.rowId;
}

describe("block math — vertical caret navigation", () => {
  it("moves from the numerator down into the denominator and back", () => {
    const f = "\\frac{a}{b}";
    const s = createMathTestState(loadMathPage(`$$\n${f}\n$$`));
    const document = getMathStructuredDocument(s.document.page.blocks[0]);
    const math = document ? structuredToMathDocument(document) : undefined;
    const fraction = math?.root.body.children[0];
    if (!fraction || fraction.type !== "fraction") {
      throw new Error("expected a structured fraction");
    }

    const inNumerator = placeTreeCaret(s, 0, f.indexOf("{a}") + 2);
    expect(focusRowId(inNumerator, 0)).toBe(fraction.numerator.id);
    const down = inNumerator.actionBus.dispatchState(
      MOVE_CURSOR_DOWN,
      inNumerator,
      { viewport },
    );
    expect(down.claimed).toBe(true);
    expect(focusRowId(down.state, 0)).toBe(fraction.denominator.id);

    const inDenominator = placeTreeCaret(s, 0, f.indexOf("{b}") + 2);
    const up = inDenominator.actionBus.dispatchState(
      MOVE_CURSOR_UP,
      inDenominator,
      { viewport },
    );
    expect(up.claimed).toBe(true);
    expect(focusRowId(up.state, 0)).toBe(fraction.numerator.id);
  });

  it("moves from a superscript down into the subscript (over the base)", () => {
    const s = createMathTestState(loadMathPage("$$\nx^2_3\n$$"));
    const document = getMathStructuredDocument(s.document.page.blocks[0]);
    const math = document ? structuredToMathDocument(document) : undefined;
    const scripts = math?.root.body.children[0];
    if (
      !scripts ||
      scripts.type !== "scripts" ||
      !scripts.superscript ||
      !scripts.subscript
    ) {
      throw new Error("expected a scripts node with both slots");
    }
    // Caret offsets address the canonical printed source (`{x}_{3}^{2}`),
    // not the typed input.
    const f = getStructuredMathSource(s.document.page.blocks[0])!;

    const inSup = placeTreeCaret(s, 0, f.indexOf("2") + 1);
    expect(focusRowId(inSup, 0)).toBe(scripts.superscript.id);
    const down = inSup.actionBus.dispatchState(MOVE_CURSOR_DOWN, inSup, {
      viewport,
    });
    expect(focusRowId(down.state, 0)).toBe(scripts.subscript.id);

    const inSub = placeTreeCaret(s, 0, f.indexOf("3") + 1);
    const up = inSub.actionBus.dispatchState(MOVE_CURSOR_UP, inSub, {
      viewport,
    });
    expect(focusRowId(up.state, 0)).toBe(scripts.superscript.id);
  });

  it("exits the block when there is no row beyond the edge slot", () => {
    // Surrounding paragraphs give both arrows somewhere to land.
    const f = "\\frac{a}{b}";
    const s = createMathTestState(
      loadMathPage(`intro\n\n$$\n${f}\n$$\n\ntail`),
    );
    const mathIndex = s.document.page.blocks.findIndex(
      (block) => getMathStructuredDocument(block) !== undefined,
    );

    // ↓ from the denominator (bottom slot) leaves the math block for `tail`.
    const inDenominator = placeTreeCaret(s, mathIndex, f.indexOf("{b}") + 2);
    const down = inDenominator.actionBus.dispatchState(
      MOVE_CURSOR_DOWN,
      inDenominator,
      { viewport },
    );
    expect(down.state.document.contentSelection).toBeNull();
    expect(down.state.document.cursor?.position.blockIndex).toBeGreaterThan(
      mathIndex,
    );

    // ↑ from the numerator (top slot) leaves upward for `intro`.
    const inNumerator = placeTreeCaret(s, mathIndex, f.indexOf("{a}") + 2);
    const up = inNumerator.actionBus.dispatchState(
      MOVE_CURSOR_UP,
      inNumerator,
      { viewport },
    );
    expect(up.state.document.contentSelection).toBeNull();
    expect(up.state.document.cursor?.position.blockIndex).toBeLessThan(
      mathIndex,
    );
  });
});
