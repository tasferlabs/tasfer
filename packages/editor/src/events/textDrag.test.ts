/**
 * HTML5 text drag-and-drop.
 *
 * The gesture belongs to the browser, so what is pinned here is the editor's
 * side of the contract:
 *
 *  - {@link DROP_TEXT} / {@link REMOVE_DRAGGED_TEXT}, the document edits a drop
 *    commits. A move is a delete plus an insert in one transaction, which means
 *    the drop position has to be re-pointed across the deletion — the case that
 *    silently corrupts a backwards drag if it is wrong.
 *  - the transfer plumbing: what goes on a starting drag, which drags are ours
 *    to accept, and the copy-vs-move effect reported back to the browser.
 *
 * Horizontal text measurement is not exact in this environment, so positions
 * are driven through the actions directly rather than resolved from pixels.
 */

import { convertBlockAtCursor } from "../actions/actions";
import {
  type DragRange,
  DROP_TEXT,
  REMOVE_DRAGGED_TEXT,
} from "../actions/drag-actions";
import { getBlockHeight } from "../rendering/renderer";
import { loadPage } from "../serlization/loadPage";
import type { EditorState, Position } from "../state-types";
import { createInitialState } from "../state-utils";
import { getEditorStyles } from "../styles";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { getVisibleBlocks } from "../sync/reducer";
import {
  dragOrigin,
  type DragTransfer,
  dropEffectFor,
  dropTargetAt,
  isTextDrag,
  loadTextDrag,
  readTextDrop,
  TASFER_TEXT_DRAG_TYPE,
} from "./dragEvents";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  const d = (globalThis as unknown as { document: Record<string, unknown> })
    .document;
  if (!d.body) d.body = { appendChild: () => {}, removeChild: () => {} };
});

function texts(state: EditorState): string[] {
  return getVisibleBlocks(state.document.page).map((block) =>
    getVisibleTextFromRuns(
      (block as { charRuns?: Parameters<typeof getVisibleTextFromRuns>[0] })
        .charRuns,
    ),
  );
}

function select(
  state: EditorState,
  anchor: Position,
  focus: Position,
): EditorState {
  return {
    ...state,
    document: {
      ...state.document,
      cursor: { position: focus, lastUpdate: Date.now() },
      selection: {
        anchor,
        focus,
        isForward: true,
        isCollapsed: false,
        lastUpdate: Date.now(),
      },
    },
  };
}

/** An in-memory stand-in for the browser's `DataTransfer`. */
function transfer(initial: Record<string, string> = {}): DragTransfer {
  const data: Record<string, string> = { ...initial };
  return {
    get types() {
      return Object.keys(data);
    },
    effectAllowed: "uninitialized",
    dropEffect: "none",
    setData(format, value) {
      data[format] = value;
    },
    getData(format) {
      return data[format] ?? "";
    },
  };
}

/** Round-trip a selection through a drag transfer and drop it at `target`. */
function dragAndDrop(
  state: EditorState,
  target: Position,
  { copy = false }: { copy?: boolean } = {},
) {
  const dt = transfer();
  const source = loadTextDrag(state, dt);
  expect(source).not.toBeNull();
  const payload = readTextDrop(dt);
  expect(payload).not.toBeNull();
  return state.actionBus.dispatchState(DROP_TEXT, state, {
    source: copy ? null : source,
    target: { kind: "text", position: target },
    payload: payload!,
  });
}

