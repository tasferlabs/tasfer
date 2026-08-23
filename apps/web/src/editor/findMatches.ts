import type {
  Block,
  ContentSelection,
  DecorationRange,
  StructuredDocument,
} from "@tasfer/editor";
import {
  getVisibleTextFromRuns,
  isTextualBlock,
} from "@tasfer/editor/internal";
import {
  getMathStructuredDocument,
  getStructuredMathSource,
  mathContentSelectionFromSourceOffset,
  resolveStructuredInlineMathRuns,
} from "@tasfer/math";

export type FindMatchSelection =
  | {
      readonly kind: "flat";
      readonly startIndex: number;
      readonly endIndex: number;
    }
  | {
      readonly kind: "content";
      readonly selection: ContentSelection;
    };

export interface FindMatch {
  readonly blockId: string;
  readonly range: DecorationRange;
  readonly selection: FindMatchSelection;
  /** Flat block offset used to bring the owning block into view. */
  readonly scrollOffset: number;
}

interface OrderedFindMatch {
  readonly match: FindMatch;
  readonly blockOffset: number;
  readonly sourceOffset: number;
}

function occurrenceRanges(source: string, query: string) {
  const ranges: Array<{ from: number; to: number }> = [];
  const haystack = source.toLowerCase();
  const needle = query.toLowerCase();
  let position = 0;
  while (position < haystack.length) {
    const from = haystack.indexOf(needle, position);
    if (from < 0) break;
    ranges.push({ from, to: from + query.length });
    position = from + 1;
  }
  return ranges;
}

function structuredMatch(
  blockId: string,
  contentId: string,
  document: StructuredDocument,
  from: number,
  to: number,
  scrollOffset: number,
): FindMatch | null {
  const anchor = mathContentSelectionFromSourceOffset(
    blockId,
    contentId,
    document,
    from,
  );
  const focus = mathContentSelectionFromSourceOffset(
    blockId,
    contentId,
    document,
    to,
  );
  if (!anchor || !focus) return null;

  const selection: ContentSelection = {
    anchor: anchor.focus,
    focus: focus.focus,
  };
  return {
    blockId,
    range: { from: selection.anchor, to: selection.focus },
    selection: { kind: "content", selection },
    scrollOffset,
  };
}

/** Find flat prose and feature-owned math source in document order. */
export function findDocumentMatches(
  blocks: readonly Block[],
  query: string,
): FindMatch[] {
  if (!query) return [];

  const matches: FindMatch[] = [];
  for (const block of blocks) {
    if (block.deleted) continue;
    const ordered: OrderedFindMatch[] = [];
    const appendFlatMatches = (text: string) => {
      for (const range of occurrenceRanges(text, query)) {
        ordered.push({
          blockOffset: range.from,
          sourceOffset: range.from,
          match: {
            blockId: block.id,
            range: {
              from: { block: block.id, offset: range.from },
              to: { block: block.id, offset: range.to },
            },
            selection: {
              kind: "flat",
              startIndex: range.from,
              endIndex: range.to,
            },
            scrollOffset: range.from,
          },
        });
      }
    };

    if ((block as { readonly type: string }).type === "math") {
      const document = getMathStructuredDocument(block);
      const source = document ? getStructuredMathSource(block) : undefined;
      if (document && source) {
        for (const range of occurrenceRanges(source, query)) {
          const match = structuredMatch(
            block.id,
            document.rootId,
            document,
            range.from,
            range.to,
            0,
          );
          if (match) {
            ordered.push({
              blockOffset: 0,
              sourceOffset: range.from,
              match,
            });
          }
        }
      } else if (isTextualBlock(block)) {
        appendFlatMatches(getVisibleTextFromRuns(block.charRuns));
      }
    } else if (isTextualBlock(block)) {
      appendFlatMatches(getVisibleTextFromRuns(block.charRuns));

      for (const run of resolveStructuredInlineMathRuns(block)) {
        if (!run.contentId || !run.document || !run.latex) continue;
        for (const range of occurrenceRanges(run.latex, query)) {
          const match = structuredMatch(
            block.id,
            run.contentId,
            run.document,
            range.from,
            range.to,
            run.startIndex,
          );
          if (match) {
            ordered.push({
              blockOffset: run.startIndex,
              sourceOffset: range.from,
              match,
            });
          }
        }
      }
    }

    ordered.sort(
      (left, right) =>
        left.blockOffset - right.blockOffset ||
        left.sourceOffset - right.sourceOffset,
    );
    matches.push(...ordered.map(({ match }) => match));
  }
  return matches;
}
