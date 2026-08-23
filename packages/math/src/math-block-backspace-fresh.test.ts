/**
 * Backspace on a display equation the `$$` rule just created.
 *
 * The rule used to leave the FLAT compatibility cursor on the new block. A
 * materialized equation's projection is empty, so that cursor named offset zero
 * — an offset which stands for both block edges at once and carries no tree
 * position. Every leading-edge handler reads the nested caret, so the press fell
 * through to the tree handler's claimed no-op and Backspace was dead on the
 * equation you had just typed. The rule now lands the caret in the tree, the way
 * block conversion always has.
 */
import { createMathTestState, loadMathPage } from "./__testutils__/math";
import { CONVERT_STRUCTURED_BLOCK } from "@tasfer/editor/action-bus";
import { handleKeyDown } from "@tasfer/editor/events/keysEvents";
import type { EditorState, ViewportState } from "@tasfer/editor/state-types";
import { describe, expect, it } from "vitest";

const viewport: ViewportState = {
  width: 800,
  height: 600,
  scrollY: 0,
  documentHeight: 2_000,
};

/** Drive a fabricated state through the real key handler. */
function press(state: EditorState, key: string) {
  return handleKeyDown(state, viewport, {
    key,
    isTrusted: true,
    preventDefault() {},
  } as unknown as Event);
}

function types(state: EditorState) {
  return state.document.page.blocks
    .filter((b) => !b.deleted)
    .map((b) => b.type);
}

/** A paragraph, then an equation freshly made by typing `$$`. */
function freshDollarEquation(): EditorState {
  const base = createMathTestState(loadMathPage("hello"));
  let state: EditorState = {
    ...base,
    view: { ...base.view, isFocused: true },
    document: {
      ...base.document,
      cursor: { position: { blockIndex: 0, textIndex: 5 }, lastUpdate: 0 },
    },
  };
  for (const key of ["Enter", "$", "$"]) state = press(state, key).state;
  return state;
}

describe("Backspace on a just-created $$ equation", () => {
  it("lands the caret inside the tree, not on the flat projection", () => {
    const state = freshDollarEquation();
    expect(types(state)).toEqual(["paragraph", "math"]);
    expect(state.document.contentSelection).not.toBeNull();
    expect(state.document.contentSelection?.focus.blockId).toBe(
      state.document.page.blocks[1].id,
    );
    // A nested caret owns the selection outright; the flat cursor steps aside.
    expect(state.document.cursor).toBeNull();
  });

  it("selects the equation, then deletes it on the next press", () => {
    const fresh = freshDollarEquation();

    // First press is the two-step gesture's selection half — no mutation.
    const selected = press(fresh, "Backspace");
    expect(selected.ops).toHaveLength(0);
    expect(types(selected.state)).toEqual(["paragraph", "math"]);
    expect(selected.state.document.selection?.isCollapsed).toBe(false);

    // Second press removes the block itself.
    const deleted = press(selected.state, "Backspace");
    expect(deleted.ops.length).toBeGreaterThan(0);
    expect(types(deleted.state)).toEqual(["paragraph"]);
    expect(deleted.state.document.cursor?.position.blockIndex).toBe(0);
  });

  it("still deletes after the equation has held and lost a formula", () => {
    let state = freshDollarEquation();
    state = press(state, "x").state;
    state = press(state, "Backspace").state; // removes the `x`
    state = press(state, "Backspace").state; // selects the empty equation

    const deleted = press(state, "Backspace");
    expect(types(deleted.state)).toEqual(["paragraph"]);
  });

  it("matches the caret the block-conversion path already produced", () => {
    // Same block, the other way in — the two creation paths disagreed, and that
    // disagreement is what made Backspace depend on how you got there.
    const base = createMathTestState(loadMathPage("hello"));
    const converted = base.actionBus.dispatchState(
      CONVERT_STRUCTURED_BLOCK,
      base,
      { blockIndex: 0, type: "math" },
    );

    expect(converted.state.document.contentSelection).not.toBeNull();
    expect(converted.state.document.contentSelection?.focus.kind).toBe(
      freshDollarEquation().document.contentSelection?.focus.kind,
    );
  });
});
