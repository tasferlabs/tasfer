/**
 * Even heights for the caret and the highlight inside an inline formula.
 *
 * Left alone, each piece is as tall as its own ink: a selected `a` is a thin
 * strip, a selected `\sqrt{b}` a tall one, and the caret grows and shrinks as
 * it moves along. Prose doesn't do that — every letter on a line gets the
 * line's height. So here every piece on one row of the formula takes the
 * whole row's height, and the formula's own row (the one sitting on the text
 * line) fills the text line, like the prose around it.
 */

import type {
  MathDocumentCaretPosition,
  MathDocumentLayout,
} from "@tasfer/tex";

/** The vertical band a caret or highlight on one row fills. */
export interface InlineRowBand {
  /** Top relative to the formula baseline (negative = above), CSS px. */
  readonly top: number;
  /** Bottom relative to the formula baseline (positive = below), CSS px. */
  readonly bottom: number;
  /** The formula's own row: stand as tall as the text line instead. */
  readonly fillsLine: boolean;
}

/**
 * The row whose height `rowId` takes. The base of a power (`y` in `y^{2}`)
 * sits on its parent row's baseline and reads as part of that row, so it
 * takes the parent's height — otherwise a letter with an exponent would be
 * shorter than the letter beside it.
 */
function levelRow(layout: MathDocumentLayout, rowId: string) {
  let row = layout.items.get(rowId);
  while (row?.parentId) {
    const node = layout.items.get(row.parentId);
    if (
      node?.type !== "scripts" ||
      !node.parentId ||
      Math.abs(row.baseline - node.baseline) > 0.5
    ) {
      break;
    }
    const parent = layout.items.get(node.parentId);
    if (!parent) break;
    row = parent;
  }
  return row;
}

/** The band of the row `rowId`, or null when the layout doesn't know it. */
export function inlineRowBand(
  layout: MathDocumentLayout,
  rowId: string,
): InlineRowBand | null {
  const row = levelRow(layout, rowId);
  if (!row || row.bounds.height <= 0) return null;
  return {
    top: row.bounds.y,
    bottom: row.bounds.y + row.bounds.height,
    // The formula's body has no parent: it is the row on the text line.
    fillsLine: row.parentId === undefined,
  };
}

/**
 * The lowest row holding both ends of a range — the row a selection inside a
 * formula covers whole pieces of. Null when the ends share no row.
 */
export function commonRowId(
  layout: MathDocumentLayout,
  a: MathDocumentCaretPosition,
  b: MathDocumentCaretPosition,
): string | null {
  const chain = new Set<string>();
  for (let id: string | undefined = a.rowId; id;) {
    chain.add(id);
    id = layout.items.get(id)?.parentId;
  }
  for (let id: string | undefined = b.rowId; id;) {
    const item = layout.items.get(id);
    if (chain.has(id) && item?.type === "row") return id;
    id = item?.parentId;
  }
  return null;
}

/**
 * `rect` stretched to `band`: the line flag for the formula's own row, or
 * the row's top and bottom (never cutting into the rect's own extent).
 */
export function fitToRowBand<T extends { top: number; bottom: number }>(
  rect: T,
  band: InlineRowBand | null,
): T & { fillsLine?: boolean } {
  if (!band) return rect;
  if (band.fillsLine) return { ...rect, fillsLine: true };
  return {
    ...rect,
    top: Math.min(rect.top, band.top),
    bottom: Math.max(rect.bottom, band.bottom),
  };
}
