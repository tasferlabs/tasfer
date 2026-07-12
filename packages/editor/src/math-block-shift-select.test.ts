/**
 * Regression: Shift+ArrowUp / Shift+ArrowDown must not get *stuck* at a block
 * equation while extending a selection.
 *
 * A `$$…$$` block is textual, and a bare caret navigates its stacked construct
 * rows (a fraction's halves) before leaving the block — see
 * `math-block-vertical.test.ts`. But when a Shift+Arrow *extends a range* across
 * the block, descending into those rows is a trap: a selection may not partially
 * cover a construct, so {@link snapSelectionToConstructs} snaps the interior
 * offset the row-step lands on straight back to the construct/block edge, and the
 * focus then oscillates on that edge, press after press, never advancing past the
 * equation. `moveCursorUp`/`moveCursorDown` now skip intra-block row navigation
 * while a non-collapsed selection is being extended, so the focus escapes the
 * block by ordinary line/block navigation instead.
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

  it("a selection begun *inside* the fraction still escapes downward", () => {
    // Anchor inside the numerator: the first Shift+Down selects the whole
    // fraction (via the construct snap); the next must leave the block, not bounce.
    const numOff = "\\frac{a}{b}".indexOf("{a}") + 1;
    const s = place(createMathTestState(loadMathPage(PAGE)), 2, numOff);
    extendUntilBlock(s, "down", 4);
  });

  it("a bare-caret ArrowDown still descends the fraction's rows (no selection)", () => {
    // The fix must NOT affect a lone caret: it clears any selection first, so
    // intra-block row navigation is preserved (numerator → denominator).
    const f = "\\frac{a}{b}";
    const aOff = f.indexOf("{a}") + 1;
    const bOff = f.indexOf("{b}") + 1;
    const s = place(createMathTestState(loadMathPage(`$$${f}$$`)), 0, aOff);
    const down = moveCursorDown(s);
    expect(down.document.cursor?.position.blockIndex).toBe(0);
    expect(down.document.cursor?.position.textIndex).toBeGreaterThanOrEqual(
      bOff,
    );
  });
});
