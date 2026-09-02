import { REPLACE_WORD, replaceWord } from "./actions";
import { anchorRange, findRawBlock } from "./anchor";
import type { FlagRef } from "./checker";
import { createHarness, type Harness } from "./test-harness";
import { afterEach, describe, expect, it } from "vitest";

describe("replaceWord", () => {
  let h: Harness;
  afterEach(() => h?.destroy());

  function flag(word: string, blockIndex = 0): FlagRef {
    const blockId = h.blockIds[blockIndex];
    const text = h.editor.query.block({ block: blockId })!.text;
    const from = text.indexOf(word);
    expect(from).toBeGreaterThanOrEqual(0);
    const to = from + word.length;
    const raw = findRawBlock(h.doc.getRawBlocks(), blockId)!;
    return {
      blockId,
      version: 1,
      from,
      to,
      word,
      script: /\p{Script=Arabic}/u.test(word) ? "arab" : "latn",
      range: anchorRange(raw, from, to),
    };
  }
  const text = () => h.editor.query.block({ block: h.blockIds[0] })!.text;
  const marksOver = (from: number, to: number) =>
    h.editor.query
      .marks({
        from: { block: h.blockIds[0], offset: from },
        to: { block: h.blockIds[0], offset: to },
      })
      .filter((m) => m.from <= from && m.to >= to);
  const caret = () => h.editor.state.selection.range;

  it("keeps bold on a bold-only misspelled word", () => {
    h = createHarness("**wrold** is here");
    expect(text()).toBe("wrold is here");
    expect(replaceWord(h.editor, flag("wrold"), "world")).toBe(true);
    expect(text()).toBe("world is here");
    expect(marksOver(0, 5).map((m) => m.name)).toEqual(["strong"]);
    expect(caret()).toEqual({ block: h.blockIds[0], offset: 5 });
  });

  it("keeps a link (with its href) on a misspelled link word", () => {
    h = createHarness("see [wrold](https://example.com) now");
    expect(replaceWord(h.editor, flag("wrold"), "world")).toBe(true);
    expect(text()).toBe("see world now");
    const link = marksOver(4, 9).find((m) => m.name === "link");
    expect(link?.attrs).toMatchObject({ url: "https://example.com" });
    expect(link?.from).toBe(4);
    expect(link?.to).toBe(9);
    expect(marksOver(4, 9).map((m) => m.name)).toEqual(["link"]);
  });

  it("keeps bold when the word starts a longer bold run", () => {
    h = createHarness("**wrold here** ok");
    expect(replaceWord(h.editor, flag("wrold"), "world")).toBe(true);
    expect(text()).toBe("world here ok");
    const strong = marksOver(0, 10).find((m) => m.name === "strong");
    expect(strong).toBeDefined();
    expect(strong!.to).toBe(10);
  });

  it("replaces an Arabic word and lands the caret after it", () => {
    h = createHarness("هذا كتب هنا");
    expect(replaceWord(h.editor, flag("كتب"), "كتاب")).toBe(true);
    expect(text()).toBe("هذا كتاب هنا");
    expect(caret()).toEqual({ block: h.blockIds[0], offset: 8 });
  });

  it("changes only the differing middle when the word is plain", () => {
    h = createHarness("Hello wrold here");
    const before = h.localOps.length;
    expect(replaceWord(h.editor, flag("wrold"), "world")).toBe(true);
    expect(text()).toBe("Hello world here");
    const ops = h.localOps.slice(before);
    const deleted = ops.filter((op) => op.op === "text_delete");
    expect(deleted).toHaveLength(1);
    expect(deleted[0].op === "text_delete" && deleted[0].charIds).toHaveLength(
      2,
    );
    expect(caret()).toEqual({ block: h.blockIds[0], offset: 11 });
  });

  it("undoes everything in one step", () => {
    h = createHarness("**wrold** is [hre](https://x.y)");
    expect(replaceWord(h.editor, flag("wrold"), "world")).toBe(true);
    expect(replaceWord(h.editor, flag("hre"), "here")).toBe(true);
    expect(text()).toBe("world is here");
    expect(h.editor.undo()).toBe(true);
    expect(text()).toBe("world is hre");
    expect(marksOver(9, 12).map((m) => m.name)).toEqual(["link"]);
    expect(h.editor.undo()).toBe(true);
    expect(text()).toBe("wrold is hre");
    expect(marksOver(0, 5).map((m) => m.name)).toEqual(["strong"]);
  });

  it("finds the word again after text before it shifted", () => {
    h = createHarness("Hello wrold here");
    const f = flag("wrold");
    h.editor.setCaret({ block: h.blockIds[0], offset: 0 });
    h.editor.change((c) => c.insertText("Oh "));
    expect(replaceWord(h.editor, f, "world")).toBe(true);
    expect(text()).toBe("Oh Hello world here");
  });

  it("uses a checker's live anchors when offered", () => {
    h = createHarness("Hello wrold here");
    const f = flag("wrold");
    h.editor.setCaret({ block: h.blockIds[0], offset: 0 });
    h.editor.change((c) => c.insertText("Oh "));
    const rechecked: string[] = [];
    const hook = {
      recheck: (id: string) => rechecked.push(id),
      currentRange: () => ({ from: 9, to: 14 }),
    };
    expect(replaceWord(h.editor, f, "world", hook)).toBe(true);
    expect(text()).toBe("Oh Hello world here");
    expect(rechecked).toEqual([h.blockIds[0]]);
  });

  it("refuses when the word is gone", () => {
    h = createHarness("Hello wrold here");
    const f = flag("wrold");
    h.editor.change((c) =>
      c.insertText("world", {
        from: { block: h.blockIds[0], offset: 6 },
        to: { block: h.blockIds[0], offset: 11 },
      }),
    );
    expect(replaceWord(h.editor, f, "world")).toBe(false);
    expect(text()).toBe("Hello world here");
  });

  it("is dispatchable by reference with a bare payload", () => {
    h = createHarness("Hello wrold here");
    const changed = h.editor.dispatch(REPLACE_WORD, {
      block: h.blockIds[0],
      from: 6,
      to: 11,
      text: "world",
    });
    expect(changed).toBe(true);
    expect(text()).toBe("Hello world here");
    expect(caret()).toEqual({ block: h.blockIds[0], offset: 11 });
  });
});
