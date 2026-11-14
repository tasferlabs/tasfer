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
 * An unknown or disallowed mark name does nothing.
 */
// The mark is a name, never a class, so core stays mark-agnostic.
export const TOGGLE_MARK = stateAction<{ name: string }>(
  "toggle-mark",
  (state, { name }) => {
    const result = toggleFormat(state, name);
    return { state: result.state, ops: result.ops };
  },
);

/** Toggle the `strong` (bold) mark over the selection (Ctrl/Cmd+B). */
export const TOGGLE_STRONG = stateAction("toggle-strong", (state) =>
  state.actionBus.dispatchState(TOGGLE_MARK, state, { name: "strong" }),
);

/** Toggle the `emphasis` (italic) mark over the selection (Ctrl/Cmd+I). */
export const TOGGLE_EMPHASIS = stateAction("toggle-emphasis", (state) =>
  state.actionBus.dispatchState(TOGGLE_MARK, state, { name: "emphasis" }),
);

/**
 * Toggle the `strike` (strike-through) mark over the selection
 * (Ctrl/Cmd+Shift+X).
 */
export const TOGGLE_STRIKE = stateAction("toggle-strike", (state) =>
  state.actionBus.dispatchState(TOGGLE_MARK, state, { name: "strike" }),
);

/** Toggle the `code` mark over the selection (Ctrl/Cmd+E). */
export const TOGGLE_CODE = stateAction("toggle-code", (state) =>
  state.actionBus.dispatchState(TOGGLE_MARK, state, { name: "code" }),
);
