/**
 * Structural editing of tabular constructs — the `\begin{matrix}…\end{matrix}`
 * family plus `cases`, `aligned`, `array`, … (every {@link ArrayNode}). These
 * operate on the LaTeX *source*: an offset into the string resolves to a grid
 * cell, and a resize rewrites the whole environment's span with a rebuilt grid,
 * padded or trimmed to the requested row/column count.
 *
 * The grid is rebuilt by slicing each cell's source verbatim (so existing
 * content — including nested environments — round-trips) and re-joining with `&`
 * (columns) and `\\` (rows). New cells become `{}`, mirroring the insertion
 * templates in `nodes/math-commands.ts` so each stays a caret stop.
 */
import type { ArrayNode, Node } from "../parse/ast";
import type { Span } from "../parse/ast";
import { parse } from "../parse/parser";

/**
 * The tabular environment enclosing a source offset, and the `(row, col)` of the
 * cell the offset sits in. `rows`/`cols` are the grid dimensions.
 */
export interface MatrixContext {
  readonly env: string;
  readonly rows: number;
  readonly cols: number;
  readonly row: number;
  readonly col: number;
  /** Source span of the whole `\begin…\end`. */
  readonly span: Span;
}

/** One localized source edit: replace `[start, end)` with `text`. `start === end`
 *  is a pure insertion; `text === ""` is a pure deletion. Offsets index the
 *  ORIGINAL source. */
export interface MatrixTextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * The result of a resize: a set of minimal, non-overlapping edits into the
 * ORIGINAL source plus the caret offset into the EDITED source.
 *
 * The edits touch ONLY the appended/removed cells, rows, and column spec — every
 * surviving cell keeps its exact source range, so its characters keep their CRDT
 * identities and a peer's concurrent edit to that cell merges cleanly. (A
 * whole-environment rewrite would tombstone those characters and diverge under
 * concurrent editing.) Apply the edits right-to-left (descending `start`, and for
 * a shared `start` the deletion before the insertion) so each offset stays valid
 * against the original.
 */
export interface MatrixEditResult {
  readonly edits: readonly MatrixTextEdit[];
  readonly caret: number;
}

/** Child nodes of any AST node — the descent used to reach nested arrays. */
function childNodes(node: Node): Node[] {
  switch (node.type) {
    case "ord":
    case "leftright":
    case "style":
      return node.body;
    case "supsub":
      return [node.base, node.sup, node.sub].filter(
        (n): n is Node => n !== null,
      );
    case "frac":
      return [node.num, node.den];
    case "sqrt":
      return node.index ? [node.index, node.body] : [node.body];
    case "accent":
    case "not":
      return [node.base];
    case "overunder":
    case "mathfont":
    case "mclass":
    case "boxed":
    case "phantom":
      return [node.body];
    case "stack":
      return [node.script, node.base];
    case "array":
      return node.rows.flat();
    default:
      return [];
  }
}

/** The innermost array containing `offset`, or null. An offset resting exactly on
 *  the opening boundary counts as inside (mirroring {@link cellAt}'s `<=`), so a
 *  whole-matrix selection — whose start is the array's `span.start`, as produced by
 *  double-clicking the grid — still resolves its enclosing array. The end stays
 *  exclusive so an offset between two sibling arrays belongs to the following one. */
function deepestArrayAt(root: Node, offset: number): ArrayNode | null {
  let best: ArrayNode | null = null;
  const visit = (n: Node): void => {
    if (n.type === "array" && offset >= n.span.start && offset < n.span.end) {
      // A nested array is a descendant, visited after this assignment, so it
      // overwrites `best` — leaving the deepest containing array.
      best = n;
    }
    for (const child of childNodes(n)) visit(child);
  };
  visit(root);
  return best;
}

/** The `(row, col)` of the cell `offset` sits in — the last cell that starts at
 *  or before `offset` (so a caret on a `&`/`\\` boundary belongs to the cell it
 *  follows). Defaults to `(0, 0)` when `offset` precedes every cell. */
function cellAt(
  array: ArrayNode,
  offset: number,
): { row: number; col: number } {
  let row = 0;
  let col = 0;
  let bestStart = -Infinity;
  array.rows.forEach((cells, r) => {
    cells.forEach((cell, c) => {
      if (cell.span.start <= offset && cell.span.start > bestStart) {
        bestStart = cell.span.start;
        row = r;
        col = c;
      }
    });
  });
  return { row, col };
}

/**
 * The environment enclosing `offset` and the caret's cell within it, or null when
 * `offset` is not inside any tabular construct.
 */
export function matrixContextAt(
  latex: string,
  offset: number,
): MatrixContext | null {
  const root = parse(latex);
  const array = deepestArrayAt(root, offset);
  if (!array) return null;
  const { row, col } = cellAt(array, offset);
  const cols = array.rows.reduce((max, r) => Math.max(max, r.length), 0);
  return {
    env: array.env,
    rows: array.rows.length,
    cols,
    row,
    col,
    span: array.span,
  };
}

/** End offset of a row's last cell — where an appended column/row attaches. */
function rowContentEnd(row: readonly Node[]): number {
  return row[row.length - 1].span.end;
}

