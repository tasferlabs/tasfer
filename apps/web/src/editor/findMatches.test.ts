import type { Block } from "@tasfer/editor";
import {
  mathContentIdForBlock,
  parseMathDocumentInit,
} from "@tasfer/math/data";
import { describe, expect, it } from "vitest";
import { findDocumentMatches } from "./findMatches";

function textBlock(id: string, text: string): Block {
  return {
    id,
    type: "paragraph",
    charRuns: [{ peerId: id, startCounter: 0, text }],
    formats: [],
  } as Block;
}

function displayMathBlock(id: string, latex: string): Block {
  const contentId = mathContentIdForBlock(id);
  const document = parseMathDocumentInit(latex, { contentId }).document;
  return {
    id,
    type: "math",
    charRuns: [],
    formats: [],
    structuredContent: { [contentId]: document },
    displayMode: true,
  } as unknown as Block;
}

function inlineMathBlock(id: string, latex: string): Block {
  const contentId = `${id}/inline`;
  const document = parseMathDocumentInit(latex, {
    contentId,
    authority: "supplemental",
  }).document;
  const mathSpan = {
    startCharId: `${id}:1`,
    endCharId: `${id}:1`,
    format: { type: "math", attrs: { contentId } },
    clock: { peerId: id, counter: 0 },
  };
  return {
    id,
    type: "paragraph",
    charRuns: [
      {
        peerId: id,
        startCounter: 0,
        text: "a\uFFFCz",
      },
    ],
    formats: [mathSpan],
    structuredContent: { [contentId]: document },
  } as Block;
}

describe("findDocumentMatches", () => {
  it("keeps ordinary text matches as flat ranges", () => {
    const matches = findDocumentMatches(
      [textBlock("p", "Alpha alpha")],
      "ALPHA",
    );

    expect(matches).toHaveLength(2);
    expect(matches.map((match) => match.selection.kind)).toEqual([
      "flat",
      "flat",
    ]);
    expect(matches.map((match) => match.range)).toEqual([
      {
        from: { block: "p", offset: 0 },
        to: { block: "p", offset: 5 },
      },
      {
        from: { block: "p", offset: 6 },
        to: { block: "p", offset: 11 },
      },
    ]);
  });

  it("finds canonical source inside a display equation", () => {
    const block = displayMathBlock("equation", String.raw`\frac{x}{y}`);
    const matches = findDocumentMatches([block], "x");
    const commandMatches = findDocumentMatches([block], "frac");

    expect(matches).toHaveLength(1);
    expect(commandMatches).toHaveLength(1);
    expect(commandMatches[0]?.selection.kind).toBe("content");
    expect(matches[0]?.selection.kind).toBe("content");
    expect(matches[0]?.range.from).toMatchObject({
      blockId: "equation",
      contentId: "equation/math",
    });
  });

  it("finds inline math at its document position", () => {
    const blocks = [
      inlineMathBlock("inline", String.raw`\sqrt{x}`),
      textBlock("after", "x"),
    ];
    const matches = findDocumentMatches(blocks, "x");

    expect(matches).toHaveLength(2);
    expect(matches.map((match) => match.selection.kind)).toEqual([
      "content",
      "flat",
    ]);
    expect(matches[0]?.scrollOffset).toBe(1);
    expect(matches[0]?.range.from).toMatchObject({
      blockId: "inline",
      contentId: "inline/inline",
    });
  });
});
