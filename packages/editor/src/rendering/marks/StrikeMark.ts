/** strike → strike-through. (The toggle action lives in `./toggle-actions`.) */

import type { MarkCodec } from "../../serlization/codecs/mark-codec";
import {
  STRIKETHROUGH_END,
  STRIKETHROUGH_START,
} from "../../serlization/tokenizer";
import { Mark, type MarkStyle, type SelectionWrapTrigger } from "./Mark";

const STRIKE_CODEC: MarkCodec = {
  type: "strike",
  toMarkdown: (t) => `~~${t}~~`,
  tokens: { start: STRIKETHROUGH_START, end: STRIKETHROUGH_END },
  html: { priority: 3, render: (inner) => `<s>${inner}</s>` },
};

/**
 * The built-in `strike` mark: struck-through text, written as `~~text~~` in
 * Markdown.
 */
export class StrikeMark extends Mark {
  readonly type = "strike";
  readonly codec = STRIKE_CODEC;
  readonly selectionWrap: readonly SelectionWrapTrigger[] = [{ char: "~" }];
  style(): MarkStyle {
    return { strikethrough: true };
  }
}
