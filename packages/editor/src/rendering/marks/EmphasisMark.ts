/** emphasis → italic. (The Ctrl/Cmd+I toggle lives in `./toggle-actions`.) */

import type { MarkCodec } from "../../serlization/codecs/mark-codec";
import { ITALIC_END, ITALIC_START } from "../../serlization/tokenizer";
import { Mark, type MarkStyle } from "./Mark";

const EMPHASIS_CODEC: MarkCodec = {
  type: "emphasis",
  toMarkdown: (t) => `*${t}*`,
  tokens: { start: ITALIC_START, end: ITALIC_END },
  html: { priority: 2, render: (inner) => `<em>${inner}</em>` },
};

export class EmphasisMark extends Mark {
  readonly type = "emphasis";
  readonly codec = EMPHASIS_CODEC;
  style(): MarkStyle {
    return { italic: true };
  }
}
