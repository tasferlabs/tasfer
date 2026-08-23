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

export type MathFeatureExtension = {
  readonly name: "math";
  readonly nodes: readonly [BlockSpec<"math", MathBlockAttrs>];
  readonly marks: readonly [MarkDef<"math", MathMarkAttrs>];
  readonly structuredKinds: readonly [StructuredKindSpec, StructuredKindSpec];
  readonly inputRules: readonly FeatureInputRule[];
  readonly pasteRules: readonly FeaturePasteRule[];
};

/** Build a fresh, instance-safe math feature bundle. */
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
