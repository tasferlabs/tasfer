import { baseSchema, defineNode } from "../schema";
import type { Block } from "../serlization/loadPage";
import type { BlockDelete, BlockInsert, BlockSet } from "../state-types";
import { invertOperation } from "./inverse";
import { applyOps, createEmptyPageState } from "./reducer";
import { blocksToOps } from "./snapshot-diff";
import { createCRDTbinding } from "./sync";
import { describe, expect, it } from "vitest";

const callout = defineNode("callout", {
  attrs: { tone: { default: "note" } },
  render: { background: "rgba(0,0,0,0.04)" },
});
const schema = baseSchema.extend({ nodes: [callout] }).data;

function calloutBlock(tone: string): Block {
  return {
    ...schema.createDefaultBlock("callout", "original", "a0")!,
    tone,
  } as Block;
}

describe("custom-schema replay helpers", () => {
  it("preserves extension-owned fields when projecting blocks to operations", () => {
    const binding = createCRDTbinding("page", "peer");
    const ops = blocksToOps([calloutBlock("warning")], {
      pageId: "page",
      peerId: binding.getPeerId(),
      nextId: binding.nextId,
      getClock: binding.getClock,
      schema,
    });

    const page = applyOps(createEmptyPageState("page"), ops, schema);
    expect(page.blocks).toHaveLength(1);
    expect(page.blocks[0].type).toBe("callout");
    expect((page.blocks[0] as unknown as { tone: string }).tone).toBe(
      "warning",
    );
  });

  it("captures extension-owned fields in block-delete inverses", () => {
    const binding = createCRDTbinding("page", "peer");
    const page = {
      id: "page",
      title: "",
      blocks: [calloutBlock("danger")],
    };
    const op: BlockDelete = {
      op: "block_delete",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: "page",
      blockId: "original",
    };

    const [inverse] = invertOperation(op, page, binding, schema);
    expect(inverse.op).toBe("block_insert");
    if (inverse.op !== "block_insert") throw new Error("expected insert");
    expect(inverse.initialProps?.tone).toBe("danger");

    const restored = applyOps(createEmptyPageState("page"), [inverse], schema);
    expect((restored.blocks[0] as unknown as { tone: string }).tone).toBe(
      "danger",
    );
  });

  it("reads extension-owned prior values when inverting block_set", () => {
    const binding = createCRDTbinding("page", "peer");
    const page = {
      id: "page",
      title: "",
      blocks: [calloutBlock("note")],
    };
    const op: BlockSet = {
      op: "block_set",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: "page",
      blockId: "original",
      field: "tone",
      value: "warning",
    };

    const [inverse] = invertOperation(op, page, binding, schema);
    expect(inverse).toMatchObject({
      op: "block_set",
      field: "tone",
      value: "note",
    });
  });

  it("replays a built-in-to-extension type morph through the instance schema", () => {
    const binding = createCRDTbinding("page", "peer");
    const insert: BlockInsert = {
      op: "block_insert",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: "page",
      blockId: "block",
      blockType: "paragraph",
      orderKey: "a0",
    };
    const morph: BlockSet = {
      op: "block_set",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: "page",
      blockId: "block",
      field: "type",
      value: "callout",
    };

    const page = applyOps(
      createEmptyPageState("page"),
      [insert, morph],
      schema,
    );
    expect(page.blocks[0]).toMatchObject({ type: "callout", tone: "note" });
  });
});
