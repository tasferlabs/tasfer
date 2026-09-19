/**
 * Spelling inside table cells.
 *
 * A table keeps its text in structured content, not in the block's own text.
 * The table declares its cells as prose (`textFields` on its structured kind),
 * and the checker reads them through `editor.query.textFields` — no import of
 * the table package from the checker itself. This suite runs a real table.
 */

import { replaceWord } from "./actions";
import { charOffsetIndex, findRawBlock, resolveAnchoredRange } from "./anchor";
import { type FlagRef, SpellChecker, type SpellTransport } from "./checker";
import type { CheckBlock, CheckedBlock, Flag } from "./protocol";
import { createHarness, type Harness } from "./test-harness";
import {
  baseSchema,
  type ContentTextPoint,
  type Decoration,
  type RangeDecoration,
} from "@tasfer/editor";
import {
  getTableDocument,
  tableCaretToContentPoint,
  tableCellIds,
  tableExtension,
} from "@tasfer/table";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KNOWN = new Set(["Name", "Note", "one", "two", "Hello", "world", "bold"]);

function transport(): SpellTransport & { calls: CheckBlock[][] } {
  const calls: CheckBlock[][] = [];
  const flagsFor = (b: CheckBlock): Flag[] => {
    const out: Flag[] = [];
    const re = /[\p{L}\p{M}']+/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b.text))) {
      const from = m.index;
      const to = from + m[0].length;
      if (b.skip.some(([s, e]) => from < e && to > s)) continue;
      if (KNOWN.has(m[0])) continue;
      out.push({ from, to, word: m[0], script: "latn" });
    }
    return out;
  };
  return {
    calls,
    check: (req) => {
      calls.push([...req.blocks]);
      return Promise.resolve(
        req.blocks.map((b): CheckedBlock => ({
          blockId: b.blockId,
          version: b.version,
          flags: flagsFor(b),
        })),
      );
    },
    suggest: (word) => Promise.resolve([`${word}!`]),
    onInvalidate: () => () => {},
  };
}

const SOURCE = [
  "Hello wrold",
  "",
  "| Name | Note |",
  "| --- | --- |",
  "| one tpyo | **bolld** two |",
  "| two | sceond |",
].join("\n");

