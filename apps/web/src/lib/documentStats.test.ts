import { describe, expect, it } from "vitest";
import type { Block } from "@tasfer/editor";
import {
  computeDocumentStats,
  computeSelectionStats,
  countWordsFromBlocks,
  selectionSpanFromRange,
} from "./documentStats";

function paragraph(text: string, id = "b", deleted = false): Block {
  return {
    id,
    orderKey: "a0",
    deleted,
    type: "paragraph",
    charRuns: text ? [{ peerId: "peer", startCounter: 0, text }] : [],
    formats: [],
  } as unknown as Block;
}

function imageBlock(id = "img"): Block {
  return {
    id,
    orderKey: "a0",
    deleted: false,
    type: "image",
    src: "x",
  } as unknown as Block;
}

describe("computeDocumentStats", () => {
  it("counts words, characters, sentences and paragraphs across blocks", () => {
    const stats = computeDocumentStats([
      paragraph("Hello world.", "b1"),
      paragraph("A second sentence! And another?", "b2"),
    ]);

    expect(stats.words).toBe(7);
    expect(stats.sentences).toBe(3);
    expect(stats.paragraphs).toBe(2);
    expect(stats.characters).toBe("Hello world.".length + "A second sentence! And another?".length);
    expect(stats.charactersNoSpaces).toBe(
      "Helloworld.".length + "Asecondsentence!Andanother?".length,
    );
  });

  it("treats a non-empty block with no terminator as one sentence", () => {
    const stats = computeDocumentStats([paragraph("no terminator here")]);
    expect(stats.sentences).toBe(1);
    expect(stats.paragraphs).toBe(1);
  });

  it("ignores deleted and non-textual blocks", () => {
    const stats = computeDocumentStats([
      paragraph("kept words here", "b1"),
      paragraph("deleted words", "b2", true),
      imageBlock(),
    ]);
    expect(stats.words).toBe(3);
    expect(stats.paragraphs).toBe(1);
  });

  it("counts each CJK character as a word", () => {
    const stats = computeDocumentStats([paragraph("你好 world")]);
    expect(stats.words).toBe(3);
  });

  it("estimates reading time at ~200 wpm with a 1-minute floor", () => {
    expect(computeDocumentStats([paragraph("word")]).readingTimeMinutes).toBe(1);
    expect(computeDocumentStats([]).readingTimeMinutes).toBe(0);

    const longText = Array.from({ length: 400 }, () => "word").join(" ");
    expect(computeDocumentStats([paragraph(longText)]).readingTimeMinutes).toBe(2);
  });

  it("countWordsFromBlocks matches the words field", () => {
    const blocks = [paragraph("one two three")];
    expect(countWordsFromBlocks(blocks)).toBe(
      computeDocumentStats(blocks).words,
    );
  });

  it("returns zeroed stats for an empty document", () => {
    expect(computeDocumentStats([])).toEqual({
      words: 0,
      characters: 0,
      charactersNoSpaces: 0,
      sentences: 0,
      paragraphs: 0,
      readingTimeMinutes: 0,
    });
  });
});

describe("selectionSpanFromRange", () => {
  it("keeps a range that covers text", () => {
    expect(
      selectionSpanFromRange({
        from: { block: "b1", offset: 2 },
        to: { block: "b2", offset: 4 },
      }),
    ).toEqual({
      from: { block: "b1", offset: 2 },
      to: { block: "b2", offset: 4 },
    });
  });

  it("rejects a caret, a zero-width range and unresolved points", () => {
    expect(selectionSpanFromRange(null)).toBeNull();
    // A collapsed caret is a bare point, not a from/to pair.
    expect(selectionSpanFromRange({ block: "b1", offset: 3 })).toBeNull();
    // A node selection (an image held whole) is non-collapsed but zero-width.
    expect(
      selectionSpanFromRange({
        from: { block: "img", offset: 0 },
        to: { block: "img", offset: 0 },
      }),
    ).toBeNull();
    expect(
      selectionSpanFromRange({
        from: { block: "b1", side: "before" },
        to: { block: "b1", side: "after" },
      }),
    ).toBeNull();
  });
});

describe("computeSelectionStats", () => {
  const blocks = [
    paragraph("Hello world.", "b1"),
    paragraph("A middle line", "b2"),
    imageBlock(),
    paragraph("Last words here", "b3"),
  ];

  it("slices the first and last block and takes those between in full", () => {
    const stats = computeSelectionStats(blocks, {
      from: { block: "b1", offset: 6 },
      to: { block: "b3", offset: 4 },
    });

    // "world." + "A middle line" + "Last"
    expect(stats.words).toBe(5);
    expect(stats.paragraphs).toBe(3);
    expect(stats.characters).toBe("world.".length + "A middle line".length + "Last".length);
  });

  it("counts only the slice when the selection sits inside one block", () => {
    const stats = computeSelectionStats(blocks, {
      from: { block: "b2", offset: 2 },
      to: { block: "b2", offset: 8 },
    });

    expect(stats.words).toBe(1); // "middle"
    expect(stats.characters).toBe(6);
    expect(stats.paragraphs).toBe(1);
  });

  it("counts nothing for a span whose blocks are gone", () => {
    const stats = computeSelectionStats(blocks, {
      from: { block: "removed", offset: 0 },
      to: { block: "b3", offset: 4 },
    });
    expect(stats.words).toBe(0);
  });
});
