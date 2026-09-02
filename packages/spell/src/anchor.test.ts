import {
  anchorIds,
  anchorRange,
  anchorRanges,
  charAnchor,
  charOffsetIndex,
  findRawBlock,
  resolveAnchoredRange,
} from "./anchor";
import { createHarness, type Harness } from "./test-harness";
import type { Block, RangeDecoration } from "@tasfer/editor";
import { afterEach, describe, expect, it } from "vitest";

interface RawRun {
  peerId: string;
  startCounter: number;
  text: string;
  deletedMask?: number[];
}

/** Reference walker: id of the visible char at `visibleIndex`, straight from the raw runs. */
function idAtVisible(block: Block, visibleIndex: number): string | null {
  const runs = (block as { charRuns?: RawRun[] }).charRuns ?? [];
  let seen = 0;
  for (const run of runs) {
    for (let k = 0; k < run.text.length; k++) {
      const byte = run.deletedMask?.[Math.floor(k / 8)] ?? 0;
      if ((byte & (1 << (k % 8))) !== 0) continue;
      if (seen === visibleIndex) return `${run.peerId}:${run.startCounter + k}`;
      seen++;
    }
  }
  return null;
}

describe("charAnchor / anchorRange", () => {
  let h: Harness;
  afterEach(() => h?.destroy());

  const raw = () => findRawBlock(h.doc.getRawBlocks(), h.blockIds[0])!;

  it("encodes ids as `${peerId}:${counter}` matching the raw runs", () => {
    h = createHarness("Hello wrold here");
    const block = raw();
    expect(charAnchor(block, 0)).toEqual({
      blockId: block.id,
      afterCharId: null,
    });
    expect(charAnchor(block, 1).afterCharId).toBe(idAtVisible(block, 0));
    expect(charAnchor(block, 6).afterCharId).toBe(idAtVisible(block, 5));
    expect(charAnchor(block, 16).afterCharId).toBe(idAtVisible(block, 15));
    // Past the end clamps to the last visible character.
    expect(charAnchor(block, 99).afterCharId).toBe(idAtVisible(block, 15));
    expect(charAnchor(block, 6).afterCharId).toMatch(/^[^:]+:\d+$/);
  });

  it("anchors a word span to the char before it and its own last char", () => {
    h = createHarness("Hello wrold here");
    const block = raw();
    const range = anchorRange(block, 6, 11);
    expect(range.from).toEqual({
      blockId: block.id,
      afterCharId: idAtVisible(block, 5),
    });
    expect(range.to).toEqual({
      blockId: block.id,
      afterCharId: idAtVisible(block, 10),
    });
    // Batch form agrees with the single form, in input order.
    const [a, b] = anchorRanges(block, [
      { from: 12, to: 16 },
      { from: 6, to: 11 },
    ]);
    expect(b).toEqual(range);
    expect(a.to).toEqual({
      blockId: block.id,
      afterCharId: idAtVisible(block, 15),
    });
    expect(anchorIds(block, [0, 0, 1])).toEqual([
      null,
      null,
      idAtVisible(block, 0),
    ]);
  });

  it("keeps resolving after a deletion before the word (offsets shift)", () => {
    h = createHarness("Hello wrold here");
    const before = raw();
    const range = anchorRange(before, 6, 11);
    h.editor.change((c) =>
      c.deleteRange({
        from: { block: before.id, offset: 0 },
        to: { block: before.id, offset: 2 },
      }),
    );
    const after = raw();
    expect(h.editor.query.block({ block: after.id })?.text).toBe(
      "llo wrold here",
    );
    expect(resolveAnchoredRange(charOffsetIndex(after), range)).toEqual({
      from: 4,
      to: 9,
    });
    // Tombstones are skipped when anchoring against the edited block too.
    expect(charAnchor(after, 4)).toEqual(range.from);
  });

  it("reports a dead range once the word's last char is deleted", () => {
    h = createHarness("Hello wrold here");
    const before = raw();
    const range = anchorRange(before, 6, 11);
    h.editor.change((c) =>
      c.deleteRange({
        from: { block: before.id, offset: 10 },
        to: { block: before.id, offset: 11 },
      }),
    );
    expect(resolveAnchoredRange(charOffsetIndex(raw()), range)).toBeNull();
  });

  it("is accepted by the core as a range decoration endpoint", () => {
    h = createHarness("Hello wrold here");
    const block = raw();
    const deco: RangeDecoration = {
      kind: "range",
      range: anchorRange(block, 6, 11),
      color: "#f00",
      opacity: 1,
      style: { type: "underline", line: "wavy" },
    };
    expect(() => h.editor.view.setDecorations("spell", [deco])).not.toThrow();
    // Editing after publishing must not throw either (the core re-resolves at paint).
    h.editor.setCaret({ block: block.id, offset: 0 });
    expect(() => h.editor.change((c) => c.insertText("X"))).not.toThrow();
    h.editor.view.clearDecorations("spell");
  });

  it("returns null for a tombstoned or unknown block", () => {
    h = createHarness("One\n\nTwo");
    const [first] = h.blockIds;
    expect(findRawBlock(h.doc.getRawBlocks(), "nope")).toBeNull();
    h.editor.change((c) => c.deleteBlock({ block: first }));
    expect(findRawBlock(h.doc.getRawBlocks(), first)).toBeNull();
  });
});
