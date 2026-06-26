/**
 * Escaping a self-contained / visual block into a fresh paragraph at the
 * document edge — in both directions.
 *
 * Code / math / quote declare `selfContained`: when the caret is on the block's
 * first/last line and the block is the first/last in the document, a vertical
 * caret move (ArrowUp/Down, PageUp/Down) or a click in the empty area above/below
 * it starts a new paragraph there and moves the caret into it, rather than
 * clamping to the block's own text. Visual void blocks (image / line) escape the
 * same way regardless of caret line. Ordinary text blocks (paragraph / heading)
 * do not escape. These drive the pure helpers over fabricated state (no canvas
 * mount).
 */
import { loadPage } from "../serlization/loadPage";
import type { CursorState, EditorState, ViewportState } from "../state-types";
import { createInitialState, getBlockTextContent } from "../state-utils";
import { isSelfContained } from "../sync/block-registry";
import {
  createParagraphAbove,
  createParagraphAboveOnClick,
  createParagraphBelow,
  createParagraphBelowOnClick,
  escapeAboveSelfContainedBlock,
  escapeBelowSelfContainedBlock,
} from "./edit-actions";
import { describe, expect, it } from "vitest";

function stateFrom(markdown: string): EditorState {
  return createInitialState(loadPage(markdown));
}

function withCaret(
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

function endOf(s: EditorState, blockIndex: number): number {
  return getBlockTextContent(s.document.page.blocks[blockIndex]).length;
}

const VIEWPORT: ViewportState = {
  scrollY: 0,
  width: 800,
  height: 600,
  documentHeight: 600,
};

describe("selfContained capability", () => {
  it("is set on self-contained blocks and off for ordinary text", () => {
    expect(isSelfContained(loadPage("```\nx\n```").blocks[0])).toBe(true);
    expect(isSelfContained(loadPage("$$x$$").blocks[0])).toBe(true);
    expect(isSelfContained(loadPage("> hi").blocks[0])).toBe(true);
    expect(isSelfContained(loadPage("hello").blocks[0])).toBe(false);
    expect(isSelfContained(loadPage("# title").blocks[0])).toBe(false);
  });
});

describe("escapeBelowSelfContainedBlock — ArrowDown / PageDown", () => {
  it("appends a paragraph from the last line of a trailing code block", () => {
    const s = stateFrom("```\ncode\n```");
    const edge = escapeBelowSelfContainedBlock(
      withCaret(s, 0, endOf(s, 0)),
      true,
      s.document.page.blocks[0],
      VIEWPORT,
    );
    expect(edge.kind).toBe("break");
    if (edge.kind !== "break") return;
    const blocks = edge.state.document.page.blocks;
    expect(blocks).toHaveLength(2);
    expect(blocks[1].type).toBe("paragraph");
    expect(blocks[1].afterId).toBe(blocks[0].id);
    expect(edge.state.document.cursor?.position.blockIndex).toBe(1);
    expect(edge.ops).toHaveLength(1);
    expect(edge.ops[0].op).toBe("block_insert");
  });

  it("does not escape from an inner line of a multi-line code block", () => {
    const s = stateFrom("```\nfirst\nsecond\n```");
    const edge = escapeBelowSelfContainedBlock(
      withCaret(s, 0, 0),
      true,
      s.document.page.blocks[0],
      VIEWPORT,
    );
    expect(edge.kind).toBe("fallthrough");
  });

  it("escapes a trailing quote and a trailing math block", () => {
    for (const md of ["> quoted", "$$x$$"]) {
      const s = stateFrom(md);
      const edge = escapeBelowSelfContainedBlock(
        withCaret(s, 0, endOf(s, 0)),
        true,
        s.document.page.blocks[0],
        VIEWPORT,
      );
      expect(edge.kind).toBe("break");
    }
  });

  it("does not escape an ordinary paragraph or a non-last block", () => {
    const para = stateFrom("just text");
    expect(
      escapeBelowSelfContainedBlock(
        withCaret(para, 0, endOf(para, 0)),
        true,
        para.document.page.blocks[0],
        VIEWPORT,
      ).kind,
    ).toBe("fallthrough");

    const mid = stateFrom("> quoted\n\ntrailing");
    expect(
      escapeBelowSelfContainedBlock(
        withCaret(mid, 0, endOf(mid, 0)),
        false,
        mid.document.page.blocks[0],
        VIEWPORT,
      ).kind,
    ).toBe("fallthrough");
  });
});

describe("escapeAboveSelfContainedBlock — ArrowUp / PageUp", () => {
  it("prepends a paragraph from the first line of a leading code block", () => {
    const s = stateFrom("```\ncode\n```");
    const edge = escapeAboveSelfContainedBlock(
      withCaret(s, 0, 0),
      true,
      s.document.page.blocks[0],
      VIEWPORT,
    );
    expect(edge.kind).toBe("break");
    if (edge.kind !== "break") return;
    const blocks = edge.state.document.page.blocks;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[0].afterId).toBe(null);
    expect(edge.state.document.cursor?.position.blockIndex).toBe(0);
    expect(edge.ops[0].op).toBe("block_insert");
  });

  it("does not escape from an inner line of a multi-line code block", () => {
    const s = stateFrom("```\nfirst\nsecond\n```");
    // Caret on the last line (end) — ArrowUp should step to the line above.
    const edge = escapeAboveSelfContainedBlock(
      withCaret(s, 0, endOf(s, 0)),
      true,
      s.document.page.blocks[0],
      VIEWPORT,
    );
    expect(edge.kind).toBe("fallthrough");
  });

  it("escapes a leading quote but not an ordinary paragraph or a non-first block", () => {
    const quote = stateFrom("> quoted");
    expect(
      escapeAboveSelfContainedBlock(
        withCaret(quote, 0, 0),
        true,
        quote.document.page.blocks[0],
        VIEWPORT,
      ).kind,
    ).toBe("break");

    const para = stateFrom("just text");
    expect(
      escapeAboveSelfContainedBlock(
        withCaret(para, 0, 0),
        true,
        para.document.page.blocks[0],
        VIEWPORT,
      ).kind,
    ).toBe("fallthrough");

    const second = stateFrom("intro\n\n```\ncode\n```");
    expect(
      escapeAboveSelfContainedBlock(
        withCaret(second, 1, 0),
        false,
        second.document.page.blocks[1],
        VIEWPORT,
      ).kind,
    ).toBe("fallthrough");
  });
});

