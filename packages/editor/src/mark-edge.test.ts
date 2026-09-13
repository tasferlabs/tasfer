/**
 * Mark edges: typing continues a mark until the caret arrows out of it, the
 * same way for every flat mark. Where a mark starts or ends, one caret position
 * has two stops — attached to the text before it or to the text after it — and
 * the arrows step between them before moving.
 */

import { insertText } from "./actions/actions";
import { handleKeyDown } from "./events/keysEvents";
import { caretMarkEdgeSide } from "./mark-edge";
import type { Paragraph } from "./nodes/TextNode";
import { activeCaretMarks, queryMarkInfos } from "./positions";
import {
  moveCursorLeft,
  moveCursorRight,
  moveCursorToPosition,
  startSelection,
  updateSelectionFocus,
} from "./selection";
import type { Mark } from "./serlization/loadPage";
import type { EditorState, Operation, ViewportState } from "./state-types";
import { createInitialState } from "./state-utils";
import { getVisibleTextFromRuns } from "./sync/char-runs";
import { getFormatsAtCharPosition, markCharsInRange } from "./sync/crdt-utils";
import { applyOps } from "./sync/reducer";
import { createCRDTbinding, createSyncEngine } from "./sync/sync";
import { describe, expect, it } from "vitest";

const STRONG: Mark = { type: "strong" };

/** "ab" + marked text + "cd", caret at `caret`. */
function setup(
  text: string,
  marked: [number, number],
  caret: number,
  mark: Mark = STRONG,
): EditorState {
  const paragraph: Paragraph = {
    id: "a",
    orderKey: "a0",
    deleted: false,
    type: "paragraph",
    charRuns: [{ peerId: "peer", startCounter: 0, text }],
    formats: [],
  };
  const base = createInitialState({ id: "p", title: "t", blocks: [paragraph] });
  const { newPage } = markCharsInRange(
    base.document.page,
    "a",
    marked[0],
    marked[1],
    mark,
    true,
    base.CRDTbinding,
  );
  return {
    ...base,
    document: {
      ...base.document,
      page: newPage,
      cursor: { position: { blockIndex: 0, textIndex: caret }, lastUpdate: 0 },
    },
  };
}

/** The visible text with every `type`-marked stretch wrapped in brackets. */
function marked(state: EditorState, type = "strong"): string {
  const block = state.document.page.blocks[0] as Paragraph;
  const text = getVisibleTextFromRuns(block.charRuns);
  let out = "";
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const has = getFormatsAtCharPosition(
      block.charRuns,
      block.formats,
      i + 1,
    ).some((format) => format.type === type);
    if (has !== open) out += has ? "[" : "]";
    open = has;
    out += text[i];
  }
  return open ? out + "]" : out;
}

function type(state: EditorState, text: string): EditorState {
  let s = state;
  for (const ch of text) s = insertText(s, ch).state;
  return s;
}

function caret(state: EditorState): number | undefined {
  return state.document.cursor?.position.textIndex;
}

describe("typing at a mark edge", () => {
  it("continues the mark at its end", () => {
    const s = type(setup("abBOLDcd", [2, 6], 6), "xy");
    expect(marked(s)).toBe("ab[BOLDxy]cd");
  });

  it("stays outside the mark at its start", () => {
    const s = type(setup("abBOLDcd", [2, 6], 2), "x");
    expect(marked(s)).toBe("abx[BOLD]cd");
  });

  it("continues the mark at the end of the block", () => {
    const s = type(setup("abBOLD", [2, 6], 6), "x");
    expect(marked(s)).toBe("ab[BOLDx]");
  });

  it("continues a link and reads back as one link", () => {
    const link: Mark = { type: "link", attrs: { url: "https://a.test" } };
    const s = type(setup("abLINKcd", [2, 6], 6, link), "xyz");
    expect(marked(s, "link")).toBe("ab[LINKxyz]cd");
    const links = queryMarkInfos(s, { block: "a", offset: 3 }).filter(
      (m) => m.name === "link",
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ from: 2, to: 9, text: "LINKxyz" });
  });

  it("adds no mark op when typing inside a run", () => {
    const s = setup("abBOLDcd", [2, 6], 4);
    const { ops } = insertText(s, "x");
    expect(ops.map((op) => op.op)).toEqual(["text_insert"]);
  });
});

