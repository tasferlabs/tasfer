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
import {
  toggleCode,
  toggleEmphasis,
  toggleStrike,
  toggleStrong,
} from "../../actions/actions";

/** Toggle the `strong` (bold) mark over the selection (Ctrl/Cmd+B). */
export const TOGGLE_STRONG = stateAction("toggle-strong", (state) => {
  const result = toggleStrong(state);
  return { state: result.state, ops: result.ops };
});

/** Toggle the `emphasis` (italic) mark over the selection (Ctrl/Cmd+I). */
export const TOGGLE_EMPHASIS = stateAction("toggle-emphasis", (state) => {
  const result = toggleEmphasis(state);
  return { state: result.state, ops: result.ops };
});

/** Toggle the `strike` (strike-through) mark over the selection. */
export const TOGGLE_STRIKE = stateAction("toggle-strike", (state) => {
  const result = toggleStrike(state);
  return { state: result.state, ops: result.ops };
});

/** Toggle the `code` mark over the selection. */
export const TOGGLE_CODE = stateAction("toggle-code", (state) => {
  const result = toggleCode(state);
  return { state: result.state, ops: result.ops };
});

/**
 * The built-in mark toggles, grouped — exposed at the package root as
 * `MarkActions`. This is the one toolbar vocabulary the engine and a host share
 * (named after the CRDT marks `strong`/`emphasis`/`strike`/`code`, not
 * bold/italic), so a host wiring formatting buttons dispatches
 * `editor.dispatch(MarkActions.TOGGLE_STRONG)`.
 */
export const MarkActions = {
  TOGGLE_STRONG,
  TOGGLE_EMPHASIS,
  TOGGLE_STRIKE,
  TOGGLE_CODE,
} as const;
