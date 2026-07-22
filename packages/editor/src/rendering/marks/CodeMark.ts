/** code → a colored chip + fill color. (Toggle action in `./toggle-actions`.) */

import type { MarkCodec } from "../../serlization/codecs/mark-codec";
import { CODE_END, CODE_START } from "../../serlization/tokenizer";
import {
  Mark,
  type MarkStyle,
  type MarkStyleCtx,
  type SelectionWrapTrigger,
} from "./Mark";

const CODE_CODEC: MarkCodec = {
  type: "code",
  toMarkdown: (t) => `\`${t}\``,
  tokens: { start: CODE_START, end: CODE_END },
  html: { priority: 0, render: (inner) => `<code>${inner}</code>` },
};

export class CodeMark extends Mark {
  readonly type = "code";
  readonly codec = CODE_CODEC;
  readonly selectionWrap: readonly SelectionWrapTrigger[] = [{ char: "`" }];
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
