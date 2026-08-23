/**
 * `@tasfer/math` — the display and inline math feature for `@tasfer/editor`.
 *
 * The engine has no math in its base schema and nothing in it imports this
 * package, so a host that never installs math never pulls the math stack — or
 * the `@tasfer/tex` layout engine it owns — into its bundle. That dependency is
 * why math is a package and not part of the engine.
 *
 * Consumers compose {@link mathExtension} into their schema and may use the
 * remaining exports to build host chrome around the feature. Workers and other
 * render-free contexts should import the data-only slice from
 * `@tasfer/math/data` instead, which carries no renderer and no layout call.
 */

export { getCompatibilityDataSchema, mathReplacementRenderer } from "./compat";
export {
  mathContentSelectionKind,
  resolveMathContentSelection,
  serializeMathContentSelection,
} from "./content-selection";
export * from "./data";
export {
  type TrailingMathCommandRun,
  trailingMathCommandRun,
} from "./input-controller";
export { mathInputRules } from "./input-rules";
export {
  isValidLatex,
  mathMatrixContext,
  mathMatrixContextInRange,
  mathMatrixResize,
  mathSourceAtEdge,
  type MatrixContext,
  type MatrixEditResult,
  type MatrixTextEdit,
  renderToSVG,
} from "./math";
export {
  filterMathCommands,
  MATH_COMMANDS,
  type MathCommand,
  mathCommandCaretOffset,
  mathCommandInsertion,
  unambiguousMathCommandCompletion,
} from "./math-commands";
export {
  type MathBlockAttrs,
  mathExtension,
  type MathFeatureExtension,
} from "./math-extension";
export { MathMark } from "./MathMark";
export {
  EXIT_INLINE_MATH,
  INSERT_MATH_COMMAND,
  type MathBlock,
  MathNode,
  RESIZE_MATH_MATRIX,
  SET_INLINE_MATH_HOVER,
  SET_MATH_BLOCK_HOVER,
} from "./MathNode";
export { isUnambiguousLatexPaste, mathPasteRule } from "./paste";
export {
  getCrossedInlineMathSpan,
  getInlineMathSpans,
  type InlineMathSpan,
} from "./spans";
export * from "./tree-selection";
