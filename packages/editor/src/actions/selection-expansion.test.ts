import { loadPage } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import {
  EXPAND_SELECTION,
  EXPAND_SELECTION_STEP,
  nextEnclosingRange,
  SHRINK_SELECTION,
} from "./selection-expansion";
import { describe, expect, it } from "vitest";

function stateAt(markdown: string, blockIndex: number, textIndex: number) {
  const state = createInitialState(loadPage(markdown));
  return {
    ...state,
    document: {
      ...state.document,
      cursor: { position: { blockIndex, textIndex }, lastUpdate: 0 },
      selection: null,
    },
  };
}

function expand(s: EditorState) {
  return s.actionBus.dispatchState(EXPAND_SELECTION, s).state;
}
function shrink(s: EditorState) {
  return s.actionBus.dispatchState(SHRINK_SELECTION, s).state;
}

function range(s: EditorState) {
  const sel = s.document.selection;
  if (!sel || sel.isCollapsed) {
    const at = s.document.cursor!.position;
    return [at.blockIndex, at.textIndex, at.blockIndex, at.textIndex];
  }
  return [
    sel.anchor.blockIndex,
    sel.anchor.textIndex,
    sel.focus.blockIndex,
    sel.focus.textIndex,
  ];
}

describe("nextEnclosingRange", () => {
  it("picks the smallest range that strictly contains the current one", () => {
    const candidates = [
      { from: 0, to: 20 },
      { from: 4, to: 9 },
      { from: 2, to: 12 },
    ];
    expect(nextEnclosingRange(candidates, { from: 5, to: 5 })).toEqual({
      from: 4,
      to: 9,
    });
    expect(nextEnclosingRange(candidates, { from: 4, to: 9 })).toEqual({
      from: 2,
      to: 12,
    });
    expect(nextEnclosingRange(candidates, { from: 0, to: 20 })).toBeNull();
  });
});

describe("expand selection — default ladder", () => {
  const PAGE = "hello brave world\n\nsecond line";

  it("climbs word → block → document, then stays", () => {
    const s0 = stateAt(PAGE, 0, 8);
    const s1 = expand(s0);
    expect(range(s1)).toEqual([0, 6, 0, 11]);
    const s2 = expand(s1);
    expect(range(s2)).toEqual([0, 0, 0, 17]);
    const s3 = expand(s2);
    expect(range(s3)).toEqual([0, 0, s0.document.page.blocks.length - 1, 11]);
    const s4 = expand(s3);
    expect(range(s4)).toEqual(range(s3));
  });

  it("takes the word the caret just left when it rests after one", () => {
    expect(range(expand(stateAt(PAGE, 0, 5)))).toEqual([0, 0, 0, 5]);
  });

  it("skips the word rung on whitespace with no word beside it", () => {
    expect(range(expand(stateAt("a  b", 0, 2)))).toEqual([0, 0, 0, 4]);
  });

  it("emits no ops", () => {
    const s0 = stateAt(PAGE, 0, 8);
    expect(s0.actionBus.dispatchState(EXPAND_SELECTION, s0).ops).toEqual([]);
  });
});

describe("shrink selection", () => {
  const PAGE = "hello brave world\n\nsecond line";

  it("walks back down exactly the rungs expand climbed", () => {
    const s0 = stateAt(PAGE, 0, 8);
    const s3 = expand(expand(expand(s0)));
    const back2 = shrink(s3);
    expect(range(back2)).toEqual([0, 0, 0, 17]);
    const back1 = shrink(back2);
    expect(range(back1)).toEqual([0, 6, 0, 11]);
    const back0 = shrink(back1);
    expect(range(back0)).toEqual([0, 8, 0, 8]);
    expect(back0.document.selection?.isCollapsed ?? true).toBe(true);
    // Nothing left to walk back to.
    expect(shrink(back0)).toBe(back0);
  });

  it("re-expanding after a shrink continues the same ladder", () => {
    const s0 = stateAt(PAGE, 0, 8);
    const s2 = expand(expand(s0));
    const again = expand(shrink(s2));
    expect(range(again)).toEqual([0, 0, 0, 17]);
    expect(range(shrink(shrink(again)))).toEqual([0, 8, 0, 8]);
  });

  it("does nothing once the selection moved some other way", () => {
    const s1 = expand(stateAt(PAGE, 0, 8));
    const moved: EditorState = {
      ...s1,
      document: {
        ...s1.document,
        cursor: { position: { blockIndex: 1, textIndex: 2 }, lastUpdate: 0 },
        selection: null,
      },
    };
    expect(shrink(moved)).toBe(moved);
  });

  it("does nothing once the page changed", () => {
    const s1 = expand(stateAt(PAGE, 0, 8));
    const edited: EditorState = {
      ...s1,
      document: { ...s1.document, page: { ...s1.document.page } },
    };
    expect(shrink(edited)).toBe(edited);
  });

  it("does nothing with no expand behind it", () => {
    const s0 = stateAt(PAGE, 0, 8);
    expect(shrink(s0)).toBe(s0);
  });
});

describe("expand selection — node rungs", () => {
  it("a node claiming the step puts its rung ahead of the default ladder", () => {
    const s0 = stateAt("hello brave world", 0, 8);
    const off = s0.actionBus.registerState(
      EXPAND_SELECTION_STEP,
      (state) => {
        const sel = state.document.selection;
        if (sel && !sel.isCollapsed) return;
        const at = { blockIndex: 0, textIndex: 7 };
        const to = { blockIndex: 0, textIndex: 9 };
        return {
          state: {
            ...state,
            document: {
              ...state.document,
              selection: {
                anchor: at,
                focus: to,
                isForward: true,
                isCollapsed: false,
              },
            },
          },
          ops: [],
          handled: true,
        };
      },
      50,
    );
    const s1 = expand(s0);
    expect(range(s1)).toEqual([0, 7, 0, 9]);
    // Unclaimed on the next press: the default ladder carries on from there.
    expect(range(expand(s1))).toEqual([0, 6, 0, 11]);
    expect(range(shrink(expand(s1)))).toEqual([0, 7, 0, 9]);
    off();
  });
});
