/**
 * Mark registry wiring — the inline-mark analogue of `rendering/nodes`.
 *
 * A `MarkRegistry` is per-editor-instance (created at mount, stored on
 * `EditorState.marks`), not a module global. Hosts compose the set of marks
 * they want: pass a custom `marks` list to `mountEditor`, or use
 * `createDefaultMarkRegistry()` for the built-in set.
 */

export {
  createDefaultMarkRegistry,
  createMarkRegistry,
  defaultMarks,
} from "./builtins";
export { CodeMark } from "./CodeMark";
export { EmphasisMark } from "./EmphasisMark";
export { LinkMark } from "./LinkMark";
export {
  Mark,
  type MarkChipStyle,
  type MarkOverlayCtx,
  MarkRegistry,
  type MarkReplacement,
  type MarkReplacementCaret,
  type MarkReplacementDims,
  type MarkReplacementEdit,
  type MarkReplacementPaintCtx,
  type MarkStyle,
  type MarkStyleCtx,
  type MarkUnderlineStyle,
} from "./Mark";
export { MathMark } from "./MathMark";
export { StrikeMark } from "./StrikeMark";
export { StrongMark } from "./StrongMark";
export {
  TOGGLE_BOLD,
  TOGGLE_CODE,
  TOGGLE_ITALIC,
  TOGGLE_STRIKE,
} from "./toggle-actions";
