/**
 * Exports that `@tasfer/math/data` no longer offers, kept so 0.2 imports keep
 * working. None of them is part of the public API any more.
 *
 * @deprecated Each will be removed in a later release.
 */

export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  cloneMathStructuredContent,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mathBlockCodec,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mathBlockNodeCodec,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mathDisplaySyntaxRule,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mathInlineSyntaxRule,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mathMarkCodec,
} from "../codecs";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  createStructuredMathMarkAttachment,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  getInlineMathStructuredDocument,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  isInlineMathStructuredDocument,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mathStructuredMarkFacet,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type StructuredMathMarkAttachment,
} from "../inline-structured";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  normalizeMathSource,
} from "../source";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  getMathDocumentForBlock,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mathDocumentToStructured,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  validateStructuredMathDocument,
} from "../structured";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  adjacentMathTreeConstructRange,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  backspaceMathTree,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  completeMathCommand,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  deleteForwardMathTree,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  deleteMathTreeRange,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  expandMathTreeRangeToAtomicCommands,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  getMathTreeMatrixContext,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  getMathTreeRangeText,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  insertMathFraction,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  insertMathProseText,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  insertMathSemanticLatex,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  insertMathText,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  insertMathTextWithCompletion,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  isMathProseText,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type MathCommandCompletion,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type MathCommandCompletionResolver,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mathProseLatex,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type MathSemanticInsertionOptions,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type MathTreeEditFailure,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type MathTreeEditResult,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type MathTreeMatrixContext,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mathTreeMatrixTargetCaret,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type MathTreeMotion,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mathTreeNextRowEdgeCaret,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type MathTreeRange,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type MathTreeRangeTextResult,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mathTreeRowEdgeCaret,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  moveMathTreeCaret,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  replaceMathTextRange,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  replaceMathTreeRange,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  replaceMathTreeRangeWithSemanticLatex,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  resizeMathTreeMatrix,
} from "../tree-edit";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type AllocatedIdentity,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  createDeterministicIdentityAllocator,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  mathDocumentsSemanticallyEqual,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  parseAllocatedIdentity,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  printMathRow,
} from "@tasfer/tex/data";
