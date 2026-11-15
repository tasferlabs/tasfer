/**
 * Exports that `@tasfer/math` no longer offers, kept so 0.2 imports keep
 * working. None of them is part of the public API any more.
 *
 * @deprecated Each will be removed in a later release.
 */

export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  getCompatibilityDataSchema,
} from "../compat";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  resolveMathContentSelection,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  serializeMathContentSelection,
} from "../content-selection";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  isValidLatex,
} from "../math";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mathCommandCaretOffset,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  unambiguousMathCommandCompletion,
} from "../math-commands";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  SET_INLINE_MATH_HOVER,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  SET_MATH_BLOCK_HOVER,
} from "../MathNode";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  isUnambiguousLatexPaste,
} from "../paste";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  getCrossedInlineMathSpan,
} from "../spans";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  contentPointToMathDocumentPosition,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  extendMathTreeContentSelection,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mathDocumentPositionToContentPoint,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mathSourceRangeFromContentSelection,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mathTreeCaretFromSourceOffset,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mathUnitBoundaryOffset,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  moveMathTreeCaretVertically,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  snapMathContentSelection,
} from "../tree-selection";
// What `@tasfer/math/data` keeps, which this entry re-exports too.
export * from "./data";
