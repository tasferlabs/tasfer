/**
 * Reusable feature composition through `Schema.use()`.
 *
 * `extend()` remains the low-level node/mark registration API; `use()` is the
 * public boundary extension packages target. They intentionally share the same
 * runtime normalization today.
 */

import { Mark, type MarkStyle } from "./rendering/marks/Mark";
import {
  baseSchema,
  defineMark,
  defineNode,
  type FeatureExtension,
  type Schema,
} from "./schema";
import type { BlockAttrs, MarkAttrs, SchemaDefinition } from "./schema-types";
import { describe, expect, expectTypeOf, it } from "vitest";

class FeatureHighlightMark extends Mark {
  readonly type = "feature_highlight";

  style(): MarkStyle {
    return { color: "#ffd43b" };
  }
}

const callout = defineNode("feature_callout", {
  attrs: {
    tone: { default: "note" },
  },
});

const highlight = defineMark("feature_highlight", {
  attrs: {
    color: { default: "yellow" },
  },
  render: new FeatureHighlightMark(),
});

const calloutFeature = {
  name: "callouts",
  nodes: [callout],
  marks: [highlight],
} as const satisfies FeatureExtension;

type DefinitionOf<S> = S extends Schema<infer D> ? D : never;

describe("Schema.use", () => {
  it("installs every node and mark facet in one reusable feature", () => {
    const schema = baseSchema.use(calloutFeature);

    expect(schema.data.hasBlock("feature_callout")).toBe(true);
    expect(schema.data.hasMark("feature_highlight")).toBe(true);
    expect(schema.nodes).toContain(callout.node);
    expect(schema.marks).toContain(highlight.render);
  });

  it("is immutable and has the same registration semantics as extend", () => {
    const used = baseSchema.use(calloutFeature);
    const extended = baseSchema.extend(calloutFeature);

    expect(baseSchema.data.hasBlock("feature_callout")).toBe(false);
    expect(baseSchema.data.hasMark("feature_highlight")).toBe(false);
    expect(used.data.getDescriptor("feature_callout")).toBe(
      extended.data.getDescriptor("feature_callout"),
    );
    expect(used.nodes).toEqual(extended.nodes);
    expect(used.marks).toEqual(extended.marks);
  });

  it("composes features through chaining", () => {
    const badge = defineNode("feature_badge");
    const schema = baseSchema
      .use(calloutFeature)
      .use({ name: "badges", nodes: [badge] });

    expect(schema.data.hasBlock("feature_callout")).toBe(true);
    expect(schema.data.hasMark("feature_highlight")).toBe(true);
    expect(schema.data.hasBlock("feature_badge")).toBe(true);
  });

  it("preserves exact inferred block and mark attribute types", () => {
    const _schema = baseSchema.use(calloutFeature);
    type Definition = DefinitionOf<typeof _schema>;

    expectTypeOf<Definition>().toMatchTypeOf<SchemaDefinition>();
    expectTypeOf<BlockAttrs<Definition, "feature_callout">>().toEqualTypeOf<{
      readonly tone: string;
    }>();
    expectTypeOf<MarkAttrs<Definition, "feature_highlight">>().toEqualTypeOf<{
      readonly color: string;
    }>();
  });
});
