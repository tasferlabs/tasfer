/**
 * Opt-in math feature bundle.
 *
 * The editor core deliberately does not include math in its base schema. Hosts
 * that want display and inline math compose this feature into their schema:
 *
 *   const schema = baseSchema.use(mathExtension());
 *
 * Keeping the bundle in one place is important even before the math integration
 * moves to its own published package: the display node and inline renderer share
 * input actions and must be installed together.
 */

import type {
  FeatureContentSelectionResolver,
  FeatureContentSelectionSerializer,
  FeatureInputRule,
  FeatureStructuredContentCloneFacet,
  FeatureStructuredMarkFacet,
  FeatureSyntaxRule,
} from "./feature-facets";
import { type MathBlockAttrs, mathDataExtension } from "./math/data";
import type { MathMarkAttrs } from "./math/inline-structured";
import { mathInputRules } from "./math/input-rules";
import { MathNode } from "./nodes/MathNode";
import { MathMark } from "./rendering/marks/MathMark";
import type { BlockSpec, MarkDef } from "./schema";

export type { MathBlockAttrs } from "./math/data";

export type MathFeatureExtension = {
  readonly name: "math";
  readonly nodes: readonly [BlockSpec<"math", MathBlockAttrs>];
  readonly marks: readonly [MarkDef<"math", MathMarkAttrs>];
  readonly markdownSyntax: readonly FeatureSyntaxRule[];
  readonly inputRules: readonly FeatureInputRule[];
  readonly contentSelections: readonly [FeatureContentSelectionSerializer];
  readonly contentSelectionResolvers: readonly [
    FeatureContentSelectionResolver,
  ];
  readonly structuredMarks: readonly [FeatureStructuredMarkFacet];
  readonly structuredContentClones: readonly [
    FeatureStructuredContentCloneFacet,
  ];
};

/** Build a fresh, instance-safe math feature bundle. */
export function mathExtension(): MathFeatureExtension {
  const node = new MathNode();
  const mark = new MathMark();
  const data = mathDataExtension();
  return {
    name: "math",
    nodes: [
      {
        ...data.blocks[0],
        node,
      },
    ],
    marks: [
      {
        ...data.marks[0],
        render: mark,
      },
    ],
    markdownSyntax: data.markdownSyntax,
    contentSelections: data.contentSelections,
    contentSelectionResolvers: data.contentSelectionResolvers,
    structuredMarks: data.structuredMarks,
    structuredContentClones: data.structuredContentClones,
    inputRules: mathInputRules,
  };
}
