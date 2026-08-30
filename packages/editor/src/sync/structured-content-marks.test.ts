/**
 * Inline marks inside structured text fields.
 *
 * The store is the same char CRDT block text uses, so these assert the two
 * properties that make cell-level rich text safe: marks anchor to character
 * identities (they survive concurrent edits inside their range and resolve
 * through the very same `resolveMarkRunsFromChars` the block path uses), and
 * every write leaves the document in one canonical shape (so peers that reach
 * the same state by different routes stay byte-identical).
 */

import { resolveMarkRunsFromChars } from "../mark-runs";
import { iterateAllChars } from "./char-runs";
import {
  applyStructuredEdit,
  applyStructuredEdits,
  canonicalizeStructuredDocument,
  cloneStructuredDocumentWithFreshIdentities,
  createStructuredDocument,
  getStructuredMarks,
  getStructuredText,
  invertStructuredEdit,
  type StructuredDocument,
  type StructuredEdit,
  validateStructuredDocument,
} from "./structured-content";
import { createDeterministicIdentityAllocator } from "@shared/identity";
import { describe, expect, it } from "vitest";

const CONTENT_ID = "content0";
const NODE_ID = "cell0";

/** A one-cell document whose `text` field holds `text`, chars `p:0…p:n-1`. */
function cellWith(text: string): StructuredDocument {
  let document = applyStructuredEdit(
    createStructuredDocument("example", CONTENT_ID),
    {
      kind: "node_insert",
      node: {
        id: CONTENT_ID,
        type: "root",
        placement: { parentId: null, slot: "", orderKey: "" },
      },
    },
  );
  document = applyStructuredEdit(document, {
    kind: "node_insert",
    node: {
      id: NODE_ID,
      type: "cell",
      placement: { parentId: CONTENT_ID, slot: "cells", orderKey: "a0" },
      textFields: { text: [] },
    },
  });
  return applyStructuredEdit(document, {
    kind: "text_insert",
    nodeId: NODE_ID,
    field: "text",
    afterCharId: null,
    charRuns: [{ peerId: "p", startCounter: 0, text }],
  });
}

/** Char ids `p:from … p:to`, inclusive. */
function charIds(from: number, to: number): string[] {
  const ids: string[] = [];
  for (let i = from; i <= to; i++) ids.push(`p:${i}`);
  return ids;
}

function mark(
  from: number,
  to: number,
  type = "strong",
  attrs?: Record<string, unknown>,
  value = true,
): StructuredEdit {
  return {
    kind: "mark_set",
    nodeId: NODE_ID,
    field: "text",
    charIds: charIds(from, to),
    mark: attrs ? { type, attrs } : { type },
    value,
  };
}

/** The field's mark runs, resolved exactly as the render path resolves them. */
function runs(document: StructuredDocument) {
  const node = document.nodes[NODE_ID];
  return resolveMarkRunsFromChars(
    iterateAllChars([...node.textFields.text]),
    getStructuredMarks(document, NODE_ID, "text"),
  );
}

