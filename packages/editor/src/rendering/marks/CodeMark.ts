/** code → a colored chip + fill color. */

import { stateAction } from "../../action-bus";
import { toggleCode } from "../../actions/actions";
import { Mark, type MarkStyle, type MarkStyleCtx } from "./Mark";

export class CodeMark extends Mark {
  readonly type = "code";
  style({ styles }: MarkStyleCtx): MarkStyle {
    const code = styles.textFormats.code;
    return {
      color: code.color,
      background: {
        color: code.backgroundColor,
        padding: code.padding,
        borderRadius: code.borderRadius,
      },
    };
  }
}

/**
 * Toggle the `code` mark over the selection. Co-located with the mark it
 * toggles; wraps the pure `toggleCode` transform. Emits the resulting CRDT
 * format ops.
 */
export const TOGGLE_CODE = stateAction("toggle-code", (state) => {
  const result = toggleCode(state);
  return { state: result.state, ops: result.ops };
});
