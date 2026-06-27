/**
 * Custom node/mark serialization is sourced from the instance.
 *
 * Regression for the divergence where built-in types derived their codec from
 * the node/mark instance (`codecFromNode`, `mark.codec`) but custom types
 * registered via `extend()` silently fell back to a generic codec, dropping a
 * node's own `outputMarkdown`/… methods and a mark's `render.codec`. The
 * instance is the single source of truth; these tests prove `extend()` honors
 * that, and rejects a second, conflicting source.
 */

import { Mark, type MarkStyle } from "./rendering/marks/Mark";
import { AtomicNode } from "./rendering/nodes/AtomicNode";
import { baseSchema, defineMark, defineNode } from "./schema";
import { type OutputCtx } from "./serlization/codecs";
import type { MarkCodec } from "./serlization/codecs/mark-codec";
import type { Block } from "./serlization/loadPage";
import type { BlockBounds } from "./state-types";
import { InvariantError } from "@shared/invariant";
import { describe, expect, it } from "vitest";

function block(type: string): Block {
  return { id: "b1", orderKey: "a0", deleted: false, type } as unknown as Block;
}
const noCtx = {} as OutputCtx;

/** A class-first node that owns its full markdown/HTML/text round-trip. */
class FancyNode extends AtomicNode {
  readonly type = "fancy" as Block["type"];
  protected intrinsicHeight(): number {
    return 24;
  }
  protected draw(_box: BlockBounds): void {}
  outputMarkdown(): string {
    return ":::fancy:::";
  }
  outputHTML(): string {
    return '<div class="fancy"></div>';
  }
  outputText(): string {
    return "fancy-text";
  }
}

/** A class-first node with no serialization — must hit the generic fallback. */
class PlainNode extends AtomicNode {
  readonly type = "plain" as Block["type"];
  protected intrinsicHeight(): number {
    return 24;
  }
  protected draw(_box: BlockBounds): void {}
}

const HIGHLIGHT_CODEC: MarkCodec = {
  type: "highlight",
  toMarkdown: (t) => `==${t}==`,
};

class HighlightMark extends Mark {
  readonly type = "highlight";
  readonly codec = HIGHLIGHT_CODEC;
  style(): MarkStyle {
    return { color: "#ff0" };
  }
}

describe("custom node serialization sourced from the node", () => {
  const schema = baseSchema.extend({ nodes: [new FancyNode()] });

  it("uses the node's own round-trip methods, not the generic tag codec", () => {
    const codec = schema.data.getCodec("fancy")!;
    expect(codec.markdown.output(block("fancy"), noCtx)).toBe(":::fancy:::");
    expect(codec.html.output(block("fancy"), noCtx)).toBe(
      '<div class="fancy"></div>',
    );
    expect(codec.text.output(block("fancy"), noCtx)).toBe("fancy-text");
    // The generic fallback would register an `x-fancy` HTML tag; the node-derived
    // codec doesn't (the node declared no `htmlTags`).
    expect(codec.markdown.htmlTags).toBeUndefined();
  });

  it("falls back to the generic <x-type /> round-trip when the node has none", () => {
    const plain = baseSchema.extend({ nodes: [new PlainNode()] });
    const codec = plain.data.getCodec("plain")!;
    expect(codec.markdown.output(block("plain"), noCtx)).toBe("<x-plain />");
    expect(codec.markdown.htmlTags).toEqual(["x-plain"]);
  });

  it("rejects a node that ALSO supplies a defineNode serialization override", () => {
    expect(() =>
      defineNode("fancy", { node: new FancyNode(), toMarkdown: () => "x" }),
    ).toThrow(InvariantError);
  });
});

describe("custom mark serialization sourced from the Mark", () => {
  it("flows the render Mark's codec into the data schema", () => {
    const schema = baseSchema.extend({
      marks: [defineMark("highlight", { render: new HighlightMark() })],
    });
    // The bug: this used to be undefined (extend read defineMark's `codec`, not
    // the render Mark's), so the mark replicated and painted but never serialized.
    expect(schema.data.getMarkCodec("highlight")).toBe(HIGHLIGHT_CODEC);
    expect(schema.marks.find((m) => m.type === "highlight")).toBeInstanceOf(
      HighlightMark,
    );
  });

  it("still serializes a data-only mark via defineMark's codec (no render)", () => {
    const schema = baseSchema.extend({
      marks: [defineMark("highlight", { codec: HIGHLIGHT_CODEC })],
    });
    expect(schema.data.getMarkCodec("highlight")).toBe(HIGHLIGHT_CODEC);
  });

  it("rejects two disagreeing codecs (render Mark vs defineMark config)", () => {
    const other: MarkCodec = { type: "highlight", toMarkdown: (t) => `~${t}~` };
    expect(() =>
      baseSchema.extend({
        marks: [
          defineMark("highlight", {
            render: new HighlightMark(),
            codec: other,
          }),
        ],
      }),
    ).toThrow(InvariantError);
  });

  it("rejects a render Mark whose type doesn't match the declared type", () => {
    expect(() =>
      baseSchema.extend({
        marks: [defineMark("mismatch", { render: new HighlightMark() })],
      }),
    ).toThrow(InvariantError);
  });
});
