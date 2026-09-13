import { describe, expect, it } from "vitest";
import {
  createDoc,
  type Block,
  type ContentSelection,
  type TextFieldInfo,
} from "@tasfer/editor";
import { appDataSchema } from "@/appDataSchema";
import {
  computeDocumentStats,
  computeSelectionStats,
  contentSelectionSpan,
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

  it("counts the words in table cells without calling cells paragraphs", () => {
    const doc = createDoc({
      markdown: ["Intro text.", "", "| Name | Note |", "| --- | --- |", "| one two | three |"].join("\n"),
      schema: appDataSchema,
    });
    const stats = computeDocumentStats(doc.getRawBlocks());
    doc.destroy();
    // "Intro text." plus Name, Note, one, two, three.
    expect(stats.words).toBe(7);
    expect(stats.paragraphs).toBe(1);
    expect(stats.sentences).toBe(1);
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

describe("selection inside table cells", () => {
  const point = (afterCharId: string | null) =>
    ({
      kind: "text",
      blockId: "table",
      contentId: "grid",
      nodeId: "cell",
      field: "text",
      afterCharId,
      affinity: "forward",
    }) as ContentSelection["anchor"];
  const editorWith = (
    selection: ContentSelection | null,
    text: string,
    fields: readonly TextFieldInfo[] = [{} as TextFieldInfo],
  ) => ({
    state: { contentSelection: selection },
    query: { textFields: () => [...fields], selectedText: () => text },
  });

  it("counts the selected cell text, not the document", () => {
    const span = contentSelectionSpan(
      editorWith({ anchor: point(null), focus: point("p:1") }, "one two"),
    );
    expect(span).toEqual({ text: "one two" });
    const stats = computeSelectionStats([], span!);
    expect(stats.words).toBe(2);
    // Cells are not paragraphs, the same as the document count.
    expect(stats.paragraphs).toBe(0);
  });

  it("counts every cell of a range across cells", () => {
    const stats = computeSelectionStats([], { text: "one two\tthree\nfour" });
    expect(stats.words).toBe(4);
    expect(stats.characters).toBe("one twothreefour".length);
  });

  it("is no selection for a caret or for content without prose", () => {
    expect(
      contentSelectionSpan(
        editorWith({ anchor: point("p:1"), focus: point("p:1") }, ""),
      ),
    ).toBeNull();
    expect(contentSelectionSpan(editorWith(null, ""))).toBeNull();
    // An equation's source is not prose the document count reads.
    expect(
      contentSelectionSpan(
        editorWith({ anchor: point(null), focus: point("p:1") }, "x^2", []),
      ),
    ).toBeNull();
  });

  it("brings a table's cells along when a range passes over it", () => {
    const doc = createDoc({
      markdown: [
        "Intro text.",
        "",
        "| Name | Note |",
        "| --- | --- |",
        "| one two | three |",
        "",
        "Outro here",
      ].join("\n"),
      schema: appDataSchema,
    });
    const blocks = doc.getRawBlocks().filter((block) => !block.deleted);
    doc.destroy();
    const first = blocks[0]!.id;
    const last = blocks[blocks.length - 1]!.id;
    const stats = computeSelectionStats(blocks, {
      from: { block: first, offset: 0 },
      to: { block: last, offset: "Outro".length },
    });
    // "Intro text." + Name, Note, one, two, three + "Outro".
    expect(stats.words).toBe(8);
  });
});
