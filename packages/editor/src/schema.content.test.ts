/**
 * `restrict({ content })` — the document-shape half of the authoring schema.
 * Covers compilation and validation on the schema, the repair the import path
 * performs, and the guarantee that a schema with no expression behaves exactly
 * as it did before the feature existed.
 */

import { baseSchema } from "./schema";
import { loadPage } from "./serlization/loadPage";
import { normalizeBlocks } from "./serlization/normalize";
import { InvariantError } from "@shared/invariant";
import { describe, expect, it } from "vitest";

const shaped = baseSchema.restrict({ content: "heading1 paragraph+" }).data;

function typesOf(markdown: string, schema = shaped): string[] {
  return loadPage(markdown, schema).blocks.map((block) => block.type);
}

describe("restrict({ content })", () => {
  it("accepts only sequences the expression matches", () => {
    expect(shaped.contentAccepts(["heading1", "paragraph"])).toBe(true);
    expect(shaped.contentAccepts(["heading1", "paragraph", "paragraph"])).toBe(
      true,
    );
    expect(shaped.contentAccepts(["heading1"])).toBe(false);
    expect(shaped.contentAccepts(["paragraph"])).toBe(false);
    expect(shaped.contentAccepts(["heading1", "image"])).toBe(false);
  });

  it("names the tail a sequence is still missing", () => {
    expect(shaped.contentFill(["heading1"])).toEqual(["paragraph"]);
    expect(shaped.contentFill(["heading1", "paragraph"])).toEqual([]);
    // Not repairable by appending — the sequence itself is illegal.
    expect(shaped.contentFill(["image"])).toBeNull();
  });

  it("reports the types allowed at a position", () => {
    expect(shaped.contentTypesAt([], 0)).toEqual(["heading1"]);
    expect(shaped.contentTypesAt(["heading1"], 1)).toEqual(["paragraph"]);
  });

  it("resolves capability-derived group names", () => {
    const grouped = baseSchema.restrict({ content: "heading1 text*" }).data;
    expect(grouped.contentAccepts(["heading1", "bullet_list"])).toBe(true);
    expect(grouped.contentAccepts(["heading1", "image"])).toBe(false);
  });

  it("supports counted repetition and alternation", () => {
    const counted = baseSchema.restrict({
      content: "heading1 (paragraph|image){1,2}",
    }).data;
    expect(counted.contentAccepts(["heading1", "image"])).toBe(true);
    expect(counted.contentAccepts(["heading1", "image", "paragraph"])).toBe(
      true,
    );
    expect(
      counted.contentAccepts(["heading1", "image", "paragraph", "image"]),
    ).toBe(false);
  });

  it("rejects an expression the schema cannot back", () => {
    expect(() => baseSchema.restrict({ content: "callout+" })).toThrow(
      InvariantError,
    );
    expect(() => baseSchema.restrict({ content: "heading1 (" })).toThrow(
      InvariantError,
    );
    // The shape needs a type the allow-list forbids — unsatisfiable together.
    expect(() =>
      baseSchema.restrict({
        blocks: ["heading1"],
        content: "heading1 paragraph+",
      }),
    ).toThrow(/absent from the `blocks` allow-list/);
  });

  it("stops forcing the paragraph fallback into a shaped allow-list", () => {
    // Without an expression the fallback is always creatable…
    expect(
      baseSchema
        .restrict({ blocks: ["heading1"] })
        .data.isBlockAllowed("paragraph"),
    ).toBe(true);
    // …with one, representability comes from the expression itself.
    expect(
      baseSchema
        .restrict({ blocks: ["heading1"], content: "heading1+" })
        .data.isBlockAllowed("paragraph"),
    ).toBe(false);
  });
});

describe("content repair on import", () => {
  it("fills the tail a loaded document is missing", () => {
    expect(typesOf("# Title")).toEqual(["heading1", "paragraph"]);
  });

  it("morphs a block the shape rejects, preserving its text", () => {
    const page = loadPage("# A\n\n# B\n\nbody", shaped);
    expect(page.blocks.map((b) => b.type)).toEqual([
      "heading1",
      "paragraph",
      "paragraph",
    ]);
    // The demoted heading keeps its characters.
    const demoted = page.blocks[1] as unknown as {
      charRuns: { text: string }[];
    };
    expect(demoted.charRuns.map((run) => run.text).join("")).toBe("B");
  });

  it("drops a block that cannot be morphed into the shape", () => {
    // The `---` divider is a void block with no text to salvage, so the shape
    // pass drops it outright rather than demoting it.
    expect(typesOf("# Title\n\n---\n\nbody", baseSchema.data)).toContain(
      "line",
    );
    expect(typesOf("# Title\n\n---\n\nbody")).toEqual([
      "heading1",
      "paragraph",
      "paragraph",
    ]);
  });

  it("is deterministic — the same markdown normalizes identically", () => {
    const a = loadPage("# A\n\n# B\n\nbody", shaped);
    const b = loadPage("# A\n\n# B\n\nbody", shaped);
    expect(a.blocks.map((x) => [x.id, x.type, x.orderKey])).toEqual(
      b.blocks.map((x) => [x.id, x.type, x.orderKey]),
    );
  });
});

describe("a schema with no content expression is unaffected", () => {
  const plain = baseSchema.data;

  it("answers every content query permissively", () => {
    expect(plain.content).toBeUndefined();
    expect(plain.contentAccepts(["image", "image", "line"])).toBe(true);
    expect(plain.contentFill(["image"])).toEqual([]);
    expect(plain.contentTypesAt(["image"], 1)).toBeUndefined();
  });

  it("leaves normalizeBlocks an exact identity", () => {
    const blocks = loadPage("# A\n\nbody\n\n---\n").blocks;
    const normalized = normalizeBlocks(blocks, plain);
    expect(normalized).toEqual(blocks);
    expect(normalized.every((block, i) => block === blocks[i])).toBe(true);
  });

  it("loads a document with no shape repair", () => {
    expect(typesOf("# A\n\n# B\n\nbody", plain)).toEqual([
      "heading1",
      "heading1",
      "paragraph",
    ]);
  });
});
