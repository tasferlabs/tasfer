import { insertText } from "../actions/actions";
import { DELETE_BACKWARD, SPLIT_BLOCK } from "../actions/edit-actions";
import { getBlockHeight } from "../rendering/renderer";
import { serializeToHTMLFragment } from "../serlization/htmlSerializer";
import type { Block } from "../serlization/loadPage";
import { loadPage } from "../serlization/loadPage";
import { serializeToMarkdown } from "../serlization/serializer";
import type { CursorState, EditorState, Page } from "../state-types";
import { createInitialState } from "../state-utils";
import { getEditorStyles } from "../styles";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { cardJoinFlags } from "../sync/reducer";
import { type QuoteBlock } from "./QuoteNode";
import { describe, expect, it } from "vitest";

describe("QuoteNode serialization", () => {
  it("parses and emits Markdown blockquotes with inline marks", () => {
    const page = loadPage("> A **memorable** line");
    const quote = page.blocks[0] as QuoteBlock;

    expect(quote.type).toBe("quote");
    expect(getVisibleTextFromRuns(quote.charRuns)).toBe("A memorable line");
    expect(quote.formats.some((span) => span.format.type === "strong")).toBe(
      true,
    );
    expect(serializeToMarkdown(page.blocks)).toBe("> A **memorable** line");
  });

  it("emits semantic blockquote HTML", () => {
    const page = loadPage("> Stay curious");
    expect(serializeToHTMLFragment(page.blocks).trim()).toBe(
      "<blockquote>Stay curious</blockquote>",
    );
  });
});

describe("cardJoinFlags (adjacent card coupling)", () => {
  // Any state carries the full node registry; the join only reads each node's
  // joinGroup, so one shared registry serves every fixture below.
  const nodes = createInitialState(pageWith(paragraphBlock("x"))).nodes;
  const join = (blocks: Block[], index: number) =>
    cardJoinFlags(nodes, blocks, index);

  const card =
    (type: string) =>
    (id: string): Block =>
      ({ id, type, charRuns: [], formats: [] }) as Block;
  const quote = card("quote");
  const code = card("code");
  const math = card("math");
  const para = card("paragraph");
  const tombstone = (id: string): Block => ({ ...quote(id), deleted: true });

  it("leaves a standalone quote unjoined on both edges", () => {
    const blocks = [para("p0"), quote("q1"), para("p2")];
    expect(join(blocks, 1)).toEqual({ joinTop: false, joinBottom: false });
  });

  it("joins the run boundaries: first joins down, last joins up", () => {
    const blocks = [quote("q0"), quote("q1"), quote("q2")];
    expect(join(blocks, 0)).toEqual({ joinTop: false, joinBottom: true });
    expect(join(blocks, 1)).toEqual({ joinTop: true, joinBottom: true });
    expect(join(blocks, 2)).toEqual({ joinTop: true, joinBottom: false });
  });

  it("does not join across a non-quote neighbour", () => {
    const blocks = [quote("q0"), para("p1"), quote("q2")];
    expect(join(blocks, 0)).toEqual({ joinTop: false, joinBottom: false });
    expect(join(blocks, 2)).toEqual({ joinTop: false, joinBottom: false });
  });

  it("skips tombstoned blocks so a deleted block never breaks a run", () => {
    const blocks = [quote("q0"), tombstone("dead"), quote("q2")];
    expect(join(blocks, 0).joinBottom).toBe(true);
    expect(join(blocks, 2).joinTop).toBe(true);
  });

  it("tiles code and math together — they share a card surface", () => {
    const blocks = [code("c0"), math("m1"), code("c2")];
    expect(join(blocks, 0)).toEqual({ joinTop: false, joinBottom: true });
    expect(join(blocks, 1)).toEqual({ joinTop: true, joinBottom: true });
    expect(join(blocks, 2)).toEqual({ joinTop: true, joinBottom: false });
  });

  it("tiles across card types — a quote meets an adjacent code block", () => {
    const blocks = [quote("q0"), code("c1"), math("m2")];
    expect(join(blocks, 0)).toEqual({ joinTop: false, joinBottom: true });
    expect(join(blocks, 1)).toEqual({ joinTop: true, joinBottom: true });
    expect(join(blocks, 2)).toEqual({ joinTop: true, joinBottom: false });
  });

  it("does not join a paragraph — it declares no join group", () => {
    const blocks = [para("p0"), para("p1")];
    expect(join(blocks, 0)).toEqual({ joinTop: false, joinBottom: false });
  });
});

