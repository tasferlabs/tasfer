/**
 * The built-in inline-mark toggle actions (Ctrl/Cmd+B/I, strike, code).
 *
 * These live beside the marks they act on, but in their OWN module rather than
 * on the `Mark` subclasses — deliberately. Each toggle wraps a pure transform
 * from `actions/actions`, which transitively pulls in the renderer/reducer
 * graph; keeping that import out of the mark CLASS files means constructing a
 * mark (`new StrongMark()`, as `defaultMarks()` does when assembling
 * `baseDataSchema`) stays light and free of an init-time import cycle. The
 * toggles don't reference their mark class — they're keyed only by name — so
 * nothing is lost by the split.
 */

import { stateAction } from "../../action-bus";
import { toggleFormat } from "../../actions/actions";

/**
 * Toggle one inline mark over the selection, given by its name.
 *
 * Every mark toggle goes through this action: {@link TOGGLE_STRONG} and the
 * other built-in toggles, and `setMark(name)` with no options. So a node that
 * keeps its text in a block attachment, like a table cell, can handle this one
 * action and get bold, italic, strike and code at once. Without such a handler,
 * the toggle finds no plain text selection there and does nothing.
 *
 * In your handler, return nothing when the selection is not in your node, so
 * the normal toggle runs. The easy way to handle it is
 * {@link runFieldAsParagraph}, which runs this same action on your text field.
 * If you write the toggle yourself, a collapsed caret needs no edit. Set
 * `state.ui.activeMarksMode` to `{ type: "explicit", formats }`, and put those
 * marks on the next characters your node inserts. That is what makes Ctrl+B,
 * then typing, come out bold.
 *
 * An unknown or disallowed mark name does nothing.
 *
 * @example
 * ```ts
 * bus.registerState(
 *   TOGGLE_MARK,
 *   (state, { name }) => {
 *     const cell = activeCell(state);
 *     if (!cell) return undefined; // not in a cell: the normal toggle runs
 *     const run = runFieldAsParagraph(state, cell.address, cell.range, (paragraph) =>
 *       paragraph.actionBus.dispatchState(TOGGLE_MARK, paragraph, { name }),
 *     );
 *     return run.kind === "applied"
 *       ? { state: run.state, ops: run.ops, handled: true }
 *       : { state, ops: [], handled: true };
 *   },
 *   100,
 * );
 * ```
 * @group Built-in actions
 */
// The mark is a name, never a class, so core stays mark-agnostic.
export const TOGGLE_MARK = stateAction<{ name: string }>(
  "toggle-mark",
  (state, { name }) => {
    const result = toggleFormat(state, name);
    return { state: result.state, ops: result.ops };
  },
);

/**
 * Toggle the `strong` (bold) mark over the selection (Ctrl/Cmd+B).
 *
 * @group Built-in actions
 */
export const TOGGLE_STRONG = stateAction("toggle-strong", (state) =>
  state.actionBus.dispatchState(TOGGLE_MARK, state, { name: "strong" }),
);

/**
 * Toggle the `emphasis` (italic) mark over the selection (Ctrl/Cmd+I).
 *
 * @group Built-in actions
 */
export const TOGGLE_EMPHASIS = stateAction("toggle-emphasis", (state) =>
  state.actionBus.dispatchState(TOGGLE_MARK, state, { name: "emphasis" }),
);

/**
 * Toggle the `strike` (strike-through) mark over the selection
 * (Ctrl/Cmd+Shift+X).
 *
 * @group Built-in actions
 */
export const TOGGLE_STRIKE = stateAction("toggle-strike", (state) =>
  state.actionBus.dispatchState(TOGGLE_MARK, state, { name: "strike" }),
);

/**
 * Toggle the `code` mark over the selection (Ctrl/Cmd+E).
 *
 * @group Built-in actions
 */
export const TOGGLE_CODE = stateAction("toggle-code", (state) =>
  state.actionBus.dispatchState(TOGGLE_MARK, state, { name: "code" }),
);
