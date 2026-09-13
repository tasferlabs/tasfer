/**
 * Unit tests for the pure DocPoint/DocRange resolvers and read-projections in
 * `positions.ts` — the vocabulary the ChangeApi and read API both speak. These
 * run on fabricated `EditorState`s (no canvas mount needed) and pin the
 * edge-case contract the `Editor` methods delegate to: relative anchors, block
 * edges, offset clamping, multi-block → null, ordered ranges, and the plain-data
 * projections.
 */

import type { Paragraph } from "./nodes/TextNode";
import {
  activeCaretMarks,
  docMarks,
  docSelection,
  queryMarkInfos,
  resolveBlockIndex,
  resolveInlineRange,
  resolvePoint,
  selectTarget,
  toBlockData,
} from "./positions";
import type { Block, Page } from "./serlization/loadPage";
import type { CursorState, EditorState, SelectionState } from "./state-types";
import { createInitialState } from "./state-utils";
import { markCharsInRange } from "./sync/crdt-utils";
import { describe, expect, it } from "vitest";

function para(id: string, text: string): Paragraph {
  return {
    id,
    orderKey: "a0",
    deleted: false,
    type: "paragraph",
    charRuns: text ? [{ peerId: "peer", startCounter: 0, text }] : [],
    formats: [],
  };
}

function pageWith(...blocks: Block[]): Page {
  return { id: "page-1", title: "t", blocks };
}

function stateWith(...blocks: Block[]): EditorState {
  return createInitialState(pageWith(...blocks));
}

function withCursor(
  s: EditorState,
  blockIndex: number,
  textIndex: number,
): EditorState {
  const cursor: CursorState = {
    position: { blockIndex, textIndex },
    lastUpdate: 0,
  };
  return { ...s, document: { ...s.document, cursor } };
}

function withSelection(
  s: EditorState,
  anchor: { blockIndex: number; textIndex: number },
  focus: { blockIndex: number; textIndex: number },
): EditorState {
  const selection: SelectionState = {
    anchor,
    focus,
    isForward: true,
    isCollapsed: false,
  };
  return { ...s, document: { ...s.document, selection } };
}

describe("resolvePoint", () => {
  it('"start" / "end" resolve to the first / last visible block edges', () => {
    const s = stateWith(para("a", "hello"), para("b", "world!"));
    expect(resolvePoint(s, "start")).toEqual({
      blockIndex: 0,
      blockId: "a",
      offset: 0,
    });
    expect(resolvePoint(s, "end")).toEqual({
      blockIndex: 1,
      blockId: "b",
      offset: 6,
    });
  });

  it('"caret" needs a cursor', () => {
    const s = stateWith(para("a", "hi"));
    expect(resolvePoint(s, "caret")).toBeNull();
    expect(resolvePoint(withCursor(s, 0, 1), "caret")).toEqual({
      blockIndex: 0,
      blockId: "a",
      offset: 1,
    });
  });

  it("absolute { block, offset } clamps to the block's text length; defaults to 0", () => {
    const s = stateWith(para("a", "hello"));
    expect(resolvePoint(s, { block: "a" })).toEqual({
      blockIndex: 0,
      blockId: "a",
      offset: 0,
    });
    expect(resolvePoint(s, { block: "a", offset: 3 })).toEqual({
      blockIndex: 0,
      blockId: "a",
      offset: 3,
    });
    expect(resolvePoint(s, { block: "a", offset: 99 })?.offset).toBe(5);
    expect(resolvePoint(s, { block: "a", offset: -4 })?.offset).toBe(0);
  });

  it("block edges: side before → 0, after → text length", () => {
    const s = stateWith(para("a", "hello"));
    expect(resolvePoint(s, { block: "a", side: "before" })?.offset).toBe(0);
    expect(resolvePoint(s, { block: "a", side: "after" })?.offset).toBe(5);
  });

  it("unknown or deleted blocks resolve to null; start skips a deleted lead block", () => {
    const deleted = { ...para("a", "x"), deleted: true };
    const s = stateWith(deleted, para("b", "y"));
    expect(resolvePoint(s, { block: "missing" })).toBeNull();
    expect(resolvePoint(s, { block: "a" })).toBeNull();
    expect(resolvePoint(s, "start")).toEqual({
      blockIndex: 1,
      blockId: "b",
      offset: 0,
    });
  });
});