describe("structured content marks", () => {
  it("marks a range and resolves it to caret-edge offsets", () => {
    const document = applyStructuredEdit(cellWith("hello world"), mark(0, 4));

    expect(getStructuredMarks(document, NODE_ID, "text")).toHaveLength(1);
    expect(runs(document)).toEqual([
      { name: "strong", attrs: {}, startIndex: 0, endIndex: 5, text: "hello" },
    ]);
  });

  it("carries a mark's attributes", () => {
    const document = applyStructuredEdit(
      cellWith("see docs"),
      mark(4, 7, "link", { url: "https://example.com" }),
    );

    expect(runs(document)).toEqual([
      {
        name: "link",
        attrs: { url: "https://example.com" },
        startIndex: 4,
        endIndex: 8,
        text: "docs",
      },
    ]);
  });

  it("splits a span when the middle is unmarked", () => {
    let document = applyStructuredEdit(cellWith("hello world"), mark(0, 10));
    document = applyStructuredEdit(
      document,
      mark(5, 5, "strong", undefined, false),
    );

    expect(runs(document)).toEqual([
      { name: "strong", attrs: {}, startIndex: 0, endIndex: 5, text: "hello" },
      { name: "strong", attrs: {}, startIndex: 6, endIndex: 11, text: "world" },
    ]);
  });

  it("unions overlapping spans of the same mark instead of shrinking one", () => {
    let document = applyStructuredEdit(cellWith("hello world"), mark(0, 4));
    document = applyStructuredEdit(document, mark(3, 7));

    expect(getStructuredMarks(document, NODE_ID, "text")).toHaveLength(1);
    expect(runs(document)).toEqual([
      {
        name: "strong",
        attrs: {},
        startIndex: 0,
        endIndex: 8,
        text: "hello wo",
      },
    ]);
  });

  it("keeps a mark over text another peer inserts inside its range", () => {
    let document = applyStructuredEdit(cellWith("hello world"), mark(0, 4));
    document = applyStructuredEdit(document, {
      kind: "text_insert",
      nodeId: NODE_ID,
      field: "text",
      afterCharId: "p:1",
      // A later counter than every existing char, so RGA splices it at the
      // anchor rather than skipping past higher-id neighbours.
      charRuns: [{ peerId: "q", startCounter: 100, text: "XY" }],
    });

    expect(getStructuredText(document, NODE_ID, "text")).toBe("heXYllo world");
    expect(runs(document)).toEqual([
      {
        name: "strong",
        attrs: {},
        startIndex: 0,
        endIndex: 7,
        text: "heXYllo",
      },
    ]);
  });

  it("keeps a mark resolvable when its anchor character is deleted", () => {
    let document = applyStructuredEdit(cellWith("hello world"), mark(0, 4));
    document = applyStructuredEdit(document, {
      kind: "text_delete",
      nodeId: NODE_ID,
      field: "text",
      charIds: ["p:0"],
    });

    expect(getStructuredText(document, NODE_ID, "text")).toBe("ello world");
    expect(runs(document)).toEqual([
      { name: "strong", attrs: {}, startIndex: 0, endIndex: 4, text: "ello" },
    ]);
  });

  it("ignores a mark over a field the node does not have", () => {
    const document = cellWith("hello");
    const edited = applyStructuredEdit(document, {
      kind: "mark_set",
      nodeId: NODE_ID,
      field: "caption",
      charIds: ["p:0"],
      mark: { type: "strong" },
      value: true,
    });

    expect(edited).toBe(document);
  });

  it("is a no-op when the mark is already exactly applied", () => {
    const document = applyStructuredEdit(cellWith("hello"), mark(0, 4));

    expect(applyStructuredEdit(document, mark(0, 4))).toBe(document);
  });

  it("leaves no markFields key on a node that carries no marks", () => {
    const document = cellWith("hello");

    expect("markFields" in document.nodes[NODE_ID]).toBe(false);
  });

  it("drops markFields again when the last mark is removed", () => {
    let document = applyStructuredEdit(cellWith("hello"), mark(0, 4));
    document = applyStructuredEdit(
      document,
      mark(0, 4, "strong", undefined, false),
    );

    expect("markFields" in document.nodes[NODE_ID]).toBe(false);
  });

  describe("inverses", () => {
    it("restores an unmarked range", () => {
      const before = cellWith("hello world");
      const edit = mark(0, 4);
      const after = applyStructuredEdit(before, edit);
      const restored = applyStructuredEdits(
        after,
        invertStructuredEdit(edit, before),
      );

      expect(canonicalizeStructuredDocument(restored)).toEqual(
        canonicalizeStructuredDocument(before),
      );
    });

    it("restores the mark a range already carried", () => {
      const before = applyStructuredEdit(
        cellWith("hello world"),
        mark(0, 4, "link", { url: "a" }),
      );
      const edit = mark(2, 6, "link", { url: "b" });
      const after = applyStructuredEdit(before, edit);
      const restored = applyStructuredEdits(
        after,
        invertStructuredEdit(edit, before),
      );

      expect(runs(after)).toEqual([
        {
          name: "link",
          attrs: { url: "b" },
          startIndex: 0,
          endIndex: 7,
          text: "hello w",
        },
      ]);
      expect(canonicalizeStructuredDocument(restored)).toEqual(
        canonicalizeStructuredDocument(before),
      );
    });

    it("restores a removed mark", () => {
      const before = applyStructuredEdit(cellWith("hello world"), mark(0, 10));
      const edit = mark(5, 5, "strong", undefined, false);
      const after = applyStructuredEdit(before, edit);
      const restored = applyStructuredEdits(
        after,
        invertStructuredEdit(edit, before),
      );

      // An inverse restores what the field READS as, not necessarily the same
      // span partition: re-marking the hole leaves three abutting spans where
      // there was one. That matches block-level undo, which fragments the same
      // way, and the two are indistinguishable once resolved — which is the
      // property that has to hold, so it is the one asserted.
      expect(runs(restored)).toEqual([
        {
          name: "strong",
          attrs: {},
          startIndex: 0,
          endIndex: 5,
          text: "hello",
        },
        { name: "strong", attrs: {}, startIndex: 5, endIndex: 6, text: " " },
        {
          name: "strong",
          attrs: {},
          startIndex: 6,
          endIndex: 11,
          text: "world",
        },
      ]);
      expect(getStructuredText(restored, NODE_ID, "text")).toBe("hello world");
    });
  });

  describe("canonical form", () => {
    it("survives a validation round-trip byte-identically", () => {
      const document = applyStructuredEdit(cellWith("hello world"), mark(0, 4));

      expect(validateStructuredDocument(document)).toEqual(
        canonicalizeStructuredDocument(document),
      );
    });

    it("does not depend on the order two disjoint marks were applied in", () => {
      const forward = applyStructuredEdits(cellWith("hello world"), [
        mark(0, 4),
        mark(6, 10, "emphasis"),
      ]);
      const backward = applyStructuredEdits(cellWith("hello world"), [
        mark(6, 10, "emphasis"),
        mark(0, 4),
      ]);

      expect(JSON.stringify(canonicalizeStructuredDocument(forward))).toBe(
        JSON.stringify(canonicalizeStructuredDocument(backward)),
      );
    });

    it("rejects a seed whose mark span names a missing field", () => {
      const document = cellWith("hello");
      const seeded = applyStructuredEdit(document, {
        kind: "node_insert",
        node: {
          id: "cell1",
          type: "cell",
          placement: { parentId: CONTENT_ID, slot: "cells", orderKey: "a1" },
          textFields: { text: [] },
          markFields: {
            caption: [
              { startCharId: "p:0", endCharId: "p:1", format: { type: "s" } },
            ],
          },
        },
      });

      expect(seeded).toBe(document);
    });
  });

  it("re-addresses span anchors when cloned into a fresh identity domain", () => {
    const source = applyStructuredEdit(cellWith("hello world"), mark(0, 4));
    const clone = cloneStructuredDocumentWithFreshIdentities(
      source,
      "content1",
      createDeterministicIdentityAllocator("clone"),
    );

    const cloned = Object.values(clone.nodes).find(
      (node) => node.type === "cell",
    )!;
    const spans = cloned.markFields!.text;
    expect(spans).toHaveLength(1);
    // Anchors point at the clone's own characters, not the source's.
    expect(spans[0].startCharId.startsWith("p:")).toBe(false);
    expect(
      resolveMarkRunsFromChars(
        iterateAllChars([...cloned.textFields.text]),
        spans,
      ),
    ).toEqual([
      { name: "strong", attrs: {}, startIndex: 0, endIndex: 5, text: "hello" },
    ]);
  });
});
