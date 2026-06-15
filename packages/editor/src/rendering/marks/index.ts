/**
 * Mark registry wiring — the inline-mark analogue of `rendering/nodes`.
 *
 * A `MarkRegistry` is per-editor-instance (created at mount, stored on
 * `EditorState.marks`), not a module global. Hosts compose the set of marks
 * they want: pass a custom `marks` list to `mountEditor`, or use
 * `createDefaultMarkRegistry()` for the built-in set.
 */

export { createDefaultMarkRegistry, createMarkRegistry } from "./builtins";
export { CodeMark, TOGGLE_CODE } from "./CodeMark";
export { EmphasisMark, TOGGLE_ITALIC } from "./EmphasisMark";
export { LinkMark } from "./LinkMark";
export {
  Mark,
  type MarkChipStyle,
  type MarkOverlayCtx,
  MarkRegistry,
  type MarkReplacement,
  type MarkReplacementDims,
  type MarkReplacementPaintCtx,
  type MarkStyle,
  type MarkStyleCtx,
  type MarkUnderlineStyle,
} from "./Mark";
export { MathMark } from "./MathMark";
export { StrikeMark, TOGGLE_STRIKE } from "./StrikeMark";
export { StrongMark, TOGGLE_BOLD } from "./StrongMark";
