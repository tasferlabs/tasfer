/**
 * strong → bold weight (the styles-free `bold` flag; metric-affecting).
 *
 * `bold` is a flag rather than a {@link MarkStyle} channel because bold weight
 * changes text *metrics* (caret/wrap geometry); the measurement engine reads it
 * without resolving a theme.
 */

import { stateAction } from "../../action-bus";
import { toggleBold } from "../../actions/actions";
import { Mark, type MarkStyle } from "./Mark";

export class StrongMark extends Mark {
  readonly type = "strong";
  readonly bold = true;
  style(): MarkStyle {
    return {};
  }
}

/**
 * Toggle the `strong` (bold) mark over the selection (Ctrl/Cmd+B). Co-located
 * with the mark it toggles; wraps the pure `toggleBold` transform so hosts can
 * observe/override it. Emits the resulting CRDT format ops.
 */
export const TOGGLE_BOLD = stateAction("toggle-bold", (state) => {
  const result = toggleBold(state);
  return { state: result.state, ops: result.ops };
});
