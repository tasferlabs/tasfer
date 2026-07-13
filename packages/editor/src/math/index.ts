/**
 * Opt-in math feature entry point.
 *
 * Nothing in the root `@cypherkit/editor` entry imports this module. Consumers
 * that install math compose {@link mathExtension} into their schema and may use
 * the remaining exports to build host chrome around the feature.
 */

export { getInlineMathSpans, type InlineMathSpan } from "../inline-math-spans";
export {
  type MathBlockAttrs,
  mathExtension,
  type MathFeatureExtension,
} from "../math-extension";
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
} from "../nodes/math";
export {
  filterMathCommands,
  MATH_COMMANDS,
  type MathCommand,
  mathCommandCaretOffset,
  mathCommandInsertion,
  unambiguousMathCommandCompletion,
} from "../nodes/math-commands";
export {
  EXIT_INLINE_MATH,
  INSERT_MATH_COMMAND,
  type MathBlock,
  MathNode,
  RESIZE_MATH_MATRIX,
  SET_INLINE_MATH_HOVER,
  SET_MATH_BLOCK_HOVER,
} from "../nodes/MathNode";
export { MathMark } from "../rendering/marks/MathMark";
export * from "./data";
export { mathInputRules } from "./input-rules";
export * from "./tree-selection";