describe("arrows at a mark edge", () => {
  it("→ at the end first steps out without moving, then moves", () => {
    let s = setup("abBOLDcd", [2, 6], 6);
    expect(caretMarkEdgeSide(s)?.side).toBe("before");
    expect(activeCaretMarks(s).has("strong")).toBe(true);

    s = moveCursorRight(s);
    expect(caret(s)).toBe(6);
    expect(caretMarkEdgeSide(s)?.side).toBe("after");
    expect(activeCaretMarks(s).has("strong")).toBe(false);
    expect(marked(type(s, "x"))).toBe("ab[BOLD]xcd");

    s = moveCursorRight(s);
    expect(caret(s)).toBe(7);
  });

  it("→ into the end lands inside", () => {
    const s = moveCursorRight(setup("abBOLDcd", [2, 6], 5));
    expect(caret(s)).toBe(6);
    expect(caretMarkEdgeSide(s)?.side).toBe("before");
  });

  it("← back to the end lands outside, then steps in", () => {
    let s = moveCursorLeft(setup("abBOLDcd", [2, 6], 7));
    expect(caret(s)).toBe(6);
    expect(caretMarkEdgeSide(s)?.side).toBe("after");
    expect(marked(type(s, "x"))).toBe("ab[BOLD]xcd");

    s = moveCursorLeft(s);
    expect(caret(s)).toBe(6);
    expect(caretMarkEdgeSide(s)?.side).toBe("before");
    expect(marked(type(s, "x"))).toBe("ab[BOLDx]cd");

    s = moveCursorLeft(s);
    expect(caret(s)).toBe(5);
  });

  it("→ at the start steps in, so typing joins the mark", () => {
    let s = moveCursorRight(setup("abBOLDcd", [2, 6], 1));
    expect(caret(s)).toBe(2);
    expect(caretMarkEdgeSide(s)?.side).toBe("before");

    s = moveCursorRight(s);
    expect(caret(s)).toBe(2);
    expect(caretMarkEdgeSide(s)?.side).toBe("after");
    expect(marked(type(s, "x"))).toBe("ab[xBOLD]cd");

    s = moveCursorRight(s);
    expect(caret(s)).toBe(3);
  });

  it("← at the start steps out, then moves", () => {
    let s = moveCursorLeft(setup("abBOLDcd", [2, 6], 3));
    expect(caret(s)).toBe(2);
    expect(caretMarkEdgeSide(s)?.side).toBe("after");

    s = moveCursorLeft(s);
    expect(caret(s)).toBe(2);
    expect(caretMarkEdgeSide(s)?.side).toBe("before");
    expect(marked(type(s, "x"))).toBe("abx[BOLD]cd");

    s = moveCursorLeft(s);
    expect(caret(s)).toBe(1);
  });

  it("follows the visual direction in RTL text", () => {
    // In RTL, ← advances through the text: at the end of the mark it steps out.
    let s = setup("ابجدهوز", [2, 5], 5);
    s = moveCursorLeft(s);
    expect(caret(s)).toBe(5);
    expect(caretMarkEdgeSide(s)?.side).toBe("after");
    s = moveCursorRight(s);
    expect(caret(s)).toBe(5);
    expect(caretMarkEdgeSide(s)?.side).toBe("before");
  });

  it("has no extra stop where the marks match on both sides", () => {
    const s = moveCursorRight(setup("abBOLDcd", [2, 6], 3));
    expect(caret(s)).toBe(4);
  });

  it("does not stall Shift+arrow selection", () => {
    const base = setup("abBOLDcd", [2, 6], 6);
    const s = moveCursorRight(
      startSelection(base, { blockIndex: 0, textIndex: 6 }),
    );
    expect(caret(s)).toBe(7);
  });

  it("leaves a Ctrl+B toggle to move the caret normally", () => {
    const base = setup("abBOLDcd", [2, 6], 6);
    const toggled: EditorState = {
      ...base,
      ui: {
        ...base.ui,
        activeMarksMode: {
          type: "explicit",
          formats: [STRONG, { type: "emphasis" }],
        },
      },
    };
    expect(caretMarkEdgeSide(toggled)).toBeNull();
    expect(caret(moveCursorRight(toggled))).toBe(7);
  });
});

