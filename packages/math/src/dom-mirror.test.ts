/**
 * Unit tests for the DomMirror diff/grouping decisions — the pure helpers that
 * decide *what* the accessible mirror does. The thin DOM-patching glue runs only
 * in a browser (the suite has no real DOM), so it is covered by the web build
 * and browser checks; here we pin the logic that governs surgical updates.
 */

import { getCompatibilityDataSchema } from "./compat";
import {
  affectedBlockIds,
  blockHtml,
  planChildren,
  structureSignature,
} from "@tasfer/editor/a11y/dom-mirror";
import type { Block } from "@tasfer/editor/serlization/loadPage";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import type { Operation } from "@tasfer/editor/state-types";
import { describe, expect, it } from "vitest";

// Math is opt-in, so these fixtures parse and mirror through the math-enabled
// compatibility schema — the mirror itself is schema-driven and carries no math
// knowledge of its own.
const schema = getCompatibilityDataSchema();

function op(blockId: string): Operation {
  return { op: "text_insert", blockId } as unknown as Operation;
}

describe("affectedBlockIds", () => {
  it("collects the touched block ids, deduped", () => {
    const ids = affectedBlockIds([op("a"), op("b"), op("a")]);
    expect([...ids].sort()).toEqual(["a", "b"]);
  });

  it("is empty for no ops", () => {
    expect(affectedBlockIds([]).size).toBe(0);
  });
});

describe("structureSignature", () => {
  const blocks = (...spec: [string, string][]): Block[] =>
    spec.map(([id, type]) => ({ id, type }) as unknown as Block);

  it("is stable when only content changes (same ids, order, types)", () => {
    const before = blocks(["a", "paragraph"], ["b", "heading1"]);
    const after = blocks(["a", "paragraph"], ["b", "heading1"]);
    expect(structureSignature(after)).toBe(structureSignature(before));
  });

  it("differs when a block is inserted", () => {
    const before = blocks(["a", "paragraph"]);
    const after = blocks(["a", "paragraph"], ["c", "paragraph"]);
    expect(structureSignature(after)).not.toBe(structureSignature(before));
  });

  it("differs when blocks are reordered", () => {
    const before = blocks(["a", "paragraph"], ["b", "paragraph"]);
    const after = blocks(["b", "paragraph"], ["a", "paragraph"]);
    expect(structureSignature(after)).not.toBe(structureSignature(before));
  });

  it("differs when a block changes type (can change grouping)", () => {
    const before = blocks(["a", "paragraph"]);
    const after = blocks(["a", "bullet_list"]);
    expect(structureSignature(after)).not.toBe(structureSignature(before));
  });
});

describe("planChildren", () => {
  it("groups consecutive same-kind list items under one list", () => {
    const { blocks } = loadPage("# H\n\npara\n\n- one\n- two\n");
    const plan = planChildren(blocks, schema);
    const lists = plan.filter((p) => p.kind === "list");
    // The two bullets collapse into a single list group; the heading/paragraph
    // (and any trailing empty paragraph) stay standalone blocks.
    expect(lists).toHaveLength(1);
    const list = lists[0];
    if (list.kind !== "list") throw new Error("expected list group");
    expect(list.tag).toBe("ul");
    expect(list.itemIds).toHaveLength(2);
    expect(
      plan.filter((p) => p.kind === "block").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("splits groups when the list kind changes", () => {
    const { blocks } = loadPage("- bullet\n\n1. numbered\n");
    const plan = planChildren(blocks, schema);
    const lists = plan.filter((p) => p.kind === "list");
    expect(lists).toHaveLength(2);
    expect((lists[0] as { tag: string }).tag).toBe("ul");
    expect((lists[1] as { tag: string }).tag).toBe("ol");
  });

  it("flags todo lists for the host's checkbox styling", () => {
    const { blocks } = loadPage("- [ ] task\n- [x] done\n");
    const plan = planChildren(blocks, schema);
    const list = plan.find((p) => p.kind === "list");
    if (!list || list.kind !== "list") throw new Error("expected list group");
    expect(list.todo).toBe(true);
    expect(list.itemIds).toHaveLength(2);
  });
});

describe("blockHtml", () => {
  it("serializes a heading to semantic markup", () => {
    const { blocks } = loadPage("# Title\n");
    expect(blockHtml(blocks[0], schema)).toContain("<h1");
  });

  it("serializes a list item to an <li>", () => {
    const { blocks } = loadPage("- item\n");
    expect(blockHtml(blocks[0], schema)).toContain("<li");
  });

  it("emits math as readable source, not an invisible SVG", () => {
    const { blocks } = loadPage("$$x^2$$\n", schema);
    const html = blockHtml(blocks[0], schema);
    // The block's flat text is empty; the readable text is the attachment's
    // canonical source (`x^2` prints as `{x}^{2}`).
    expect(html).toContain("{x}^{2}");
    expect(html).not.toContain("<svg");
  });
});
