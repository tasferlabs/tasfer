/**
 * Class-first node registration — `schema.extend({ nodes: [new MyNode()] })`.
 *
 * Proves the inverted authoring style: a Node subclass that carries its own
 * facets (type, `static nodeConfig` for attrs/serialization, draw, overlays,
 * strings) can be registered directly, and produces the same data facets as the
 * config-style `defineNode`. The schema stays immutable — `extend` returns a new
 * one and never mutates `baseSchema`.
 */

import { AtomicNode } from "./rendering/nodes/AtomicNode";
import type { NodeRegionCtx } from "./rendering/nodes/Node";
import { baseSchema } from "./schema";
import type { Block, BlockBounds, NodeOverlay } from "./state-types";
import { describe, expect, it } from "vitest";

/** A custom leaf node authored as a class — the ergonomic the user asked for. */
class CalloutNode extends AtomicNode {
  // Custom types aren't in the built-in `Block["type"]` union; cast as the
  // existing BoxNode/defineNode idiom does.
  readonly type = "callout" as Block["type"];

  /** Attrs + serialization, read by `schema.extend` when registered directly. */
  static nodeConfig = { attrs: { tone: { default: "note" } } };

  /** Strings owned by the node (Step 1 contract), carried through registration. */
  readonly strings = { hint: "Add a note" } as const;

  protected intrinsicHeight(): number {
    return 48;
  }
  protected draw(_box: BlockBounds): void {}

  overlays(c: NodeRegionCtx): readonly NodeOverlay[] {
    return [
      {
        key: "callout-editor",
        blockIndex: c.blockIndex,
        rect: { x: c.origin.x, y: c.origin.y, width: c.maxWidth, height: 48 },
      },
    ];
  }
}

describe("class-first node registration", () => {
  const schema = baseSchema.extend({ nodes: [new CalloutNode()] });

  it("recognizes the custom type in the data schema, with attr defaults", () => {
    const block = schema.data.createDefaultBlock("callout", "b1", null);
    expect(block).toBeDefined();
    expect(block!.type).toBe("callout");
    // The default from `static nodeConfig.attrs.tone` was applied.
    expect((block as unknown as Record<string, unknown>).tone).toBe("note");
  });

  it("validates declared attrs and the type field", () => {
    expect(schema.data.validateField("callout", "tone", "warn")).toBe(true);
    expect(schema.data.validateField("callout", "type", "callout")).toBe(true);
  });

  it("registers the same node instance for rendering + overlay dispatch", () => {
    const node = schema.nodes.find((n) => n.type === "callout");
    expect(node).toBeInstanceOf(CalloutNode);
    // The node's own facets (strings + overlays) survive registration.
    expect(node!.strings).toEqual({ hint: "Add a note" });
    expect(typeof node!.overlays).toBe("function");
  });

  it("leaves baseSchema unmutated — extend() returns a new schema", () => {
    expect(
      baseSchema.data.createDefaultBlock("callout", "x", null),
    ).toBeUndefined();
    expect(baseSchema.nodes.some((n) => n.type === "callout")).toBe(false);
  });
});
