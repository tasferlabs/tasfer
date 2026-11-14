/** Action vocabulary shared by display and inline structured math hosts. */

import { stateAction } from "@tasfer/editor/action-bus";

/**
 * Inserts a command picked from a menu into the formula the caret is in. `text`
 * is the LaTeX to insert. It replaces the `\query` the user typed (or `/query`,
 * with `trigger: "/"`), or the selection inside the formula. With neither, it
 * goes in at the caret. `caretOffset` is not used today: the caret goes to the
 * new command's first slot, or after it when it has none. Nothing happens when
 * the caret is not in a formula. It also works in a formula inside a table
 * cell.
 *
 * ```ts
 * editor.dispatch(INSERT_MATH_COMMAND, { text: "\\frac{}{}" });
 * ```
 */
export const INSERT_MATH_COMMAND = stateAction<{
  readonly text: string;
  readonly caretOffset?: number;
  readonly trigger?: "\\" | "/";
}>("insert-math-command", (state) => ({ state, ops: [] }), {
  forwardable: true,
});

/**
 * Resizes the matrix the caret or selection is in to `rows` × `cols`. Nothing
 * happens when the caret is not in a matrix. Like {@link INSERT_MATH_COMMAND},
 * it also works in a formula inside a table cell.
 *
 * ```ts
 * editor.dispatch(RESIZE_MATH_MATRIX, { rows: 3, cols: 3 });
 * ```
 */
export const RESIZE_MATH_MATRIX = stateAction<{
  readonly rows: number;
  readonly cols: number;
}>("resize-math-matrix", (state) => ({ state, ops: [] }), {
  forwardable: true,
});
