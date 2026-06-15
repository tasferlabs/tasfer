/** emphasis → italic. */

import { stateAction } from "../../action-bus";
import { toggleItalic } from "../../actions/actions";
import { Mark, type MarkStyle } from "./Mark";

export class EmphasisMark extends Mark {
  readonly type = "emphasis";
  style(): MarkStyle {
    return { italic: true };
  }
}

/**
 * Toggle the `emphasis` (italic) mark over the selection (Ctrl/Cmd+I).
 * Co-located with the mark it toggles; wraps the pure `toggleItalic` transform.
 * Emits the resulting CRDT format ops.
 */
export const TOGGLE_ITALIC = stateAction("toggle-italic", (state) => {
  const result = toggleItalic(state);
  return { state: result.state, ops: result.ops };
});