/** The `{lcr}` column-spec's `{` and `}` offsets for an `array`-style env, or null
 *  when the env carries no spec. Located by scanning past `\begin{env}` (the spec,
 *  if present, is the brace group immediately after it). */
function colSpecBraces(
  latex: string,
  array: ArrayNode,
): { open: number; close: number } | null {
  if (!array.colAlign) return null;
  const afterBegin = array.span.start + `\\begin{${array.env}}`.length;
  if (latex[afterBegin] !== "{") return null;
  const close = latex.indexOf("}", afterBegin);
  return close > afterBegin ? { open: afterBegin, close } : null;
}

/**
 * Resize the tabular construct enclosing `offset` to `nextRows` × `nextCols`,
 * as a set of minimal source edits (or null when `offset` is not in one).
 *
 * Growing appends empty `{}` cells at the right of each row / empty rows at the
 * bottom; shrinking removes the trailing columns/rows and their content. Every
 * surviving cell keeps its exact source span, so only the added/removed structure
 * is touched — see {@link MatrixEditResult}. The grid never falls below 1×1
 * (removing it entirely is a plain text delete). The caret lands in the cell
 * nearest its original one, clamped into the new bounds.
 */
export function matrixResize(
  latex: string,
  offset: number,
  nextRows: number,
  nextCols: number,
): MatrixEditResult | null {
  const root = parse(latex);
  const array = deepestArrayAt(root, offset);
  if (!array) return null;

  const rows = array.rows;
  const R = rows.length;
  const C = rows.reduce((max, r) => Math.max(max, r.length), 0);
  if (C === 0 || rows.some((r) => r.length === 0)) return null;

  const Rt = Math.max(1, Math.floor(nextRows));
  const Ct = Math.max(1, Math.floor(nextCols));
  const { row: caretRow, col: caretCol } = cellAt(array, offset);

  // Insertions accumulate per offset so a column append and a row append at the
  // same point (the last row's end) compose in the right order (columns first).
  const inserts = new Map<number, string>();
  const addInsert = (at: number, text: string) =>
    inserts.set(at, (inserts.get(at) ?? "") + text);
  const deletes: MatrixTextEdit[] = [];

  // Rows kept after a row-shrink; column edits apply only to these (removed rows
  // are deleted wholesale, so editing their columns would overlap that delete).
  const keptRows = Rt < R ? Rt : R;

  // Columns.
  if (Ct > C) {
    for (let r = 0; r < R; r++) {
      const add = Ct - rows[r].length; // pad ragged rows up to the new width too
      if (add > 0) addInsert(rowContentEnd(rows[r]), "&{}".repeat(add));
    }
  } else if (Ct < C) {
    for (let r = 0; r < keptRows; r++) {
      const k = rows[r].length;
      if (k > Ct) {
        // Drop cells Ct…k-1: from the `&` after the last kept cell to the row end.
        deletes.push({
          start: rows[r][Ct - 1].span.end,
          end: rowContentEnd(rows[r]),
          text: "",
        });
      }
    }
  }

  // The column-spec (`array` env) tracks the column count.
  const spec = colSpecBraces(latex, array);
  if (spec) {
    const specLen = spec.close - spec.open - 1;
    if (Ct > C) addInsert(spec.close, "c".repeat(Ct - C));
    else if (Ct < C)
      deletes.push({
        start: spec.close - Math.min(C - Ct, specLen),
        end: spec.close,
        text: "",
      });
  }

  // Rows.
  if (Rt > R) {
    const emptyRow = "\\\\" + new Array(Ct).fill("{}").join("&");
    addInsert(rowContentEnd(rows[R - 1]), emptyRow.repeat(Rt - R));
  } else if (Rt < R) {
    // Drop rows Rt…R-1: from the last kept row's end (before its `\\`) to the end.
    deletes.push({
      start: rowContentEnd(rows[Rt - 1]),
      end: rowContentEnd(rows[R - 1]),
      text: "",
    });
  }

  const edits: MatrixTextEdit[] = [
    ...deletes,
    ...[...inserts].map(([start, text]) => ({ start, end: start, text })),
  ];

  // Caret: the (clamped) surviving cell nearest the original one. It is never one
  // of the touched cells, so its source span is intact — anchor to it and shift by
  // the net length change of every edit that precedes it.
  const targetRow = Math.min(caretRow, Rt - 1, R - 1);
  const tCells = rows[targetRow];
  const targetCell = tCells[Math.min(caretCol, Ct - 1, tCells.length - 1)];
  const cellSrc = latex.slice(targetCell.span.start, targetCell.span.end);
  const anchor =
    cellSrc.length >= 2 && cellSrc.startsWith("{") && cellSrc.endsWith("}")
      ? targetCell.span.start + 1 // between an empty/braced cell's braces
      : targetCell.span.start;
  const caret = edits.reduce(
    (pos, e) =>
      e.start < anchor ? pos + (e.text.length - (e.end - e.start)) : pos,
    anchor,
  );

  return { edits, caret };
}
