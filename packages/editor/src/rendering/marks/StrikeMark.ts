/** strike → strike-through. */

import { Mark, type MarkStyle } from "./Mark";

export class StrikeMark extends Mark {
  readonly type = "strike";
  style(): MarkStyle {
    return { strikethrough: true };
  }
}
