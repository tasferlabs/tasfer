/**
 * A recomposition (a keyboard that reopened the word before the caret) while
 * a peer edits the same word. Two real replicas, each applying the other's
 * ops. Whichever edit reaches a replica first, both must end with the same
 * text, and nobody's letters may be dropped: the keyboard's change is merged
 * by character id, exactly as it would have merged had it landed first.
 */
import "../entries/editor";
import { undrawnCompositionCaret } from "../composition";
import { commitCompositionOnCaretMove } from "../events/compositionEvents";
import { getBlockTextContent } from "../node-shared";
import { getContentWithComposition } from "../nodes/TextNode";
import { moveCursorToPosition } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState, Operation } from "../state-types";
import { createInitialState } from "../state-utils";
import { remapPosition } from "../sync/crdt-utils";
import { applyOps } from "../sync/reducer";
import { deleteSelectedText, insertText } from "./actions";
import {
  COMPOSITION_END,
  COMPOSITION_START,
  COMPOSITION_UPDATE,
} from "./input-actions";
import { describe, expect, it } from "vitest";

type Edit = (state: EditorState) => { state: EditorState; ops: Operation[] };

function text(state: EditorState) {
  return getBlockTextContent(state.document.page.blocks[0]);
}

function replicas(markdown: string): [EditorState, EditorState] {
  const page = loadPage(markdown);
  const focus = (s: EditorState) => ({
    ...s,
    view: { ...s.view, isFocused: true },
  });
  return [focus(createInitialState(page)), focus(createInitialState(page))];
}

// A remote batch, as `updatePageFromSync` adopts it: the page is replaced and
// the caret keeps its offset, clamped to the text (it is not re-anchored).
function receive(state: EditorState, ops: Operation[]): EditorState {
  const page = applyOps(state.document.page, ops);
  const cursor = state.document.cursor;
  const length = getBlockTextContent(page.blocks[0]).length;
  return {
    ...state,
    document: {
      ...state.document,
      page,
      cursor: cursor
        ? {
            ...cursor,
            position: {
              ...cursor.position,
              textIndex: Math.min(cursor.position.textIndex, length),
            },
          }
        : null,
    },
  };
}

// The keyboard reopens the `replaces` characters before `at` and composes
// `composed` over them; `commit` ends it with `committed`.
function reopen(
  state: EditorState,
  at: number,
  replaces: number,
  composed: string,
) {
  state = moveCursorToPosition(state, 0, at);
  state = state.actionBus.dispatchState(COMPOSITION_START, state, {
    data: "",
    replaces,
  }).state;
  return state.actionBus.dispatchState(COMPOSITION_UPDATE, state, {
    data: composed,
  }).state;
}

function commit(data: string): Edit {
  return (state) =>
    state.actionBus.dispatchState(COMPOSITION_END, state, { data });
}

function deleteRange(from: number, to: number): Edit {
  return (state) =>
    deleteSelectedText({
      ...state,
      document: {
        ...state.document,
        cursor: null,
        selection: {
          anchor: { blockIndex: 0, textIndex: from },
          focus: { blockIndex: 0, textIndex: to },
          isForward: true,
          isCollapsed: false,
          lastUpdate: 0,
        },
      },
    });
}

function typeAt(at: number, chars: string): Edit {
  return (state) => insertText(moveCursorToPosition(state, 0, at), chars);
}

/**
 * Peer B edits while A's keyboard has `word` reopened; run it both ways:
 * B's edit reaches A before A commits, and A commits before it arrives. Returns
 * the converged text of each ordering.
 */
function race(
  markdown: string,
  open: (a: EditorState) => EditorState,
  data: string,
  peer: Edit,
) {
  // B's edit lands on A first, then A commits.
  const [a1, b1] = replicas(markdown);
  const fromB = peer(b1);
  const committedLate = commit(data)(receive(open(a1), fromB.ops));
  const bLate = receive(fromB.state, committedLate.ops);
  expect(text(committedLate.state)).toBe(text(bLate));

  // A commits first, then the two cross.
  const [a2, b2] = replicas(markdown);
  const committedEarly = commit(data)(open(a2));
  const fromB2 = peer(b2);
  const aEarly = receive(committedEarly.state, fromB2.ops);
  const bEarly = receive(fromB2.state, committedEarly.ops);
  expect(text(aEarly)).toBe(text(bEarly));

  expect(text(committedLate.state)).toBe(text(aEarly));
  return text(aEarly);
}