describe("resolveInlineRange", () => {
  it("default / selection collapses to the caret when nothing is selected", () => {
    const s = withCursor(stateWith(para("a", "hello")), 0, 2);
    expect(resolveInlineRange(s, undefined)).toEqual({
      blockIndex: 0,
      blockId: "a",
      start: 2,
      end: 2,
    });
    expect(resolveInlineRange(s, "selection")).toEqual({
      blockIndex: 0,
      blockId: "a",
      start: 2,
      end: 2,
    });
  });

  it("a single-block selection resolves to its span", () => {
    const s = withSelection(
      stateWith(para("a", "hello")),
      { blockIndex: 0, textIndex: 1 },
      { blockIndex: 0, textIndex: 4 },
    );
    expect(resolveInlineRange(s, "selection")).toEqual({
      blockIndex: 0,
      blockId: "a",
      start: 1,
      end: 4,
    });
  });

  it("a multi-block selection is not a single-block range → null", () => {
    const s = withSelection(
      stateWith(para("a", "hello"), para("b", "world")),
      { blockIndex: 0, textIndex: 1 },
      { blockIndex: 1, textIndex: 2 },
    );
    expect(resolveInlineRange(s, "selection")).toBeNull();
  });

  it("{ from, to } orders the offsets; cross-block resolves to null", () => {
    const s = stateWith(para("a", "hello"), para("b", "world"));
    expect(
      resolveInlineRange(s, {
        from: { block: "a", offset: 4 },
        to: { block: "a", offset: 1 },
      }),
    ).toEqual({ blockIndex: 0, blockId: "a", start: 1, end: 4 });
    expect(
      resolveInlineRange(s, {
        from: { block: "a", offset: 0 },
        to: { block: "b", offset: 2 },
      }),
    ).toBeNull();
  });

  it("a bare DocPoint is a collapsed range", () => {
    const s = stateWith(para("a", "hello"));
    expect(resolveInlineRange(s, { block: "a", offset: 3 })).toEqual({
      blockIndex: 0,
      blockId: "a",
      start: 3,
      end: 3,
    });
  });
});

describe("resolveBlockIndex", () => {
  it("defaults to the caret block, accepts an explicit block, and -1 on miss", () => {
    const s = withCursor(stateWith(para("a", "x"), para("b", "y")), 1, 0);
    expect(resolveBlockIndex(s, undefined)).toBe(1);
    expect(resolveBlockIndex(s, { block: "a" })).toBe(0);
    expect(resolveBlockIndex(s, { block: "missing" })).toBe(-1);
  });
});

describe("toBlockData", () => {
  it("projects id/type/text and the block's own attrs, excluding plumbing", () => {
    const todo = {
      ...para("t1", "buy milk"),
      type: "todo_list",
      checked: true,
    } as Block;
    const node = toBlockData(todo);
    expect(node).toEqual({
      id: "t1",
      type: "todo_list",
      text: "buy milk",
      attrs: { checked: true },
    });
    // structural fields never leak into attrs
    for (const k of ["charRuns", "formats", "orderKey", "deleted"]) {
      expect(k in node.attrs).toBe(false);
    }
  });
});

describe("docSelection", () => {
  it("returns a bare point for a caret and { from, to } for a selection", () => {
    const caret = withCursor(stateWith(para("a", "hello")), 0, 2);
    expect(docSelection(caret)).toEqual({ block: "a", offset: 2 });

    const sel = withSelection(
      stateWith(para("a", "hello")),
      { blockIndex: 0, textIndex: 1 },
      { blockIndex: 0, textIndex: 4 },
    );
    expect(docSelection(sel)).toEqual({
      from: { block: "a", offset: 1 },
      to: { block: "a", offset: 4 },
    });
  });

  it("is null with no caret or selection", () => {
    expect(docSelection(stateWith(para("a", "hello")))).toBeNull();
  });
});

describe("docMarks / activeCaretMarks", () => {
  it("a collapsed range falls back to caret marks (empty by default)", () => {
    const s = withCursor(stateWith(para("a", "hello")), 0, 1);
    expect([...docMarks(s, "selection")]).toEqual([]);
    expect([...activeCaretMarks(s)]).toEqual([]);
  });

  it("reports a mark that covers the whole range", () => {
    const base = stateWith(para("a", "hello"));
    const { newPage } = markCharsInRange(
      base.document.page,
      "a",
      0,
      5,
      { type: "strong" },
      true,
      base.CRDTbinding,
    );
    const s: EditorState = {
      ...base,
      document: { ...base.document, page: newPage },
    };
    const marks = docMarks(s, {
      from: { block: "a", offset: 0 },
      to: { block: "a", offset: 5 },
    });
    expect(marks.has("strong")).toBe(true);
    // a sub-range that's only partly marked still counts (fully covered here)
    expect(
      docMarks(s, {
        from: { block: "a", offset: 1 },
        to: { block: "a", offset: 3 },
      }).has("strong"),
    ).toBe(true);
  });
});