describe("createParagraphBelow / createParagraphAbove — visual blocks", () => {
  it("escape a visual block in both directions, regardless of caret line", () => {
    const s = stateFrom("![](/img.png)");
    expect(s.document.page.blocks[0].type).toBe("image");

    const belowEdge = createParagraphBelow(s, true, s.document.page.blocks[0]);
    expect(belowEdge.kind).toBe("break");

    const aboveEdge = createParagraphAbove(s, true, s.document.page.blocks[0]);
    expect(aboveEdge.kind).toBe("break");
    if (aboveEdge.kind !== "break") return;
    // Persistent paragraph (no auto-clear tracking): just a plain block_insert.
    expect(aboveEdge.ops).toHaveLength(1);
    expect(aboveEdge.ops[0].op).toBe("block_insert");
    expect(aboveEdge.state.document.page.blocks[0].type).toBe("paragraph");
  });

  it("never escape a self-contained text block (so horizontal arrows keep moving)", () => {
    const s = stateFrom("```\ncode\n```");
    expect(createParagraphBelow(s, true, s.document.page.blocks[0]).kind).toBe(
      "fallthrough",
    );
    expect(createParagraphAbove(s, true, s.document.page.blocks[0]).kind).toBe(
      "fallthrough",
    );
  });
});

describe("createParagraphBelowOnClick / createParagraphAboveOnClick", () => {
  it("appends a paragraph when clicking below a trailing self-contained block", () => {
    const s = stateFrom("> quoted");
    const edge = createParagraphBelowOnClick(s, 100_000, VIEWPORT);
    expect(edge.kind).toBe("break");
    if (edge.kind !== "break") return;
    expect(edge.state.document.page.blocks).toHaveLength(2);
    expect(edge.state.document.cursor?.position.blockIndex).toBe(1);
  });

  it("prepends a paragraph when clicking above a leading self-contained block", () => {
    const s = stateFrom("```\ncode\n```");
    const edge = createParagraphAboveOnClick(s, -100, VIEWPORT);
    expect(edge.kind).toBe("break");
    if (edge.kind !== "break") return;
    expect(edge.state.document.page.blocks).toHaveLength(2);
    expect(edge.state.document.page.blocks[0].type).toBe("paragraph");
    expect(edge.state.document.cursor?.position.blockIndex).toBe(0);
  });

  it("falls through when the click is on the content, not past the edge", () => {
    const s = stateFrom("```\ncode\n```");
    expect(createParagraphBelowOnClick(s, -100, VIEWPORT).kind).toBe(
      "fallthrough",
    );
    expect(createParagraphAboveOnClick(s, 100_000, VIEWPORT).kind).toBe(
      "fallthrough",
    );
  });

  it("falls through for ordinary trailing/leading paragraphs", () => {
    const s = stateFrom("just text");
    expect(createParagraphBelowOnClick(s, 100_000, VIEWPORT).kind).toBe(
      "fallthrough",
    );
    expect(createParagraphAboveOnClick(s, -100, VIEWPORT).kind).toBe(
      "fallthrough",
    );
  });
});