describe("recomposition racing a peer's edit to the same word", () => {
  // "one helo two": the keyboard reopens "helo" (chars 4..8) and fixes it to
  // "hello", which only adds an "l" after "hel".
  const fix = (s: EditorState) => reopen(s, 8, 4, "hello");

  it("the peer deletes the whole word", () => {
    // The peer's delete covers the old letters; the one letter the keyboard
    // added is new, so it survives — on both replicas, in both orders.
    expect(race("one helo two", fix, "hello", deleteRange(4, 8))).toBe(
      "one l two",
    );
  });

  it("the peer deletes the word and the keyboard changed nothing", () => {
    expect(
      race(
        "one helo two",
        (s) => reopen(s, 8, 4, "helo"),
        "helo",
        deleteRange(4, 8),
      ),
    ).toBe("one  two");
  });

  it("the peer deletes the letters the keyboard replaces", () => {
    // "helo" → "help" replaces "o" with "p"; the peer already deleted "o".
    expect(
      race(
        "one helo two",
        (s) => reopen(s, 8, 4, "help"),
        "help",
        deleteRange(7, 8),
      ),
    ).toBe("one help two");
  });

  it("the peer deletes part of the word the keyboard keeps", () => {
    expect(race("one helo two", fix, "hello", deleteRange(4, 5))).toBe(
      "one ello two",
    );
  });

  it("the peer types inside the word", () => {
    expect(race("one helo two", fix, "hello", typeAt(6, "X"))).toBe(
      "one heXllo two",
    );
  });

  it("the peer types between the letters the keyboard replaces", () => {
    // "hello" → "help" replaces "lo"; the peer's "X" sits between them.
    expect(
      race(
        "one hello two",
        (s) => reopen(s, 9, 5, "help"),
        "help",
        typeAt(8, "X"),
      ),
    ).toBe("one helpX two");
  });

  it("the peer types before the word, shifting it under a caret that stays put", () => {
    expect(race("one helo two", fix, "hello", typeAt(0, "AB "))).toBe(
      "AB one hello two",
    );
  });

  it("both fix the word the same way at once", () => {
    // Two independent inserts of the same letter: both stay, as when two
    // people type the same letter at the same spot.
    const peerFix: Edit = (b) => commit("hello")(fix(b));
    expect(race("one helo two", fix, "hello", peerFix)).toBe("one helllo two");
  });
});

describe("recomposition preview while a peer edits the word", () => {
  const preview = (state: EditorState) => {
    const { chars, compositionRange } = getContentWithComposition(
      state.document.page.blocks[0],
      state,
      0,
    );
    const shown = chars
      .filter((c) => !c.deleted)
      .map((c) => c.char)
      .join("");
    return {
      shown,
      underlined: compositionRange
        ? shown.slice(compositionRange.start, compositionRange.end)
        : null,
    };
  };

  it("shows what the commit will produce when the peer deleted the word", () => {
    const [a, b] = replicas("one helo two");
    const open = receive(reopen(a, 8, 4, "hello"), deleteRange(4, 8)(b).ops);
    // Not the text before the word: only the letter that will survive.
    expect(preview(open).shown).toBe("one l two");
    expect(preview(open).shown).toBe(text(commit("hello")(open).state));
  });

  it("still hides the right word after text was typed before it", () => {
    const [a, b] = replicas("one helo two");
    const open = receive(reopen(a, 8, 4, "hello"), typeAt(0, "AB ")(b).ops);
    // The caret stayed at offset 8, which is now inside "one"/"helo"; the
    // preview follows the word's letters, not the caret.
    expect(preview(open)).toEqual({
      shown: "AB one hello two",
      underlined: "hello",
    });
  });
});

describe("tap while a peer edited the open word", () => {
  it("ends an unchanged word without an edit, peer's letter and all", () => {
    const [a, b] = replicas("one hello more");
    const open = receive(reopen(a, 9, 5, "hello"), typeAt(6, "X")(b).ops);
    const tapped = moveCursorToPosition(open, 0, 13);

    const left = commitCompositionOnCaretMove(open, tapped)!;

    expect(left.ops).toEqual([]);
    expect(left.state.ui.composition).toBeNull();
    expect(text(left.state)).toBe("one heXllo more");
  });

  it("commits a changed word around the peer's letter", () => {
    const [a, b] = replicas("one helo more");
    const open = receive(reopen(a, 8, 4, "hello"), typeAt(6, "X")(b).ops);
    const tapped = moveCursorToPosition(open, 0, 13);

    const left = commitCompositionOnCaretMove(open, tapped)!;

    expect(text(left.state)).toBe("one heXllo more");
    expect(left.state.ui.composition).toBeNull();
  });
});

