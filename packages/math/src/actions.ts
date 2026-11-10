/** Action vocabulary shared by display and inline structured math hosts. */

import { stateAction } from "@tasfer/editor/action-bus";

/**
 * Host command-palette insertion claimed by an active structured equation.
 * Forwardable: a node holding an inline formula in a text field (a table
 * cell) runs it there, the way it runs a key press.
 */
export const INSERT_MATH_COMMAND = stateAction<{
  readonly text: string;
  readonly caretOffset?: number;
  readonly trigger?: "\\" | "/";
}>("insert-math-command", (state) => ({ state, ops: [] }), {
  forwardable: true,
});

/**
 * Resize the structured matrix containing the active math-tree caret.
 * Forwardable, like {@link INSERT_MATH_COMMAND}.
 */
export const RESIZE_MATH_MATRIX = stateAction<{
  readonly rows: number;
  readonly cols: number;
}>("resize-math-matrix", (state) => ({ state, ops: [] }), {
  forwardable: true,
});
