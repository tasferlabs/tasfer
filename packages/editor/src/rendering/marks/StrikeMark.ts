/** strike → strike-through. */

import { stateAction } from "../../action-bus";
import { toggleStrikethrough } from "../../actions/actions";
import { Mark, type MarkStyle } from "./Mark";

export class StrikeMark extends Mark {
  readonly type = "strike";
  style(): MarkStyle {
    return { strikethrough: true };
  }
}

/**
 * Toggle the `strike` (strike-through) mark over the selection. Co-located with
 * the mark it toggles; wraps the pure `toggleStrikethrough` transform. Emits the
 * resulting CRDT format ops.
 */
export const TOGGLE_STRIKE = stateAction("toggle-strike", (state) => {
  const result = toggleStrikethrough(state);
  return { state: result.state, ops: result.ops };
});