describe("recomposition after a peer deleted the word, caret carried along", () => {
  // As the editor adopts a remote batch: the caret follows the character it
  // sits after (`remapPosition`), so deleting the open word pulls it back.
  function receiveCarried(state: EditorState, ops: Operation[]): EditorState {
    const page = applyOps(state.document.page, ops);
    const cursor = state.document.cursor;
    return {
      ...state,
      document: {
        ...state.document,
        page,
        cursor: cursor
          ? {
              ...cursor,
              position:
                remapPosition(state.document.page, page, cursor.position) ??
                cursor.position,
            }
          : null,
      },
    };
  }

  it("the keyboard's commit does not bring the word back", () => {
    const [a, b] = replicas("one hello two");
    const open = receiveCarried(
      reopen(a, 9, 5, "hellox"),
      deleteRange(4, 9)(b).ops,
    );
    expect(open.document.cursor?.position.textIndex).toBe(4);
    expect(text(commit("hellox")(open).state)).toBe("one x two");
  });

  it("a tap elsewhere does not bring the word back", () => {
    const [a, b] = replicas("one hello two");
    const open = receiveCarried(
      reopen(a, 9, 5, "hellox"),
      deleteRange(4, 9)(b).ops,
    );
    const left = commitCompositionOnCaretMove(
      open,
      moveCursorToPosition(open, 0, 0),
    )!;
    expect(text(left.state)).toBe("one x two");
  });

  it("does not bring back a word at the start of the line", () => {
    const [a, b] = replicas("hello two");
    const open = receiveCarried(
      reopen(a, 5, 5, "hellox"),
      deleteRange(0, 5)(b).ops,
    );
    expect(open.document.cursor?.position.textIndex).toBe(0);
    expect(text(commit("hellox")(open).state)).toBe("x two");
  });

  it("a keyboard update after the delete keeps the pinned word", () => {
    const [a, b] = replicas("one hello two");
    let open = receiveCarried(
      reopen(a, 9, 5, "hello"),
      deleteRange(4, 9)(b).ops,
    );
    open = open.actionBus.dispatchState(COMPOSITION_UPDATE, open, {
      data: "hellox",
      replaces: 5,
    }).state;
    expect(text(commit("hellox")(open).state)).toBe("one x two");
  });
});

describe("caret of a reopened word a peer deleted", () => {
  it("stays where the word was, not at the line start", () => {
    const [a, b] = replicas("one hello two");
    const open = reopen(a, 9, 5, "hello");
    const page = applyOps(open.document.page, deleteRange(4, 9)(b).ops);
    const composition = open.ui.composition!;
    // The caret was carried to 4, where the word was.
    expect(undrawnCompositionCaret(composition, page.blocks[0], 4)).toBe(4);
  });
});

describe("a reopened word whose block the caret left", () => {
  // A peer deleted the word's paragraph, so the caret was moved into another
  // block (see `updatePageFromSync`). The word's ids are not in that block.
  function openThenLeave() {
    const [a] = replicas("one hello\n\ntwo");
    const open = reopen(a, 9, 5, "help");
    const other = open.document.page.blocks.findIndex(
      (b) => getBlockTextContent(b) === "two",
    );
    expect(other).toBeGreaterThan(0);
    const state: EditorState = {
      ...open,
      document: {
        ...open.document,
        cursor: {
          ...open.document.cursor!,
          position: { blockIndex: other, textIndex: 3 },
        },
      },
    };
    return { state, other };
  }

  it("commits nothing into the block that holds the caret now", () => {
    const { state, other } = openThenLeave();
    const committed = commit("help")(state);
    expect(committed.ops).toEqual([]);
    const blocks = committed.state.document.page.blocks;
    expect(getBlockTextContent(blocks[0])).toBe("one hello");
    expect(getBlockTextContent(blocks[other])).toBe("two");
    expect(committed.state.ui.composition).toBeNull();
  });

  it("draws nothing in that block, and the caret stays put", () => {
    const { state, other } = openThenLeave();
    const block = state.document.page.blocks[other];
    const content = getContentWithComposition(block, state, other);
    expect(content.compositionRange).toBeNull();
    const drawn = content.chars.filter((c) => !c.deleted).map((c) => c.char);
    expect(drawn.join("")).toBe("two");
    expect(undrawnCompositionCaret(state.ui.composition!, block, 3)).toBe(3);
  });
});
