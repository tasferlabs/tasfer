/**
 * strong → bold weight (the styles-free `bold` flag; metric-affecting).
 *
 * `bold` is a flag rather than a {@link MarkStyle} channel because bold weight
 * changes text *metrics* (caret/wrap geometry); the measurement engine reads it
 * without resolving a theme.
 */

import { Mark, type MarkStyle } from "./Mark";

export class StrongMark extends Mark {
  readonly type = "strong";
  readonly bold = true;
  style(): MarkStyle {
    return {};
  }
}
