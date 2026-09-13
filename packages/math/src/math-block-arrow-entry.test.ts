/**
 * ArrowUp / ArrowDown into a display equation from a neighbouring block.
 *
 * Core's line mover only sees the equation's empty compatibility projection, so
 * it used to park a flat cursor on the block with no nested caret. Backspace
 * there fell through to the tree handler's claimed no-op — arrowing onto an
 * empty equation and pressing Backspace did nothing, while clicking into it
 * selected it. Vertical entry now lands a real tree caret, like a click does.
 */
import { createMathTestState, loadMathPage } from "./__testutils__/math";
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

/** `hello`, an empty `$$` equation, then trailing prose. */
function emptyEquationBetweenProse(): EditorState {
  const base = createMathTestState(loadMathPage("hello\n\nworld"));
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

describe("vertical arrow entry into a display equation", () => {
  it.each([
    ["ArrowDown from the block above", ["ArrowUp", "ArrowDown"]],
    ["ArrowUp from the block below", ["ArrowDown", "ArrowUp"]],
  ])(
    "%s lands a tree caret, and Backspace removes the empty equation",
    (_, keys) => {
      let state = emptyEquationBetweenProse();
      const mathId = state.document.page.blocks[1].id;
      expect(types(state)[1]).toBe("math");

      state = press(state, keys[0]).state;
      expect(state.document.contentSelection).toBeNull();
      state = press(state, keys[1]).state;
      expect(state.document.contentSelection?.focus.blockId).toBe(mathId);
      expect(state.document.cursor).toBeNull();

      // Two-step gesture: select the block, then delete it.
      const selected = press(state, "Backspace");
      expect(selected.ops).toHaveLength(0);
      expect(selected.state.document.selection?.isCollapsed).toBe(false);
      const deleted = press(selected.state, "Backspace");
      expect(types(deleted.state)).not.toContain("math");
    },
  );

  it("does not touch vertical moves between prose blocks", () => {
    const base = createMathTestState(loadMathPage("one\ntwo"));
    const state: EditorState = {
      ...base,
      view: { ...base.view, isFocused: true },
      document: {
        ...base.document,
        cursor: { position: { blockIndex: 0, textIndex: 2 }, lastUpdate: 0 },
      },
    };
    const moved = press(state, "ArrowDown").state;
    expect(moved.document.contentSelection).toBeNull();
    expect(moved.document.cursor?.position.blockIndex).toBe(1);
  });
});
