import { DELETE_BACKWARD, SPLIT_BLOCK } from "../actions/edit-actions";
import { serializeToHTMLFragment } from "../serlization/htmlSerializer";
import type { Block } from "../serlization/loadPage";
import { loadPage } from "../serlization/loadPage";
import { serializeToMarkdown } from "../serlization/serializer";
import type { CursorState, EditorState, Page } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { type QuoteBlock, quoteJoinFlags } from "./QuoteNode";
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

describe("quoteJoinFlags (consecutive-quote coupling)", () => {
  const quote = (id: string): Block => quoteBlock("x", id);
  const para = (id: string): Block => ({
    id,
    type: "paragraph",
    charRuns: [],
    formats: [],
  });
  const tombstone = (id: string): Block => ({ ...quote(id), deleted: true });

  it("leaves a standalone quote unjoined on both edges", () => {
    const blocks = [para("p0"), quote("q1"), para("p2")];
    expect(quoteJoinFlags(blocks, 1)).toEqual({
      joinTop: false,
      joinBottom: false,
    });
  });

  it("joins the run boundaries: first joins down, last joins up", () => {
    const blocks = [quote("q0"), quote("q1"), quote("q2")];
    expect(quoteJoinFlags(blocks, 0)).toEqual({
      joinTop: false,
      joinBottom: true,
    });
    expect(quoteJoinFlags(blocks, 1)).toEqual({
      joinTop: true,
      joinBottom: true,
    });
    expect(quoteJoinFlags(blocks, 2)).toEqual({
      joinTop: true,
      joinBottom: false,
    });
  });

  it("does not join across a non-quote neighbour", () => {
    const blocks = [quote("q0"), para("p1"), quote("q2")];
    expect(quoteJoinFlags(blocks, 0)).toEqual({
      joinTop: false,
      joinBottom: false,
    });
    expect(quoteJoinFlags(blocks, 2)).toEqual({
      joinTop: false,
      joinBottom: false,
    });
  });

  it("skips tombstoned blocks so a deleted block never breaks a run", () => {
    const blocks = [quote("q0"), tombstone("dead"), quote("q2")];
    expect(quoteJoinFlags(blocks, 0).joinBottom).toBe(true);
    expect(quoteJoinFlags(blocks, 2).joinTop).toBe(true);
  });
});

function quoteBlock(text: string, id = "quote-1"): QuoteBlock {
  return {
    id,
    afterId: null,
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
