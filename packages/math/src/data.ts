/**
 * Canvas-free data facet of the optional math feature.
 *
 * Import this entry in workers, persistence code, and Markdown tooling. It
 * registers the CRDT shape, codecs, Markdown syntax, and structured-content
 * adapters without constructing MathNode/MathMark or importing their canvas
 * interaction/selection stack (including the `@tasfer/tex` layout engine —
 * this entry reaches only `@tasfer/tex/data`). Interactive hosts normally
 * install the full bundle from `@tasfer/math` instead, which adds
 * the rendering classes, live input rules, and the clipboard selection
 * serializer.
 */

import {
  cloneMathStructuredContent,
  mathBlockCodec,
  mathDisplaySyntaxRule,
  mathInlineSyntaxRule,
  mathMarkCodec,
  mathStructuredContentSource,
} from "./codecs";
import {
  type MathMarkAttrs,
  mathStructuredMarkFacet,
} from "./inline-structured";
import { MATH_STRUCTURED_KIND } from "./structured";
import { BLOCK_REGISTRY } from "@tasfer/editor/sync/block-registry";
import type {
  BlockSpecCore,
  MarkSpec,
  StructuredKindSpec,
} from "@tasfer/editor/sync/schema";

/**
 * The attributes stored on a math block. `displayMode` is always `true` for a
 * block equation.
 *
 * A math block's text is empty. The formula lives in the block's math
 * document, not in its text. Read it as LaTeX with
 * {@link getStructuredMathSource}.
 */
export type MathBlockAttrs = {
  readonly displayMode: boolean;
};

/**
 * What {@link mathDataExtension} returns: the math block, the inline math mark
 * and the math content kind, with no canvas code. Add it to a data schema in
 * workers, servers and Markdown tools.
 */
export type MathDataExtension = {
  readonly blocks: readonly [BlockSpecCore<"math", MathBlockAttrs>];
  readonly marks: readonly [MarkSpec<"math", MathMarkAttrs>];
  readonly structuredKinds: readonly [StructuredKindSpec];
};

/**
 * Math with no canvas code: the math block, the inline math mark, how they read
 * and write Markdown, HTML and text, and the math content kind. Add it to a
 * data schema in workers, servers and Markdown tools. It leaves out typing
 * rules and selection handling. For an interactive editor, use
 * {@link mathExtension}.
 *
 * ```ts
 * import { baseDataSchema, createDoc } from "@tasfer/editor";
 * import { mathDataExtension } from "@tasfer/math/data";
 *
 * const dataSchema = baseDataSchema.extend(mathDataExtension());
 * const doc = createDoc({ markdown, schema: dataSchema });
 * ```
 *
 * Keep this data schema matched with the editor's schema, built with
 * {@link mathExtension}. Put each in its own module. Then a worker that imports
 * the data schema never loads the canvas code.
 */
// Each piece registers on the spec that owns it: the block spec carries the
// display syntax rule, the mark spec carries the inline rule and
// structured-mark behavior, and the shared structured kind carries the snapshot
// clone adapter. Live input rules and the clipboard selection serializer belong
// to the interactive extension so this worker-safe entry never reaches the
// selection stack, the tex layout engine, the canvas, or the rendering graph.
export function mathDataExtension(): MathDataExtension {
  return {
    blocks: [
      {
        type: "math",
        descriptor: BLOCK_REGISTRY.math,
        codec: mathBlockCodec,
        markdownSyntax: [mathDisplaySyntaxRule],
      },
    ],
    marks: [
      {
        type: "math",
        codec: mathMarkCodec,
        markdownSyntax: [mathInlineSyntaxRule],
        structured: mathStructuredMarkFacet,
      },
    ],
    structuredKinds: [
      {
        kind: MATH_STRUCTURED_KIND,
        clone: cloneMathStructuredContent,
        source: mathStructuredContentSource,
      },
    ],
  };
}

// The stable structured model belongs to the feature's data surface too: the
// ids, readers and converters a host needs to find and read a formula. The
// tree-editing engine and the codecs stay internal; they reach hosts through
// mathDataExtension() and MathNode.
export {
  getStructuredMathMarkSource,
  type InlineMathHostBlock,
  type MathMarkAttrs,
  mathMarkContentId,
  type ResolvedInlineMathRun,
  resolveStructuredInlineMathRuns,
} from "./inline-structured";
export {
  getMathStructuredDocument,
  getStructuredMathSource,
  MATH_STRUCTURED_KIND,
  mathContentIdForBlock,
  type MathDocumentInitMutation,
  type MathStructuredProjectionOptions,
  parseMathDocumentInit,
  type ParseMathInitOptions,
  structuredToMathDocument,
} from "./structured";
// Caret types that the public tree-selection helpers on the full entry take
// and return.
export type { MathRowCaret, MathTextCaret, MathTreeCaret } from "./tree-edit";
/**
 * Editable TeX AST node. The alias keeps it distinct from the interactive
 * `MathNode` renderer exported by the full `@tasfer/math` entry.
 */
export type { MathNode as MathDocumentNode } from "@tasfer/tex/data";
export {
  type IdentityAllocator,
  type MathDelimited,
  type MathDocument,
  type MathFraction,
  type MathItemId,
  type MathMatrix,
  type MathMatrixCell,
  type MathMatrixRow,
  type MathNode,
  type MathOperator,
  type MathRadical,
  type MathRawLatex,
  type MathRawText,
  type MathRoot,
  type MathRow,
  type MathScripts,
  type MathSymbol,
  type MathSymbolClass,
  type MathText,
  type MathTextVariant,
  parseMathDocument,
  type ParseMathDocumentOptions,
  printMathDocument,
} from "@tasfer/tex/data";