describe("dropping text", () => {
  it("moves a word forward within its block", () => {
    // "alpha " (0–6) dropped at the end of "alpha bravo charlie" (19).
    const state = select(
      createInitialState(loadPage("alpha bravo charlie")),
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 0, textIndex: 6 },
    );

    const result = dragAndDrop(state, { blockIndex: 0, textIndex: 19 });

    expect(texts(result.state)).toEqual(["bravo charliealpha "]);
    expect(result.ops.length).toBeGreaterThan(0);
  });

  it("moves a word backward within its block", () => {
    // The regression that made a backwards drag land on the deletion's caret
    // instead of the target: a target BEFORE the removed span never moves.
    const state = select(
      createInitialState(loadPage("alpha bravo charlie")),
      { blockIndex: 0, textIndex: 12 },
      { blockIndex: 0, textIndex: 19 },
    );

    const result = dragAndDrop(state, { blockIndex: 0, textIndex: 0 });

    expect(texts(result.state)).toEqual(["charliealpha bravo "]);
  });

  it("leaves the dropped text selected", () => {
    const state = select(
      createInitialState(loadPage("alpha bravo")),
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 0, textIndex: 6 },
    );

    const selection = dragAndDrop(state, { blockIndex: 0, textIndex: 11 }).state
      .document.selection;

    expect(selection?.isCollapsed).toBe(false);
    expect(selection?.anchor).toEqual({ blockIndex: 0, textIndex: 5 });
    expect(selection?.focus).toEqual({ blockIndex: 0, textIndex: 11 });
  });

  it("copies without removing the original", () => {
    const state = select(
      createInitialState(loadPage("alpha bravo")),
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 0, textIndex: 6 },
    );

    const result = dragAndDrop(
      state,
      { blockIndex: 0, textIndex: 11 },
      { copy: true },
    );

    expect(texts(result.state)).toEqual(["alpha bravoalpha "]);
  });

  it("moves text into a later block", () => {
    const base = createInitialState(loadPage("one\n\ntwo\n\nthree"));
    // Blank lines between paragraphs are blocks of their own here.
    expect(texts(base)).toEqual(["one", "", "two", "", "three"]);
    const state = select(
      base,
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 0, textIndex: 3 },
    );

    const result = dragAndDrop(state, { blockIndex: 4, textIndex: 5 });

    expect(texts(result.state)).toEqual(["", "", "two", "", "threeone"]);
  });

  it("refuses a move onto the text being dragged", () => {
    const state = select(
      createInitialState(loadPage("alpha bravo charlie")),
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 0, textIndex: 11 },
    );

    const result = dragAndDrop(state, { blockIndex: 0, textIndex: 5 });

    expect(texts(result.state)).toEqual(["alpha bravo charlie"]);
    expect(result.ops).toEqual([]);
  });

  it("inserts a drag that came from outside, with no source to remove", () => {
    const state = createInitialState(loadPage("host"));

    const result = state.actionBus.dispatchState(DROP_TEXT, state, {
      source: null,
      target: { kind: "text", position: { blockIndex: 0, textIndex: 4 } },
      payload: { plainText: "ed", html: "", markdown: "ed" },
    });

    expect(texts(result.state)).toEqual(["hosted"]);
  });
});

describe("where a drop would land", () => {
  const viewport = {
    scrollY: 0,
    width: 800,
    height: 600,
    documentHeight: 600,
  };

  /** A document whose second block is a horizontal rule. */
  function withRule(): EditorState {
    const state = createInitialState(loadPage("alpha\n\nbravo"));
    const withCursor = {
      ...state,
      document: {
        ...state.document,
        cursor: {
          position: { blockIndex: 1, textIndex: 0 },
          lastUpdate: Date.now(),
        },
      },
    };
    const converted = convertBlockAtCursor(withCursor, { type: "line" }).state;
    // Actions edit the document; the visible-block projection the hit-test walks
    // is refreshed by the render loop, which no test runs.
    return {
      ...converted,
      view: {
        ...converted.view,
        visibleBlocks: getVisibleBlocks(converted.document.page),
      },
    };
  }

  /** The vertical middle of the block at `index`. Only heights, no measurement. */
  function midpointOf(state: EditorState, index: number) {
    const styles = getEditorStyles(state);
    const maxWidth =
      viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
    let top = styles.canvas.paddingTop;
    for (let at = 0; at < index; at++) {
      top += getBlockHeight(
        state.nodes,
        state.marks,
        state.view.visibleBlocks[at],
        maxWidth,
        styles,
        at === 0,
      );
    }
    const height = getBlockHeight(
      state.nodes,
      state.marks,
      state.view.visibleBlocks[index],
      maxWidth,
      styles,
      index === 0,
    );
    return { x: styles.canvas.paddingLeft + 1, y: top + height / 2 };
  }

  it("takes a drop over ordinary text", () => {
    const state = createInitialState(loadPage("alpha\n\nbravo"));
    const { x, y } = midpointOf(state, 0);

    expect(dropTargetAt(state, viewport, x, y, undefined, null)).toEqual({
      kind: "text",
      position: { blockIndex: 0, textIndex: expect.any(Number) },
    });
  });

  it("refuses a block that holds no text to insert into", () => {
    // The flat walk answers with the rule's own index and offset 0, which used
    // to be dropped into: the text was removed from its source and inserted
    // into text the block does not have, i.e. lost.
    const state = withRule();
    const { x, y } = midpointOf(state, 1);

    expect(state.view.visibleBlocks[1].type).toBe("line");
    expect(dropTargetAt(state, viewport, x, y, undefined, null)).toBeNull();
  });
});