describe("queryMarkInfos", () => {
  // "hello world" with strong on [0,5) and em on [6,11); "foo bar" with a link
  // on [0,3). Runs resolve in document order within each block.
  function marked(): EditorState {
    const base = stateWith(para("a", "hello world"), para("b", "foo bar"));
    let page = base.document.page;
    const apply = (
      block: string,
      start: number,
      end: number,
      type: string,
      attrs: Record<string, unknown> = {},
    ) => {
      page = markCharsInRange(
        page,
        block,
        start,
        end,
        { type, attrs },
        true,
        base.CRDTbinding,
      ).newPage;
    };
    apply("a", 0, 5, "strong");
    apply("a", 6, 11, "em");
    apply("b", 0, 3, "link", { url: "https://x.test" });
    return { ...base, document: { ...base.document, page } };
  }
  const names = (infos: { name: string; block: string }[]) =>
    infos.map((m) => `${m.block}:${m.name}`);

  it("a point (default: caret) reads the runs covering it, left-inclusive", () => {
    const s = withCursor(marked(), 0, 2);
    expect(queryMarkInfos(s)).toEqual([
      { name: "strong", attrs: {}, block: "a", from: 0, to: 5, text: "hello" },
    ]);
    expect(names(queryMarkInfos(s, { block: "a", offset: 5 }))).toEqual([]);
    expect(names(queryMarkInfos(s, { block: "a", offset: 6 }))).toEqual([
      "a:em",
    ]);
    expect(queryMarkInfos(s, { block: "b", offset: 1 })[0].attrs).toEqual({
      url: "https://x.test",
    });
  });

  it("a single-block range returns every run it partially overlaps", () => {
    const s = marked();
    expect(
      names(
        queryMarkInfos(s, {
          from: { block: "a", offset: 4 },
          to: { block: "a", offset: 8 },
        }),
      ),
    ).toEqual(["a:strong", "a:em"]);
    // Touching a run's edge without entering it is not an overlap.
    expect(
      names(
        queryMarkInfos(s, {
          from: { block: "a", offset: 5 },
          to: { block: "a", offset: 6 },
        }),
      ),
    ).toEqual([]);
    // A collapsed range reads like the point form.
    expect(
      names(
        queryMarkInfos(s, {
          from: { block: "a", offset: 2 },
          to: { block: "a", offset: 2 },
        }),
      ),
    ).toEqual(["a:strong"]);
  });

  it("a cross-block range yields each block's runs in document order", () => {
    const s = marked();
    const range = {
      from: { block: "a", offset: 8 },
      to: { block: "b", offset: 2 },
    };
    expect(names(queryMarkInfos(s, range))).toEqual(["a:em", "b:link"]);
    // Endpoint order does not matter.
    expect(
      names(queryMarkInfos(s, { from: range.to, to: range.from })),
    ).toEqual(["a:em", "b:link"]);
    expect(names(queryMarkInfos(s, { from: "start", to: "end" }))).toEqual([
      "a:strong",
      "a:em",
      "b:link",
    ]);
  });

  it('"selection" reads the held range, or the caret when none is held', () => {
    const held = withSelection(
      marked(),
      { blockIndex: 0, textIndex: 7 },
      { blockIndex: 1, textIndex: 1 },
    );
    expect(names(queryMarkInfos(held, "selection"))).toEqual([
      "a:em",
      "b:link",
    ]);
    expect(
      names(queryMarkInfos(withCursor(marked(), 1, 0), "selection")),
    ).toEqual(["b:link"]);
  });

  it("an unresolvable target yields []", () => {
    const s = marked();
    expect(
      queryMarkInfos(s, {
        from: { block: "missing", offset: 0 },
        to: { block: "a", offset: 3 },
      }),
    ).toEqual([]);
    expect(queryMarkInfos(s, { block: "missing" })).toEqual([]);
    // No caret at all.
    expect(queryMarkInfos(s)).toEqual([]);
  });
});

describe("selectTarget", () => {
  it("a collapsed target moves the caret", () => {
    const s = stateWith(para("a", "hello"));
    const next = selectTarget(s, "end");
    expect(next.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 5,
    });
  });

  it("a span sets an (anchor, focus) selection", () => {
    const s = stateWith(para("a", "hello"));
    const next = selectTarget(s, {
      from: { block: "a", offset: 1 },
      to: { block: "a", offset: 4 },
    });
    expect(next.document.selection?.anchor).toEqual({
      blockIndex: 0,
      textIndex: 1,
    });
    expect(next.document.selection?.focus).toEqual({
      blockIndex: 0,
      textIndex: 4,
    });
    expect(next.document.selection?.isCollapsed).toBe(false);
  });

  it('"selection" leaves the state untouched', () => {
    const s = withCursor(stateWith(para("a", "hello")), 0, 2);
    expect(selectTarget(s, "selection")).toBe(s);
  });
});
