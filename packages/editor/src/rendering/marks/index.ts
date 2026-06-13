/**
 * Mark registry wiring — the inline-mark analogue of `rendering/nodes`.
 *
 * A `MarkRegistry` is per-editor-instance (created at mount, stored on
 * `EditorState.marks`), not a module global. Hosts compose the set of marks
 * they want: pass a custom `marks` list to `mountEditor`, or use
 * `createDefaultMarkRegistry()` for the built-in set.
 */

export {
  codeMark,
  createDefaultMarkRegistry,
  createMarkRegistry,
  emphasisMark,
  linkMark,
  mathMark,
  strikeMark,
  strongMark,
} from "./builtins";
export {
  Mark,
  type MarkChipStyle,
  MarkRegistry,
  type MarkReplacement,
  type MarkReplacementDims,
  type MarkReplacementPaintCtx,
  type MarkStyle,
  type MarkStyleCtx,
  type MarkUnderlineStyle,
} from "./Mark";
