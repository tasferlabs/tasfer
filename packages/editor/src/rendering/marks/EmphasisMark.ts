/** emphasis → italic. */

import { Mark, type MarkStyle } from "./Mark";

export class EmphasisMark extends Mark {
  readonly type = "emphasis";
  style(): MarkStyle {
    return { italic: true };
  }
}