describe("consecutive-quote spacing", () => {
  const WIDTH = 600;

  // Height of one quote in a freshly-built page, with neighbour hints stamped by
  // createInitialState's getVisibleBlocks pass.
  function heightOf(blockIndex: number, ...quotes: QuoteBlock[]): number {
    const state = createInitialState(pageWith(...quotes));
    const styles = getEditorStyles(state);
    return getBlockHeight(
      state.nodes,
      state.marks,
      state.document.page.blocks[blockIndex],
      WIDTH,
      styles,
      false,
    );
  }

  const q = getEditorStyles(createInitialState(pageWith(quoteBlock("A"))))
    .blocks.quote;
  const topInsetSaving = q.paddingY - q.joinedPaddingY;
  const bottomSaving = q.paddingBottom - q.joinedPaddingY;

  it("keeps a standalone quote at full height", () => {
    const solo = heightOf(0, quoteBlock("A"));
    expect(solo).toBeGreaterThan(0);
    // A quote between two paragraphs joins nothing, so same as solo.
    const flanked = createInitialState(
      pageWith(
        paragraphBlock("p0"),
        quoteBlock("A", "q1"),
        paragraphBlock("p2"),
      ),
    );
    const styles = getEditorStyles(flanked);
    const h = getBlockHeight(
      flanked.nodes,
      flanked.marks,
      flanked.document.page.blocks[1],
      WIDTH,
      styles,
      false,
    );
    expect(h).toBe(solo);
  });

  it("shrinks the shared edge of consecutive quotes", () => {
    const solo = heightOf(0, quoteBlock("A"));
    const first = heightOf(0, quoteBlock("A", "q0"), quoteBlock("A", "q1"));
    const second = heightOf(1, quoteBlock("A", "q0"), quoteBlock("A", "q1"));

    // First of the run reduces only its bottom; second reduces only its top.
    expect(solo - first).toBe(bottomSaving);
    expect(solo - second).toBe(topInsetSaving);
  });

  it("shrinks both edges of a quote bracketed by quotes", () => {
    const solo = heightOf(0, quoteBlock("A"));
    const middle = heightOf(
      1,
      quoteBlock("A", "q0"),
      quoteBlock("A", "q1"),
      quoteBlock("A", "q2"),
    );
    expect(solo - middle).toBe(topInsetSaving + bottomSaving);
  });
});

function paragraphBlock(id: string): Block {
  return { id, type: "paragraph", charRuns: [], formats: [] };
}

function quoteBlock(text: string, id = "quote-1"): QuoteBlock {
  return {
    id,
    orderKey: "a0",
    deleted: false,
    type: "quote",
    charRuns: text ? [{ peerId: "peer", startCounter: 0, text }] : [],
    formats: [],
  };
}

function withCursor(
  state: EditorState,
  position: CursorState["position"],
): EditorState {
  return {
    ...state,
    document: { ...state.document, cursor: { position, lastUpdate: 0 } },
  };
}

function pageWith(...blocks: Page["blocks"]): Page {
  return { id: "page-1", title: "Quotes", blocks };
}

