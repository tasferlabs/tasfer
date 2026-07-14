/**
 * Regression: Shift+ArrowUp / Shift+ArrowDown must not get *stuck* at a block
 * equation while extending a selection.
 *
 * A `$$…$$` block owns no flat text — a flat selection covers it whole, as an
 * atomic block. A Shift+Arrow extending a range across it must therefore step
 * past the equation by ordinary line/block navigation, never descending into
 * the equation's construct rows (nested content selections are a separate,
 * per-equation caret model — see `math-block-vertical.test.ts`). The bug this
 * guards against: a vertical step that lands inside the block and then snaps
 * back to its edge oscillates there press after press, never advancing.
 *
 * These drive the real EXTEND_SELECTION path: `moveCursorUp`/`moveCursorDown`
 * over a state that carries a selection, then commit the focus exactly as the
 * `EXTEND_SELECTION_UP`/`_DOWN` actions do (`updateSelectionFocus`).
 */
import { createMathTestState, loadMathPage } from "./__testutils__/math";
import {
  moveCursorDown,
  moveCursorUp,
  startSelection,
  updateSelectionFocus,
} from "./selection";
import type { EditorState, Position } from "./state-types";
import { describe, expect, it } from "vitest";

function place(s: EditorState, blockIndex: number, textIndex: number) {
  return {
    ...s,
    document: {
      ...s.document,
      cursor: { position: { blockIndex, textIndex }, lastUpdate: 0 },
      selection: null,
    },
  };
}

// One Shift+Arrow: mirrors EXTEND_SELECTION_UP / _DOWN — start a selection if
// there is none, move the caret, then commit that as the new selection focus.
function extend(s: EditorState, dir: "up" | "down"): EditorState {
  const base = s.document.selection
    ? s
    : startSelection(s, s.document.cursor!.position);
  const moved = dir === "up" ? moveCursorUp(base) : moveCursorDown(base);
  if (!moved.document.cursor) return base;
  return updateSelectionFocus(moved, moved.document.cursor.position);
}

function focus(s: EditorState): Position {
  return s.document.selection!.focus;
}

// Repeatedly extend `dir` and assert the focus reaches `targetBlock` without ever
// revisiting a position (a repeat is the "stuck"/oscillation bug).
function extendUntilBlock(
  s: EditorState,
  dir: "up" | "down",
  targetBlock: number,
) {
  const seen = new Set<string>();
  let cur = s;
  for (let i = 0; i < 40; i++) {
    cur = extend(cur, dir);
    const f = focus(cur);
    const key = `${f.blockIndex}:${f.textIndex}`;
    if (f.blockIndex === targetBlock) return; // escaped past the equation
    expect(seen.has(key), `oscillated at ${key} after ${i} steps`).toBe(false);
    seen.add(key);
  }
  throw new Error(`never reached block ${targetBlock} extending ${dir}`);
}

describe("block math — Shift+Arrow selection never sticks", () => {
  // `\frac{a}{b}` is the trap shape: from a block edge, a vertical step re-enters
  // the fraction's other slot, and the snap bounces it back — the oscillation.
  const PAGE = "above\n\n$$\\frac{a}{b}$$\n\nbelow";

  it("Shift+ArrowDown from above extends through the equation into the block below", () => {
    const s = place(createMathTestState(loadMathPage(PAGE)), 0, 0);
    expect(s.document.page.blocks[2].type).toBe("math");
    // Blocks: 0 para, 1 para, 2 math, 3 para, 4 para. Escape means the focus
    // gets past the math block (index > 2).
    extendUntilBlock(s, "down", 4);
  });

  it("Shift+ArrowUp from below extends through the equation into the block above", () => {
    const s = place(createMathTestState(loadMathPage(PAGE)), 4, 5);
    expect(s.document.page.blocks[2].type).toBe("math");
    extendUntilBlock(s, "up", 0);
  });
});
