/** code → a colored chip + fill color. */

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
