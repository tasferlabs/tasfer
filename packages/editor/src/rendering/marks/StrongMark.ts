/**
 * strong → bold weight (the styles-free `metrics.bold` flag; metric-affecting).
 *
 * Bold lives in {@link MarkMetrics}, not as a {@link MarkStyle} channel, because
 * bold weight changes text *metrics* (caret/wrap geometry); the measurement
 * engine reads it without resolving a theme.
 *
 * The Ctrl/Cmd+B toggle action lives in `./toggle-actions` (kept out of this
 * file so constructing the mark stays free of the renderer/reducer graph).
 */

import type { MarkCodec } from "../../serlization/codecs/mark-codec";
import { BOLD_END, BOLD_START } from "../../serlization/tokenizer";
import { Mark, type MarkMetrics, type MarkStyle } from "./Mark";

// `html.priority` reproduces the prior fixed nesting order exactly:
// code (innermost) → strong → emphasis → strike → link (outermost).
const STRONG_CODEC: MarkCodec = {
  type: "strong",
  toMarkdown: (t) => `**${t}**`,
  tokens: { start: BOLD_START, end: BOLD_END },
  html: { priority: 1, render: (inner) => `<strong>${inner}</strong>` },
};

export class StrongMark extends Mark {
  readonly type = "strong";
  readonly metrics: MarkMetrics = { bold: true };
  readonly codec = STRONG_CODEC;
  style(): MarkStyle {
    return {};
  }
}
