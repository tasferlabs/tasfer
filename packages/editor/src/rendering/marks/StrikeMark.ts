/** strike → strike-through. (The toggle action lives in `./toggle-actions`.) */

import type { MarkCodec } from "../../serlization/codecs/mark-codec";
import {
  STRIKETHROUGH_END,
  STRIKETHROUGH_START,
} from "../../serlization/tokenizer";
import { Mark, type MarkStyle } from "./Mark";

const STRIKE_CODEC: MarkCodec = {
  type: "strike",
  toMarkdown: (t) => `~~${t}~~`,
  tokens: { start: STRIKETHROUGH_START, end: STRIKETHROUGH_END },
  html: { priority: 3, render: (inner) => `<s>${inner}</s>` },
};

export class StrikeMark extends Mark {
  readonly type = "strike";
  readonly codec = STRIKE_CODEC;
  style(): MarkStyle {
    return { strikethrough: true };
  }
}
