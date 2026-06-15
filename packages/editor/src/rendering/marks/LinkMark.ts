/** link → link color + underline. */

import { Mark, type MarkStyle, type MarkStyleCtx } from "./Mark";

export class LinkMark extends Mark {
  readonly type = "link";
  readonly togglable = false; // needs a url — applied via the link action
  style({ styles }: MarkStyleCtx): MarkStyle {
    const link = styles.textFormats.link;
    return {
      color: link.color,
      underline: { color: link.color, thickness: link.underlineThickness },
    };
  }
}
