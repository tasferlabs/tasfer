import type {
  Block,
  ContentPoint,
  ContentSelection,
  ContentTextPoint,
  DecorationRange,
  DocPoint,
  StructuredDocument,
  TextFieldInfo,
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
  /** Where to scroll to bring the match into view: a flat block offset, or
   * the match's own point inside a table cell. */
  readonly scrollTarget: DocPoint | ContentPoint;
}

interface OrderedFindMatch {
  readonly match: FindMatch;
  readonly blockOffset: number;
  /** Reading-order index of a structured prose field; -1 elsewhere. */
  readonly fieldIndex: number;
  readonly sourceOffset: number;
}

/** A field's char runs, read off the raw block. */
function fieldRuns(
  block: Block,
  field: TextFieldInfo,
): readonly {
  peerId: string;
  startCounter: number;
  text: string;
  deletedMask?: readonly number[];
}[] {
  return (
    block.structuredContent?.[field.contentId]?.nodes[field.nodeId]?.textFields[
      field.field
    ] ?? []
  );
}

/** Id of the visible character before each visible offset (null at 0). */
function idsBefore(
  runs: ReturnType<typeof fieldRuns>,
  offsets: readonly number[],
): (string | null)[] {
  const byOffset = new Map<number, string>();
  let visible = 0;
  for (const run of runs) {
    for (let k = 0; k < run.text.length; k++) {
      const byte = run.deletedMask?.[Math.floor(k / 8)];
      if (byte !== undefined && (byte & (1 << (k % 8))) !== 0) continue;
      visible += 1;
      byOffset.set(visible, `${run.peerId}:${run.startCounter + k}`);
    }
  }
  return offsets.map((offset) =>
    offset <= 0 ? null : (byOffset.get(offset) ?? null),
  );
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
    scrollTarget: { block: blockId, offset: scrollOffset },
  };
}

/**
 * Find flat prose, feature-owned math source and structured prose (a table's
 * cells, read through `textFields`) in document order.
 */
export function findDocumentMatches(
  blocks: readonly Block[],
  query: string,
  textFields: (block: Block) => readonly TextFieldInfo[] = () => [],
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
          fieldIndex: -1,
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
            scrollTarget: { block: block.id, offset: range.from },
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
              fieldIndex: -1,
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
              fieldIndex: -1,
              sourceOffset: range.from,
              match,
            });
          }
        }
      }
    }

    textFields(block).forEach((field, fieldIndex) => {
      const ranges = occurrenceRanges(field.text, query);
      if (ranges.length === 0) return;
      const ids = idsBefore(
        fieldRuns(block, field),
        ranges.flatMap((range) => [range.from, range.to]),
      );
      const point = (afterCharId: string | null): ContentTextPoint => ({
        kind: "text",
        blockId: block.id,
        contentId: field.contentId,
        nodeId: field.nodeId,
        field: field.field,
        afterCharId,
        affinity: "forward",
      });
      ranges.forEach((range, at) => {
        const selection: ContentSelection = {
          anchor: point(ids[at * 2]),
          focus: point(ids[at * 2 + 1]),
        };
        ordered.push({
          blockOffset: 0,
          fieldIndex,
          sourceOffset: range.from,
          match: {
            blockId: block.id,
            range: { from: selection.anchor, to: selection.focus },
            selection: { kind: "content", selection },
            scrollTarget: selection.anchor,
          },
        });
      });
    });

    ordered.sort(
      (left, right) =>
        left.blockOffset - right.blockOffset ||
        left.fieldIndex - right.fieldIndex ||
        left.sourceOffset - right.sourceOffset,
    );
    matches.push(...ordered.map(({ match }) => match));
  }
  return matches;
}
