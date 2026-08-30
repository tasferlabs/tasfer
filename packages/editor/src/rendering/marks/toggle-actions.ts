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
 * Toggle one inline mark, named as data.
 *
 * The single choke point every mark toggle funnels through — the four keyboard
 * toggles below, and the host's `setMark`. A node whose text lives in a
 * structured attachment registers ONE handler here and gets bold, italic,
 * strike and code at once; without it, the toggle resolves a flat selection
 * range, finds none, and silently does nothing.
 *
 * The mark is a name, never a class, so core stays mark-agnostic: an unknown or
 * disallowed name no-ops in `toggleFormat` exactly as it did before.
 */
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

/** Toggle the `strike` (strike-through) mark over the selection. */
export const TOGGLE_STRIKE = stateAction("toggle-strike", (state) =>
  state.actionBus.dispatchState(TOGGLE_MARK, state, { name: "strike" }),
);

/** Toggle the `code` mark over the selection. */
export const TOGGLE_CODE = stateAction("toggle-code", (state) =>
  state.actionBus.dispatchState(TOGGLE_MARK, state, { name: "code" }),
);