describe("REMOVE_DRAGGED_TEXT", () => {
  it("removes the range a drag carried out of the document", () => {
    const state = createInitialState(loadPage("alpha bravo"));
    const source: DragRange = {
      start: { blockIndex: 0, textIndex: 0 },
      end: { blockIndex: 0, textIndex: 6 },
    };

    const result = state.actionBus.dispatchState(REMOVE_DRAGGED_TEXT, state, {
      source,
    });

    expect(texts(result.state)).toEqual(["bravo"]);
    expect(result.ops.length).toBeGreaterThan(0);
  });
});

describe("the drag transfer", () => {
  it("offers both flavors plus a private marker, and allows copy or move", () => {
    const state = select(
      createInitialState(loadPage("alpha bravo")),
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 0, textIndex: 5 },
    );
    const dt = transfer();

    expect(loadTextDrag(state, dt)).toEqual({
      start: { blockIndex: 0, textIndex: 0 },
      end: { blockIndex: 0, textIndex: 5 },
    });
    expect(dt.getData("text/plain")).toBe("alpha");
    expect(dt.getData("text/html")).not.toBe("");
    expect(dt.types).toContain(TASFER_TEXT_DRAG_TYPE);
    expect(dt.effectAllowed).toBe("copyMove");
  });

  it("declines to start when nothing is selected", () => {
    const state = createInitialState(loadPage("alpha bravo"));
    expect(loadTextDrag(state, transfer())).toBeNull();
  });

  it("accepts text drags and leaves file drags to the host", () => {
    const state = createInitialState(loadPage("alpha"));
    expect(isTextDrag(transfer({ "text/plain": "x" }), state)).toBe(true);
    expect(isTextDrag(transfer({ [TASFER_TEXT_DRAG_TYPE]: "1" }), state)).toBe(
      true,
    );
    expect(isTextDrag(transfer({ Files: "", "text/plain": "x" }), state)).toBe(
      false,
    );
    expect(isTextDrag(null, state)).toBe(false);
  });

  it("refuses any drop into a read-only document", () => {
    const readonly = createInitialState(loadPage("alpha"), {
      mode: "readonly",
    });
    expect(isTextDrag(transfer({ "text/plain": "x" }), readonly)).toBe(false);
  });

  it("tells a Tasfer drag apart from one that came from another app", () => {
    const own = transfer({ [TASFER_TEXT_DRAG_TYPE]: "1" });
    expect(dragOrigin(own, true)).toBe("self");
    expect(dragOrigin(own, false)).toBe("tasfer");
    expect(dragOrigin(transfer({ "text/plain": "x" }), false)).toBe("external");
  });

  it("only offers to move text some editor here owns", () => {
    const plain = { altKey: false, ctrlKey: false };
    expect(dropEffectFor("self", plain)).toBe("move");
    // Another editor on the page removes its own original on `dragend`, so a
    // drag between two editors is a real move.
    expect(dropEffectFor("tasfer", plain)).toBe("move");
    // Text from another application has no original we may remove.
    expect(dropEffectFor("external", plain)).toBe("copy");
    // The copy modifier is platform-specific; whichever this platform uses,
    // holding it turns the move into a copy.
    expect(dropEffectFor("self", { altKey: true, ctrlKey: true })).toBe("copy");
  });

  it("reads nothing back from a transfer carrying no text", () => {
    expect(readTextDrop(transfer())).toBeNull();
  });
});
