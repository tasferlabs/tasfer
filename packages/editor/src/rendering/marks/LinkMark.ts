/** link → link color + underline. */

import type { MarkCodec } from "../../serlization/codecs/mark-codec";
import type { EditorState, Position } from "../../state-types";
import { isTextualBlock } from "../../sync/block-registry";
import { findCharInRuns, iterateVisibleChars } from "../../sync/char-runs";
import { Mark, type MarkStyle, type MarkStyleCtx } from "./Mark";

// `link` is parsed specially (its url arrives after its text), so it declares a
// `toMarkdown` but no paired `tokens`. `html.priority` keeps it outermost (4).
const LINK_CODEC: MarkCodec = {
  type: "link",
  toMarkdown: (t, mark) => (mark.attrs?.url ? `[${t}](${mark.attrs.url})` : t),
  html: {
    priority: 4,
    render: (inner, mark, ctx) =>
      mark.attrs?.url
        ? `<a href="${ctx.escapeAttr(String(mark.attrs.url))}">${inner}</a>`
        : inner,
  },
};

export class LinkMark extends Mark {
  readonly type = "link";
  readonly togglable = false; // needs a url — applied via the link action
  readonly codec = LINK_CODEC;
  style({ styles }: MarkStyleCtx): MarkStyle {
    const link = styles.textFormats.link;
    return {
      color: link.color,
      underline: { color: link.color, thickness: link.underlineThickness },
    };
  }
}

/**
 * Get link information at a given position
 * Returns the link data (url, text, start, end) if the position is within a link
 */
export function getLinkAtPosition(
  position: Position,
  state: EditorState,
): {
  url: string;
  text: string;
  startIndex: number;
  endIndex: number;
} | null {
  const block = state.document.page.blocks[position.blockIndex];
  if (!block || block.deleted) return null;
  if (!block) return null;

  if (!isTextualBlock(block)) return null;

  // Find the char at this position
  let visibleIndex = 0;
  let charIdAtPosition: string | null = null;

  for (const { id } of iterateVisibleChars(block.charRuns)) {
    if (visibleIndex === position.textIndex) {
      charIdAtPosition = id;
      break;
    }
    visibleIndex++;
  }

  if (!charIdAtPosition) return null;

  // Find if this char is within a link format span
  for (const formatSpan of block.formats) {
    if (formatSpan.format.type !== "link") continue;

    // Check if charIdAtPosition is within this span using findCharInRuns
    const startChar = findCharInRuns(block.charRuns, formatSpan.startCharId);
    const endChar = findCharInRuns(block.charRuns, formatSpan.endCharId);
    const charAtPos = findCharInRuns(block.charRuns, charIdAtPosition);

    if (!startChar || !endChar || !charAtPos) continue;

    // Check if charAtPos is between startChar and endChar
    // We need to compare positions by iterating through visible chars
    let startVisIndex = -1;
    let endVisIndex = -1;
    let charAtPosVisIndex = -1;
    visibleIndex = 0;

    for (const { id } of iterateVisibleChars(block.charRuns)) {
      if (id === formatSpan.startCharId) {
        startVisIndex = visibleIndex;
      }
      if (id === formatSpan.endCharId) {
        endVisIndex = visibleIndex;
      }
      if (id === charIdAtPosition) {
        charAtPosVisIndex = visibleIndex;
      }
      visibleIndex++;
    }

    if (
      startVisIndex !== -1 &&
      endVisIndex !== -1 &&
      charAtPosVisIndex !== -1 &&
      charAtPosVisIndex >= startVisIndex &&
      charAtPosVisIndex <= endVisIndex
    ) {
      // Get the text of the link
      const linkText: string[] = [];
      visibleIndex = 0;
      for (const { char } of iterateVisibleChars(block.charRuns)) {
        if (visibleIndex >= startVisIndex && visibleIndex <= endVisIndex) {
          linkText.push(char);
        }
        if (visibleIndex > endVisIndex) break;
        visibleIndex++;
      }

      return {
        url: (formatSpan.format.attrs?.url as string | undefined) || "",
        text: linkText.join(""),
        startIndex: startVisIndex,
        endIndex: endVisIndex + 1,
      };
    }
  }

  return null;
}