describe("mark edges under collaboration", () => {
  it("converges when one peer types at a bold end while another unbolds it", () => {
    const base = setup("abBOLDcd", [2, 6], 6);

    const typing: Operation[] = [];
    let a = base;
    for (const ch of "xy") {
      const result = insertText(a, ch);
      typing.push(...result.ops);
      a = result.state;
    }

    const unbold = markCharsInRange(
      base.document.page,
      "a",
      2,
      6,
      STRONG,
      false,
      {
        ...base.CRDTbinding,
        nextId: () => "peer-b:1",
        getClock: () => ({ counter: 999, peerId: "peer-b" }),
      } as typeof base.CRDTbinding,
    ).op;

    const typedThenUnbolded = applyOps(base.document.page, [...typing, unbold]);
    const unboldedThenTyped = applyOps(base.document.page, [unbold, ...typing]);
    const view = (page: typeof base.document.page) =>
      marked({ ...base, document: { ...base.document, page } });
    expect(view(typedThenUnbolded)).toBe(view(unboldedThenTyped));
    expect(view(typedThenUnbolded)).toBe("abBOLD[xy]cd");
  });
});

describe("mark edges after earlier edits", () => {
  const viewport = { scrollY: 0, height: 800, width: 600 } as ViewportState;

  function typedPage(): EditorState {
    const binding = createCRDTbinding("edges", "peer-1");
    const engine = createSyncEngine(binding);
    const blockOp = engine.createBlockInsert("a0", "paragraph", {});
    engine.emit([blockOp]);
    const s = createInitialState(engine.getState(), { crdtBinding: binding });
    const focused = moveCursorToPosition(s, 0, 0);
    return { ...focused, view: { ...focused.view, isFocused: true } };
  }

  function press(state: EditorState, ...keys: string[]): EditorState {
    let s = state;
    for (const key of keys) {
      const event = {
        key,
        code: "",
        preventDefault() {},
        stopPropagation() {},
      };
      s = handleKeyDown(s, viewport, event as unknown as Event).state;
    }
    return s;
  }

  it("types plain outside a run whose last letter was deleted", () => {
    // The run's end stays anchored to the deleted "d", so the new letter is
    // placed inside the stored span; the caret's side must still win.
    let s = press(typedPage(), ..."hi **bold**d", "Backspace");
    expect(marked(s)).toBe("hi [bold]");
    s = press(s, "ArrowRight", "x");
    expect(marked(s)).toBe("hi [bold]x");
  });

  it("keeps typing bold inside a run whose last letter was deleted", () => {
    const s = press(typedPage(), ..."hi **bold**d", "Backspace", "x");
    expect(marked(s)).toBe("hi [boldx]");
  });

  it("types over a selected bold word in bold", () => {
    let s = press(typedPage(), ..."hi **bold**", "ArrowRight", ..." there");
    s = startSelection(s, { blockIndex: 0, textIndex: 3 });
    s = updateSelectionFocus(s, { blockIndex: 0, textIndex: 7 });
    s = press(s, "n", "e", "w");
    expect(marked(s)).toBe("hi [new] there");
  });
});