describe("QuoteNode markdown typing shortcut", () => {
  function paragraphWithText(text: string): Block {
    return {
      id: "p-1",
      orderKey: "a0",
      deleted: false,
      type: "paragraph",
      charRuns: [{ peerId: "peer", startCounter: 0, text }],
      formats: [],
    } as Block;
  }

  it('converts a paragraph to a quote on "> "', () => {
    const state = withCursor(
      createInitialState(pageWith(paragraphWithText(">"))),
      { blockIndex: 0, textIndex: 1 },
    );

    const result = insertText(state, " ");
    const block = result.state.document.page.blocks[0] as QuoteBlock;

    expect(block.type).toBe("quote");
    // The "> " prefix is consumed, not kept as literal text.
    expect(getVisibleTextFromRuns(block.charRuns)).toBe("");
    expect(
      result.ops.some(
        (op) =>
          op.op === "block_set" && op.field === "type" && op.value === "quote",
      ),
    ).toBe(true);
  });

  it("keeps typing after the conversion inside the quote", () => {
    const state = withCursor(
      createInitialState(pageWith(paragraphWithText(">"))),
      { blockIndex: 0, textIndex: 1 },
    );

    const converted = insertText(state, " ");
    const typed = insertText(converted.state, "W");
    const block = typed.state.document.page.blocks[0] as QuoteBlock;

    expect(block.type).toBe("quote");
    expect(getVisibleTextFromRuns(block.charRuns)).toBe("W");
  });

  it('leaves ">" without a following space as literal text', () => {
    const state = withCursor(
      createInitialState(pageWith(paragraphWithText(">"))),
      { blockIndex: 0, textIndex: 1 },
    );

    const result = insertText(state, "=");
    const block = result.state.document.page.blocks[0];

    expect(block.type).toBe("paragraph");
    expect(getVisibleTextFromRuns((block as QuoteBlock).charRuns)).toBe(">=");
  });
});

describe("QuoteNode Enter behavior", () => {
  it("splits within quote text without losing the quote type", () => {
    const state = withCursor(
      createInitialState(pageWith(quoteBlock("Stay curious"))),
      { blockIndex: 0, textIndex: 5 },
    );

    const result = state.actionBus.dispatchState(SPLIT_BLOCK, state);
    const live = result.state.document.page.blocks.filter(
      (block) => !block.deleted,
    ) as QuoteBlock[];

    expect(live.map((block) => block.type)).toEqual(["quote", "quote"]);
    expect(live.map((block) => getVisibleTextFromRuns(block.charRuns))).toEqual(
      ["Stay ", "curious"],
    );
  });

  it("starts a paragraph after Enter at the end of a non-empty quote", () => {
    const state = withCursor(
      createInitialState(pageWith(quoteBlock("Stay curious"))),
      { blockIndex: 0, textIndex: 12 },
    );

    const result = state.actionBus.dispatchState(SPLIT_BLOCK, state);
    const live = result.state.document.page.blocks.filter(
      (block) => !block.deleted,
    );

    expect(live.map((block) => block.type)).toEqual(["quote", "paragraph"]);
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 1,
      textIndex: 0,
    });
  });

  it("turns an empty quote into a paragraph", () => {
    const state = withCursor(createInitialState(pageWith(quoteBlock(""))), {
      blockIndex: 0,
      textIndex: 0,
    });

    const result = state.actionBus.dispatchState(SPLIT_BLOCK, state);
    const live = result.state.document.page.blocks.filter(
      (block) => !block.deleted,
    );

    expect(live).toHaveLength(1);
    expect(live[0].type).toBe("paragraph");
  });
});

describe("QuoteNode Backspace behavior", () => {
  it("exits an empty quote to a paragraph instead of merging upward", () => {
    const state = withCursor(
      createInitialState(
        pageWith(quoteBlock("Lead", "p0"), quoteBlock("", "q1")),
      ),
      { blockIndex: 1, textIndex: 0 },
    );

    const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);
    const live = result.state.document.page.blocks.filter(
      (block) => !block.deleted,
    );

    // The empty quote is demoted in place; the previous quote is untouched.
    expect(live.map((block) => block.type)).toEqual(["quote", "paragraph"]);
    expect(getVisibleTextFromRuns((live[0] as QuoteBlock).charRuns)).toBe(
      "Lead",
    );
  });

  it("exits an empty quote even when it is the first block", () => {
    const state = withCursor(createInitialState(pageWith(quoteBlock(""))), {
      blockIndex: 0,
      textIndex: 0,
    });

    const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);
    const live = result.state.document.page.blocks.filter(
      (block) => !block.deleted,
    );

    expect(live).toHaveLength(1);
    expect(live[0].type).toBe("paragraph");
  });

  it("leaves a non-empty quote to the default boundary handling", () => {
    const state = withCursor(
      createInitialState(pageWith(quoteBlock("Stay curious"))),
      { blockIndex: 0, textIndex: 0 },
    );

    const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);
    const live = result.state.document.page.blocks.filter(
      (block) => !block.deleted,
    );

    // Still a quote — only empty quotes are demoted by backspace.
    expect(live[0].type).toBe("quote");
  });
});
