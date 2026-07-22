import type { Block } from "../serlization/loadPage";
import { BlockHeightIndex } from "./block-height-index";
import { describe, expect, it } from "vitest";

function blocks(count: number): (Block & { originalIndex: number })[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `block-${index}`,
    type: "paragraph",
    charRuns: [],
    formats: [],
    originalIndex: index,
  }));
}

describe("BlockHeightIndex", () => {
  it("resolves offsets and updates prefix sums after exact measurement", () => {
    const index = new BlockHeightIndex();
    index.rebuild(blocks(4), () => 40);

    const estimated = index.heightAt(0);
    expect(index.offsetOfVisibleIndex(2)).toBe(estimated * 2);
    expect(index.visibleIndexAtOffset(estimated * 2)).toBe(2);

    index.setExactHeight(0, estimated + 20);
    expect(index.offsetOfVisibleIndex(2)).toBe(estimated * 2 + 20);
    expect(index.totalHeight()).toBe(estimated * 4 + 20);
  });

  it("maps stable block ids and original indices to visible indices", () => {
    const index = new BlockHeightIndex();
    const visible = blocks(3);
    visible[1].originalIndex = 8;
    index.rebuild(visible, () => 40);

    expect(index.visibleIndexOfBlockId("block-1")).toBe(1);
    expect(index.visibleIndexOfOriginal(8)).toBe(1);
    expect(index.offsetOfBlockId("block-2")).toBe(
      index.offsetOfVisibleIndex(2),
    );
  });

  it("preserves learned heights across immutable page updates", () => {
    const index = new BlockHeightIndex();
    const initial = blocks(3);
    initial[0].cachedLayout = { height: 40, lines: [], maxWidth: 600 };
    initial[1].cachedLayout = { height: 40, lines: [], maxWidth: 600 };
    index.rebuild(initial, () => 40);
    index.setExactHeight(0, 80);
    index.setExactHeight(1, 120);

    const changed = { ...initial[1], cachedLayout: undefined };
    const next = [initial[0], changed, initial[2]];
    index.reconcile(next, () => 10);

    expect(index.heightAt(0)).toBe(80);
    expect(index.isExact(0)).toBe(true);
    expect(index.heightAt(1)).toBe(120);
    expect(index.isExact(1)).toBe(false);
    expect(index.totalHeight()).toBe(240);
  });

  it("estimates only newly inserted blocks during reconciliation", () => {
    const index = new BlockHeightIndex();
    const initial = blocks(2);
    index.rebuild(initial, () => 40);
    index.setExactHeight(0, 80);

    const inserted = blocks(1)[0];
    inserted.id = "inserted";
    inserted.originalIndex = 1;
    initial[1].originalIndex = 2;
    index.reconcile([initial[0], inserted, initial[1]], () => 25);

    expect(index.heightAt(0)).toBe(80);
    expect(index.heightAt(1)).toBe(25);
    expect(index.heightAt(2)).toBe(40);
  });
});
