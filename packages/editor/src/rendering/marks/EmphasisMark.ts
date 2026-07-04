/**
 * emphasis → italic. Italic is a metric-affecting variant ({@link MarkMetrics}),
 * not a {@link MarkStyle} channel: oblique glyphs have different advance widths,
 * so the measurement engine must apply it too — `style()` stays render-only and
 * contributes nothing. (The Ctrl/Cmd+I toggle lives in `./toggle-actions`.)
 */

import type { MarkCodec } from "../../serlization/codecs/mark-codec";
import { ITALIC_END, ITALIC_START } from "../../serlization/tokenizer";
import {
  Mark,
  type MarkMetrics,
  type MarkStyle,
  type SelectionWrapTrigger,
} from "./Mark";

const EMPHASIS_CODEC: MarkCodec = {
  type: "emphasis",
  toMarkdown: (t) => `*${t}*`,
  tokens: { start: ITALIC_START, end: ITALIC_END },
  html: { priority: 2, render: (inner) => `<em>${inner}</em>` },
};

export class EmphasisMark extends Mark {
  readonly type = "emphasis";
  readonly metrics: MarkMetrics = { italic: true };
  readonly codec = EMPHASIS_CODEC;
  // A single markdown delimiter means emphasis: `*x*` / `_x_`.
  readonly selectionWrap: readonly SelectionWrapTrigger[] = [
    { char: "*", level: 1 },
    { char: "_", level: 1 },
  ];
  style(): MarkStyle {
    return {};
  }
}
