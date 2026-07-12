/** Action vocabulary shared by display and inline structured math hosts. */

import { stateAction } from "../action-bus";

/** Host command-palette insertion claimed by an active structured equation. */
export const INSERT_MATH_COMMAND = stateAction<{
  readonly text: string;
  readonly caretOffset?: number;
}>("insert-math-command", (state) => ({ state, ops: [] }));

/** Resize the structured matrix containing the active math-tree caret. */
export const RESIZE_MATH_MATRIX = stateAction<{
  readonly rows: number;
  readonly cols: number;
}>("resize-math-matrix", (state) => ({ state, ops: [] }));
