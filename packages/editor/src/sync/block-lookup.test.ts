import type { Block, Page } from "../serlization/loadPage";
import { findBlock, findBlockIndex } from "./block-lookup";
import { describe, expect, it } from "vitest";

function block(id: string): Block {
  return {
    id,
    type: "paragraph",
    charRuns: [],
    formats: [],
  };
}

function page(...ids: string[]): Page {
  return { id: "page", title: "", blocks: ids.map(block) };
}

describe("centralized block lookup", () => {
  it("returns the indexed block and raw index", () => {
    const p = page("a", "b", "c");
    expect(findBlockIndex(p, "b")).toBe(1);
    expect(findBlock(p, "b")).toBe(p.blocks[1]);
  });

  it("does not rescan the array for a repeated validated lookup", () => {
    let idReads = 0;
    const blocks = Array.from({ length: 1000 }, (_, index) => {
      const id = `b${index}`;
      return {
        type: "paragraph",
        charRuns: [],
        formats: [],
        get id() {
          idReads++;
          return id;
        },
      } as Block;
    });
    const p: Page = { id: "page", title: "", blocks };

    expect(findBlockIndex(p, "b900")).toBe(900);
    expect(idReads).toBeGreaterThan(900);

    idReads = 0;
    expect(findBlockIndex(p, "b900")).toBe(900);
    expect(idReads).toBe(1);
  });

  it("rebuilds after an in-place same-length reorder", () => {
    const p = page("a", "b", "c");
    expect(findBlockIndex(p, "b")).toBe(1);

    [p.blocks[0], p.blocks[1]] = [p.blocks[1], p.blocks[0]];

    expect(findBlockIndex(p, "b")).toBe(0);
    expect(findBlock(p, "b")?.id).toBe("b");
  });

  it("rebuilds after an in-place append", () => {
    const p = page("a");
    expect(findBlockIndex(p, "missing")).toBe(-1);

    p.blocks.push(block("b"));

    expect(findBlockIndex(p, "b")).toBe(1);
  });

  it("rebuilds a cached miss after an in-place replacement", () => {
    const p = page("a", "b");
    expect(findBlockIndex(p, "c")).toBe(-1);

    p.blocks[1] = block("c");

    expect(findBlockIndex(p, "c")).toBe(1);
    expect(findBlock(p, "b")).toBeUndefined();
  });
});
