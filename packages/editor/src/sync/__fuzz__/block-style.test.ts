/**
 * Per-block style — an open bag of visual overrides (`block.style`) that syncs
 * per-property as namespaced `style.<key>` `block_set` ops. This pins the CRDT
 * contract that makes the per-key (not whole-bag) wire shape worth its cost:
 *
 *   1. Concurrent edits to DIFFERENT style keys MERGE — neither clobbers the
 *      other (the whole reason each key is its own LWW register).
 *   2. Concurrent edits to the SAME key resolve by HLC, deterministically and
 *      independent of arrival order.
 *   3. Style survives an `encodeState()` round-trip (it rides the op log; the
 *      block-snapshot keeps it too — only `cachedLayout` is stripped).
 *   4. `block_insert` can seed style via `initialProps.style` (the create path,
 *      and the path an undo of a block delete restores through).
 *   5. Undo of a `style.<key>` set restores the prior value — including the
 *      "key was unset" case, which inverts to the `null` ("no override")
 *      sentinel rather than `undefined` (a value-less `block_set` is a no-op).
 *   6. The render-side merge (`mergeBlockStyle`) applies the keys a `TextStyle`
 *      carries and ignores `null`/unknown keys.
 */

import { mergeBlockStyle } from "../../node-shared";
import { createDoc } from "../../doc";
import type { Block } from "../../serlization/loadPage";
import type { Operation, TextStyle } from "../../state-types";
import { invertOperations } from "../inverse";
import { applyOp, applyOps, createEmptyPageState } from "../reducer";
import { createCRDTbinding } from "../sync";
import { describe, expect, it } from "vitest";

const PAGE_ID = "block-style";

function styleOf(blocks: Block[], id: string): Record<string, unknown> {
  const b = blocks.find((x) => x.id === id);
  return (b?.style ?? {}) as Record<string, unknown>;
}

const insertBlock: Operation = {
  op: "block_insert",
  id: "pA:1",
  clock: { counter: 1, peerId: "pA" },
  pageId: PAGE_ID,
  afterBlockId: null,
  blockId: "blk",
  blockType: "paragraph",
};

function styleSet(
  peer: string,
  counter: number,
  key: string,
  value: unknown,
): Operation {
  return {
    op: "block_set",
    id: `${peer}:${counter}`,
    clock: { counter, peerId: peer },
    pageId: PAGE_ID,
    blockId: "blk",
    field: `style.${key}`,
    value,
  };
}

function emptyDoc() {
  return createDoc({ pageId: PAGE_ID, ops: [] });
}

describe("per-block style — CRDT convergence", () => {
  it("merges concurrent edits to different style keys (no clobber)", () => {
    const color = styleSet("pA", 5, "color", "#f00");
    const align = styleSet("pB", 6, "textAlign", "center");

    // Same ops, opposite arrival order, on two replicas.
    const a = emptyDoc();
    a.applyUpdate([insertBlock, color, align]);
    const b = emptyDoc();
    b.applyUpdate([insertBlock, align, color]);

    const expected = { color: "#f00", textAlign: "center" };
    expect(styleOf(a.getRawBlocks(), "blk")).toEqual(expected);
    expect(styleOf(b.getRawBlocks(), "blk")).toEqual(styleOf(a.getRawBlocks(), "blk"));

    a.destroy();
    b.destroy();
  });

  it("resolves same-key conflicts by HLC, independent of arrival order", () => {
    const red = styleSet("pA", 5, "color", "#f00");
    const blue = styleSet("pB", 7, "color", "#00f"); // higher HLC → wins

    const a = emptyDoc();
    a.applyUpdate([insertBlock, red, blue]);
    const b = emptyDoc();
    b.applyUpdate([insertBlock, blue, red]);

    expect(styleOf(a.getRawBlocks(), "blk").color).toBe("#00f");
    expect(styleOf(b.getRawBlocks(), "blk").color).toBe("#00f");

    a.destroy();
    b.destroy();
  });

  it("preserves style across an encodeState() round-trip", () => {
    const doc = emptyDoc();
    doc.applyUpdate([
      insertBlock,
      styleSet("pA", 5, "color", "#f00"),
      styleSet("pA", 6, "textAlign", "center"),
    ]);
    const bytes = doc.encodeState();
    doc.destroy();

    const restored = createDoc(bytes);
    expect(styleOf(restored.getRawBlocks(), "blk")).toEqual({
      color: "#f00",
      textAlign: "center",
    });
    restored.destroy();
  });

  it("seeds style from block_insert initialProps", () => {
    const doc = emptyDoc();
    doc.applyUpdate([
      {
        op: "block_insert",
        id: "pA:2",
        clock: { counter: 2, peerId: "pA" },
        pageId: PAGE_ID,
        afterBlockId: null,
        blockId: "blk2",
        blockType: "paragraph",
        initialProps: { style: { color: "#0f0" } },
      },
    ]);
    expect(styleOf(doc.getRawBlocks(), "blk2")).toEqual({ color: "#0f0" });
    doc.destroy();
  });
});

describe("per-block style — undo", () => {
  const binding = createCRDTbinding("style-undo", PAGE_ID);

  function pageWithBlock() {
    return applyOp(createEmptyPageState(binding.pageId), {
      ...insertBlock,
      pageId: binding.pageId,
    });
  }

  it("undo of a newly-set key clears it (null = no override)", () => {
    const before = pageWithBlock();
    const setRed = styleSet("pA", 5, "color", "#f00");
    const after = applyOp(before, { ...setRed, pageId: binding.pageId });
    expect(styleOf(after.blocks, "blk").color).toBe("#f00");

    const inverses = invertOperations(
      [{ ...setRed, pageId: binding.pageId }],
      before,
      applyOp,
      binding,
    );
    const undone = applyOps(after, inverses);

    // Prior value was unset → restored to the `null` sentinel, which the render
    // merge treats as "no override".
    expect(styleOf(undone.blocks, "blk").color).toBe(null);
  });

  it("undo of a changed key restores the prior value", () => {
    const withRed = applyOp(pageWithBlock(), {
      ...styleSet("pA", 5, "color", "#f00"),
      pageId: binding.pageId,
    });
    const setBlue = { ...styleSet("pA", 6, "color", "#00f"), pageId: binding.pageId };
    const withBlue = applyOp(withRed, setBlue);
    expect(styleOf(withBlue.blocks, "blk").color).toBe("#00f");

    const inverses = invertOperations([setBlue], withRed, applyOp, binding);
    const undone = applyOps(withBlue, inverses);

    expect(styleOf(undone.blocks, "blk").color).toBe("#f00");
  });
});

describe("per-block style — render merge", () => {
  const base: TextStyle = {
    fontSize: 16,
    fontWeight: "400",
    color: "#000",
    lineHeight: 1.5,
    paddingBottom: 8,
  };

  it("applies the TextStyle keys it carries", () => {
    expect(mergeBlockStyle(base, { fontSize: 24, color: "#f00" })).toEqual({
      ...base,
      fontSize: 24,
      color: "#f00",
    });
  });

  it("returns the base untouched when there is no style bag", () => {
    expect(mergeBlockStyle(base, undefined)).toBe(base);
  });

  it("ignores null (cleared) and unknown keys", () => {
    expect(
      mergeBlockStyle(base, { color: null, textAlign: "center", foo: 1 }),
    ).toEqual(base);
  });
});