describe("spelling in table cells", () => {
  let h: Harness;
  let checker: SpellChecker;
  let decorations: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    checker?.dispose();
    h?.destroy();
    vi.useRealTimers();
  });

  async function setup(source = SOURCE) {
    h = createHarness(source, { schema: baseSchema.use(tableExtension()) });
    decorations = vi.spyOn(h.editor.view, "setDecorations");
    checker = new SpellChecker({
      editor: h.editor,
      doc: h.doc,
      docId: "doc",
      transport: transport(),
      color: () => "#e00",
      isEnabled: () => true,
      ignoredInDocument: () => new Set(),
      flagAllCaps: () => false,
      lenientArabic: () => false,
      schedule: (cb) => setTimeout(cb, 0),
    });
    checker.start();
    await vi.advanceTimersByTimeAsync(10);
  }

  const table = () => {
    const block = h.doc
      .getRawBlocks()
      .find((b) => (b.type as string) === "table" && !b.deleted)!;
    const document = getTableDocument(block)!;
    return { block, document, cells: tableCellIds(document) };
  };

  const cellText = (cellId: string) => {
    const { block } = table();
    return h.editor.query
      .textFields(block.id)
      .find((field) => field.nodeId === cellId)!.text;
  };

  const caretIn = (cell: number, offset: number): ContentTextPoint => {
    const { block, document, cells } = table();
    const point = tableCaretToContentPoint(document, block.id, {
      cellId: cells[cell],
      offset,
    })! as ContentTextPoint;
    h.editor.change((c) => c.selectContent({ anchor: point, focus: point }));
    return point;
  };

  const published = (): RangeDecoration[] =>
    (
      (decorations.mock.calls.at(-1)?.[1] as readonly Decoration[]) ?? []
    ).filter((d): d is RangeDecoration => d.kind === "range");

  it("underlines misspelled words in cells, anchored inside the cell", async () => {
    await setup();
    const { cells } = table();

    expect(checker.flags().map((f) => f.word)).toEqual([
      "wrold",
      "tpyo",
      "bolld",
      "sceond",
    ]);
    const inCells = published().filter((d) => "kind" in d.range.from);
    expect(inCells).toHaveLength(3);
    const from = inCells[0].range.from as ContentTextPoint;
    expect(from.nodeId).toBe(cells[2]);
    expect(from.field).toBe("text");
  });

  it("leaves prose inside a code mark alone, as it does in a paragraph", async () => {
    await setup(["| A |", "| --- |", "| `tpyo` and okk |"].join("\n"));
    expect(checker.flags().map((f) => f.word)).toEqual(["A", "and", "okk"]);
  });

  it("finds the flag under a caret in a cell and steps in reading order", async () => {
    await setup();
    const { cells } = table();

    caretIn(2, 5);
    const here = checker.flagAt("caret");
    expect(here?.word).toBe("tpyo");
    expect(here?.field?.nodeId).toBe(cells[2]);

    expect(checker.next("caret")?.word).toBe("bolld");
    caretIn(3, 0);
    expect(checker.next("caret")?.word).toBe("sceond");
    expect(checker.prev("caret")?.word).toBe("tpyo");
  });

  it("replaces a word in a cell, keeps its formatting and changes nothing else", async () => {
    await setup();
    const { cells } = table();
    const before = h.editor.query
      .textFields(table().block.id)
      .map((field) => field.text);
    const flag = checker.flags().find((f) => f.word === "bolld") as FlagRef;

    expect(replaceWord(h.editor, flag, "bold", checker)).toBe(true);

    const fields = h.editor.query.textFields(table().block.id);
    expect(fields.map((field) => field.text)).toEqual(
      before.map((text) => text.replace("bolld", "bold")),
    );
    const cell = fields.find((field) => field.nodeId === cells[3])!;
    expect(cell.marks).toEqual([{ name: "strong", attrs: {}, from: 0, to: 4 }]);
    expect(h.editor.query.block({ block: h.blockIds[0] })?.text).toBe(
      "Hello wrold",
    );
    // The caret lands after the new word, inside the cell.
    const focus = h.editor.state.contentSelection?.focus as ContentTextPoint;
    expect(focus.nodeId).toBe(cells[3]);

    h.editor.undo();
    expect(cellText(cells[3])).toBe("bolld two");
    expect(
      h.editor.query
        .textFields(table().block.id)
        .find((field) => field.nodeId === cells[3])!.marks,
    ).toEqual([{ name: "strong", attrs: {}, from: 0, to: 5 }]);
  });

  it("replaces a word whose first letter changes", async () => {
    await setup();
    const { cells } = table();
    const flag = checker.flags().find((f) => f.word === "tpyo") as FlagRef;

    expect(replaceWord(h.editor, flag, "typo", checker)).toBe(true);
    expect(cellText(cells[2])).toBe("one typo");

    const second = checker.flags().find((f) => f.word === "sceond") as FlagRef;
    expect(replaceWord(h.editor, second, "Second", checker)).toBe(true);
    expect(cellText(cells[5])).toBe("Second");
  });

  it("keeps a selected word in a cell selected across a longer fix", async () => {
    await setup();
    const { block, document, cells } = table();
    const flag = checker.flags().find((f) => f.word === "tpyo") as FlagRef;
    // What walking to the flag leaves behind: the word itself selected.
    h.editor.change((c) =>
      c.selectContent({
        anchor: flag.range.from as ContentTextPoint,
        focus: flag.range.to as ContentTextPoint,
      }),
    );

    expect(replaceWord(h.editor, flag, "typoes", checker)).toBe(true);
    expect(cellText(cells[2])).toBe("one typoes");

    const selection = h.editor.state.contentSelection!;
    const raw = findRawBlock(h.doc.getRawBlocks(), block.id)!;
    const index = charOffsetIndex(raw, {
      contentId: document.rootId,
      nodeId: cells[2],
      field: "text",
    });
    // The whole new word, not the old word's four characters.
    expect(
      resolveAnchoredRange(index, {
        from: selection.anchor as ContentTextPoint,
        to: selection.focus as ContentTextPoint,
      }),
    ).toEqual({ from: 4, to: 10 });
  });

  it("re-checks a cell after an edit to it", async () => {
    await setup();
    const { block, document, cells } = table();
    const runs = document.nodes[cells[4]].textFields.text;
    const last = runs[runs.length - 1];
    const afterCharId = `${last.peerId}:${last.startCounter + last.text.length - 1}`;
    const id = h.editor.change((c) => {
      const next = c.identities.nextId();
      const sep = next.lastIndexOf(":");
      c.editContent(block.id, document.rootId, {
        kind: "text_insert",
        nodeId: cells[4],
        field: "text",
        afterCharId,
        charRuns: [
          {
            peerId: next.slice(0, sep),
            startCounter: Number(next.slice(sep + 1)),
            text: "x",
          },
        ],
      });
    });
    expect(id).toBe(true);
    await vi.advanceTimersByTimeAsync(400);

    expect(cellText(cells[4])).toBe("twox");
    expect(checker.flags().map((f) => f.word)).toContain("twox");
  });
});
