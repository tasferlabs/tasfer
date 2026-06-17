/**
 * End-to-end proof that a custom block type works through the data and
 * serialization layers: define a node, register it on a schema, and round-trip
 * it through a Doc (parse → CRDT → markdown). Also covers the preserve-and-
 * degrade behavior when a doc meets a block type its schema doesn't know.
 *
 * Note the `(b.type as string)` casts below: `Block` is a closed union, so
 * comparing `b.type` to a custom name needs a cast. A `getBlockType()`-style
 * helper for consumers is a tracked DX follow-up.
 */

import { createDoc } from "./doc";
import { baseSchema, defineNode } from "./schema";
import type { Block } from "./serlization/loadPage";
import { serializeToMarkdown } from "./serlization/serializer";
import type { BlockInsert } from "./state-types";
import { applyOp } from "./sync/reducer";
import { describe, expect, it } from "vitest";

function isCallout(b: Block): boolean {
  return (b.type as string) === "callout";
}
function attrs(b: Block | undefined): Record<string, unknown> {
  return b as unknown as Record<string, unknown>;
}

const callout = defineNode("callout", {
  attrs: {
    tone: { default: "note" },
  },
  render: { background: "rgba(0,0,0,0.04)" },
});

const schema = baseSchema.extend({ nodes: [callout] });

describe("custom node round-trip", () => {
  it("parses a custom block from markdown into the CRDT", () => {
    const doc = createDoc({
      markdown: `# Title\n\n<x-callout tone="warn" />`,
      schema: schema.data,
    });
    const blocks = doc.getBlocks().filter((b) => !b.deleted);
    const calloutBlock = blocks.find(isCallout);
    expect(calloutBlock).toBeDefined();
    expect(attrs(calloutBlock).tone).toBe("warn");
  });

  it("round-trips a custom block back to markdown", () => {
    const md = `<x-callout tone="warn" />`;
    const doc = createDoc({ markdown: md, schema: schema.data });
    expect(doc.getMarkdown()).toBe(md);
  });

  it("applies the attr default when the markdown omits it", () => {
    const doc = createDoc({
      markdown: `<x-callout />`,
      schema: schema.data,
    });
    expect(attrs(doc.getBlocks().find(isCallout)).tone).toBe("note");
  });

  it("validates a custom attr via block_set", () => {
    const doc = createDoc({
      markdown: `<x-callout tone="note" />`,
      schema: schema.data,
    });
    const id = doc.getBlocks().find(isCallout)!.id;
    doc.applyUpdate(
      [
        {
          op: "block_set",
          id: "p1:100",
          clock: { counter: 100, peerId: "p1" },
          pageId: doc.pageId,
          blockId: id,
          field: "tone",
          value: "danger",
        },
      ],
      "test",
    );
    expect(attrs(doc.getBlocks().find((b) => b.id === id)).tone).toBe("danger");
  });
});

describe("unknown block type degrades, never crashes", () => {
  it("a base-schema doc drops a block_insert for a type it doesn't know", () => {
    // A peer running the callout schema sends a callout block_insert to a
    // replica that only has the base schema. It must not throw, and must not
    // materialize a block it can't model.
    const doc = createDoc({ markdown: "# Hi" /* base schema */ });
    const before = doc.getBlocks().length;
    const op: BlockInsert = {
      op: "block_insert",
      id: "p2:5",
      clock: { counter: 5, peerId: "p2" },
      pageId: doc.pageId,
      afterBlockId: null,
      blockId: "b-callout",
      blockType: "callout",
    };
    expect(() => doc.applyUpdate([op], "remote")).not.toThrow();
    // No materialized block for the unknown type.
    expect(doc.getBlocks().some((b) => b.id === "b-callout")).toBe(false);
    expect(doc.getBlocks().length).toBe(before);
  });

  it("applyOp on an unknown type via the base schema is a no-op, not a throw", () => {
    const page = createDoc({ markdown: "x" }).getBlocks();
    const op: BlockInsert = {
      op: "block_insert",
      id: "p3:1",
      clock: { counter: 1, peerId: "p3" },
      pageId: "",
      afterBlockId: null,
      blockId: "b-x",
      blockType: "totally-made-up",
    };
    expect(() =>
      applyOp({ id: "", title: "", blocks: page }, op),
    ).not.toThrow();
  });

  it("serializing an unknown block via the base schema skips it cleanly", () => {
    // A block whose type the base schema lacks serializes to "" (no codec),
    // rather than throwing.
    const rogue = {
      id: "b-rogue",
      afterId: null,
      deleted: false as const,
      type: "callout",
      tone: "warn",
    };
    expect(() =>
      serializeToMarkdown([rogue as unknown as Block]),
    ).not.toThrow();
  });
});

describe("baseSchema.extend is immutable", () => {
  it("does not mutate the base schema", () => {
    expect(baseSchema.data.hasBlock("callout")).toBe(false);
    expect(schema.data.hasBlock("callout")).toBe(true);
    // base nodes unchanged — the built-in node set (now sourced from
    // defaultNodes(): Line, Image, Math, Code, Text, List), plus the one added.
    const baseCount = baseSchema.nodes.length;
    expect(schema.nodes.length).toBe(baseCount + 1);
  });
});
