/**
 * Opt-in math feature bundle.
 *
 * The editor core deliberately does not include math in its base schema. Hosts
 * that want display and inline math compose this feature into their schema:
 *
 *   const schema = baseSchema.use(mathExtension());
 *
 * The bundle is the worker-safe data extension (specs that already carry their
 * Markdown syntax, structured-mark behavior, and the shared kind's clone
 * adapter) plus the interactive-only pieces: the rendering node/mark, the
 * kind's selection adapters (clipboard serializer and range resolver), and
 * the live input rules.
 */

import { mathContentSelectionKind } from "./content-selection";
import { type MathBlockAttrs, mathDataExtension } from "./data";
import type { MathMarkAttrs } from "./inline-structured";
import { mathInputRules } from "./input-rules";
import { MathMark } from "./MathMark";
import { MathNode } from "./MathNode";
import { mathPasteRule } from "./paste";
import type {
  FeatureInputRule,
  FeaturePasteRule,
} from "@tasfer/editor/feature-facets";
import type { BlockSpec, MarkDef } from "@tasfer/editor/schema";
import type { StructuredKindSpec } from "@tasfer/editor/sync/schema";

export type { MathBlockAttrs } from "./data";

/**
 * What {@link mathExtension} returns: everything the editor needs for block
 * and inline math, ready to pass to `schema.use(...)`.
 *
 * @group Setup
 */
export type MathFeatureExtension = {
  readonly name: "math";
  readonly nodes: readonly [BlockSpec<"math", MathBlockAttrs>];
  readonly marks: readonly [MarkDef<"math", MathMarkAttrs>];
  readonly structuredKinds: readonly [StructuredKindSpec, StructuredKindSpec];
  readonly inputRules: readonly FeatureInputRule[];
  readonly pasteRules: readonly FeaturePasteRule[];
};

/**
 * Adds block and inline math to an editor schema. Each call returns a new
 * bundle, so every editor gets its own.
 *
 * ```ts
 * import { baseSchema, createEditor } from "@tasfer/editor";
 * import { mathExtension } from "@tasfer/math";
 *
 * const schema = baseSchema.use(mathExtension());
 * const editor = createEditor({ element, schema });
 * ```
 *
 * For workers and servers with no canvas, use {@link mathDataExtension}.
 *
 * Math is not in `baseSchema`, and `@tasfer/editor` never imports this package.
 * An editor without math pays nothing for it. Install `@tasfer/tex` next to
 * this package; it is a peer dependency.
 *
 * Without math in the schema, `$…$` and `$$…$$` stay plain text, kept exactly
 * as written. So Markdown read without math loses no formulas.
 *
 * @group Setup
 */
export function mathExtension(): MathFeatureExtension {
  const data = mathDataExtension();
  return {
    name: "math",
    nodes: [
      {
        ...data.blocks[0],
        node: new MathNode(),
      },
    ],
    marks: [
      {
        ...data.marks[0],
        render: new MathMark(),
      },
    ],
    structuredKinds: [...data.structuredKinds, mathContentSelectionKind],
    inputRules: mathInputRules,
    pasteRules: [mathPasteRule],
  };
}
