/**
 * Opt-in math feature bundle.
 *
 * The editor core deliberately does not include math in its base schema. Hosts
 * that want display and inline math compose this feature into their schema:
 *
 *   const schema = baseSchema.use(mathExtension());
 *   const treeSchema = baseSchema.use(
 *     mathExtension({ displayEditing: "tree" }),
 *   );
 *
 * Keeping the bundle in one place is important even before the math integration
 * moves to its own published package: the display node and inline renderer share
 * input actions and must be installed together.
 */

import type {
  FeatureContentSelectionSerializer,
  FeatureInputRule,
  FeatureStructuredContentCloneFacet,
  FeatureStructuredMarkFacet,
  FeatureSyntaxRule,
} from "./feature-facets";
import { type MathBlockAttrs, mathDataExtension } from "./math/data";
import type { MathMarkAttrs } from "./math/inline-structured";
import { inlineMathTreeInputRule } from "./math/inline-tree-state";
import { mathInputRules, mathTreeInputRules } from "./math/input-rules";
import { MathNode } from "./nodes/MathNode";
import { MathMark } from "./rendering/marks/MathMark";
import type { BlockSpec, MarkDef } from "./schema";

export type { MathBlockAttrs } from "./math/data";

/** Select the persistence/editing model used for interactive display math. */
export type MathDisplayEditing = "legacy" | "tree";
/** Select the persistence/editing model used for inline MathMark. */
export type MathInlineEditing = "legacy" | "tree";

export type MathExtensionOptions = {
  /**
   * `tree` lazily migrates a display equation on its first edit and makes the
   * structured MathDocument authoritative. The compatibility default retains
   * char-run editing until a host opts into the new interaction slice.
   */
  readonly displayEditing?: MathDisplayEditing;
  /**
   * `tree` enables the experimental supplemental MathDocument interaction for
   * inline marks. It is opt-in until every flat range/unformat/clone path can
   * preserve the attachment. The default remains the complete legacy editor.
   */
  readonly inlineEditing?: MathInlineEditing;
};

export type MathFeatureExtension = {
  readonly name: "math";
  readonly nodes: readonly [BlockSpec<"math", MathBlockAttrs>];
  readonly marks: readonly [MarkDef<"math", MathMarkAttrs>];
  readonly markdownSyntax: readonly FeatureSyntaxRule[];
  readonly inputRules: readonly FeatureInputRule[];
  readonly contentSelections: readonly [FeatureContentSelectionSerializer];
  readonly structuredMarks: readonly [FeatureStructuredMarkFacet];
  readonly structuredContentClones: readonly [
    FeatureStructuredContentCloneFacet,
  ];
};

/** Build a fresh, instance-safe math feature bundle. */
export function mathExtension(
  options: MathExtensionOptions = {},
): MathFeatureExtension {
  const node = new MathNode();
  const inlineTree = options.inlineEditing === "tree";
  const mark = new MathMark({ treeEditing: inlineTree });
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
    structuredMarks: data.structuredMarks,
    structuredContentClones: data.structuredContentClones,
    inputRules: [
      ...(inlineTree ? [inlineMathTreeInputRule] : []),
      ...(options.displayEditing === "tree"
        ? mathTreeInputRules
        : mathInputRules),
    ],
  };
}
