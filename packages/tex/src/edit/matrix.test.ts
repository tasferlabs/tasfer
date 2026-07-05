/**
 * Structural matrix editing — resolving a source offset to a grid cell and
 * resizing the grid's rows/columns. A resize emits minimal, localized edits that
 * touch only the appended/removed cells, rows, and column spec, so the assertions
 * check the applied source, that surviving cells' source is left byte-for-byte
 * intact (the property that keeps concurrent peers convergent), and the caret.
 */
import { describe, expect, it } from "vitest";
import { parse } from "../parse/parser";
import { matrixContextAt, matrixResize, type MatrixTextEdit } from "./matrix";

/** Apply a resize and return the full resulting LaTeX (or null if not a grid). */
function resize(
  latex: string,
  offset: number,
  rows: number,
  cols: number,
): string | null {
  const result = matrixResize(latex, offset, rows, cols);
  if (!result) return null;
  return applyEdits(latex, result.edits);
}

/** Apply edits right-to-left (as the host does) to produce the edited string. */
function applyEdits(latex: string, edits: readonly MatrixTextEdit[]): string {
  const ordered = [...edits].sort(
    (a, b) => b.start - a.start || b.end - b.start - (a.end - a.start),
  );
  let out = latex;
  for (const e of ordered) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/** The offset just inside the first `{}` cell of a 2×2 template. */
const M = "\\begin{matrix}{}&{}\\\\{}&{}\\end{matrix}";
const firstCellCaret = M.indexOf("{}") + 1;

describe("matrixContextAt", () => {
  it("resolves the enclosing environment and cell", () => {
    expect(matrixContextAt(M, firstCellCaret)).toEqual({
      env: "matrix",
      rows: 2,
      cols: 2,
      row: 0,
      col: 0,
      span: { start: 0, end: M.length },
    });
  });

  it("returns null outside any grid", () => {
    expect(matrixContextAt("a+b", 1)).toBeNull();
    expect(matrixContextAt("\\frac{a}{b}", 6)).toBeNull();
  });

  it("finds the caret's actual cell", () => {
    const lastCell = M.lastIndexOf("{}") + 1;
    expect(matrixContextAt(M, lastCell)).toMatchObject({ row: 1, col: 1 });
  });

  it("resolves the innermost of nested grids", () => {
    const nested =
      "\\begin{pmatrix}\\begin{matrix}{}&{}\\\\{}&{}\\end{matrix}&{}\\\\{}&{}\\end{pmatrix}";
    const inner = nested.indexOf("\\begin{matrix}");
    const innerCell = nested.indexOf("{}", inner) + 1;
    expect(matrixContextAt(nested, innerCell)).toMatchObject({ env: "matrix" });
  });
});

describe("matrixResize — rows", () => {
  it("grows by appending an empty row at the bottom", () => {
    const out = resize(M, firstCellCaret, 3, 2)!;
    expect(out).toBe("\\begin{matrix}{}&{}\\\\{}&{}\\\\{}&{}\\end{matrix}");
    expect(parse(out)).toBeTruthy();
  });

  it("shrinks by trimming rows from the bottom", () => {
    expect(resize(M, firstCellCaret, 1, 2)).toBe(
      "\\begin{matrix}{}&{}\\end{matrix}",
    );
  });

  it("clamps to at least one row", () => {
    expect(resize(M, firstCellCaret, 0, 2)).toBe(
      "\\begin{matrix}{}&{}\\end{matrix}",
    );
  });
});

describe("matrixResize — columns", () => {
  it("grows by appending an empty column at the right", () => {
    expect(resize(M, firstCellCaret, 2, 3)).toBe(
      "\\begin{matrix}{}&{}&{}\\\\{}&{}&{}\\end{matrix}",
    );
  });

  it("shrinks by trimming columns from the right", () => {
    expect(resize(M, firstCellCaret, 2, 1)).toBe(
      "\\begin{matrix}{}\\\\{}\\end{matrix}",
    );
  });

  it("clamps to at least one column", () => {
    expect(resize(M, firstCellCaret, 2, 0)).toBe(
      "\\begin{matrix}{}\\\\{}\\end{matrix}",
    );
  });
});

describe("matrixResize — minimal edits (convergence)", () => {
  const filled = "\\begin{bmatrix}a1&b2\\\\c3&d4\\end{bmatrix}";
  const caretInA = filled.indexOf("a1");

  it("grows columns as pure insertions, leaving every cell untouched", () => {
    const { edits } = matrixResize(filled, caretInA, 2, 3)!;
    // Every edit is a pure insertion (start === end) — no existing char is
    // deleted, so no surviving cell's identity changes.
    expect(edits.every((e) => e.start === e.end && e.text.length > 0)).toBe(
      true,
    );
    expect(resize(filled, caretInA, 2, 3)).toBe(
      "\\begin{bmatrix}a1&b2&{}\\\\c3&d4&{}\\end{bmatrix}",
    );
  });

  it("grows rows with a single insertion at the end", () => {
    const { edits } = matrixResize(filled, caretInA, 3, 2)!;
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ text: "\\\\{}&{}" });
    expect(edits[0].start).toBe(edits[0].end);
    // The insertion attaches after the last cell, before `\end`.
    expect(filled.slice(0, edits[0].start)).toBe(
      "\\begin{bmatrix}a1&b2\\\\c3&d4",
    );
  });

  it("shrinks columns by deleting only the trailing cells", () => {
    const { edits } = matrixResize(filled, caretInA, 2, 1)!;
    // Two deletions (one per row), each removing exactly `&b2` / `&d4`.
    expect(edits.every((e) => e.text === "" && e.end > e.start)).toBe(true);
    for (const e of edits) expect(filled.slice(e.start, e.end)).toMatch(/^&/);
    expect(resize(filled, caretInA, 2, 1)).toBe(
      "\\begin{bmatrix}a1\\\\c3\\end{bmatrix}",
    );
  });

  it("keeps preceding cells verbatim when shrinking rows", () => {
    const { edits } = matrixResize(filled, caretInA, 1, 2)!;
    expect(edits).toHaveLength(1);
    // The kept first row's source is entirely before the deletion.
    expect(edits[0].start).toBe("\\begin{bmatrix}a1&b2".length);
    expect(resize(filled, caretInA, 1, 2)).toBe(
      "\\begin{bmatrix}a1&b2\\end{bmatrix}",
    );
  });
});

describe("matrixResize — array column spec", () => {
  const arr = "\\begin{array}{cc}a&b\\\\c&d\\end{array}";
  const caretInA = arr.indexOf("a");

  it("grows the spec with the grid", () => {
    expect(resize(arr, caretInA, 2, 3)).toBe(
      "\\begin{array}{ccc}a&b&{}\\\\c&d&{}\\end{array}",
    );
  });

  it("trims the spec with the grid", () => {
    expect(resize(arr, caretInA, 2, 1)).toBe(
      "\\begin{array}{c}a\\\\c\\end{array}",
    );
  });
});

describe("matrixResize — caret placement", () => {
  it("keeps the caret in a valid empty cell after growing", () => {
    const { edits, caret } = matrixResize(M, firstCellCaret, 3, 3)!;
    const out = applyEdits(M, edits);
    expect(out[caret - 1]).toBe("{");
    expect(out[caret]).toBe("}");
  });

  it("clamps the caret's cell when the grid shrinks past it", () => {
    const lastCell = M.lastIndexOf("{}") + 1; // caret in cell (1,1)
    const { edits, caret } = matrixResize(M, lastCell, 1, 1)!;
    const out = applyEdits(M, edits);
    expect(out).toBe("\\begin{matrix}{}\\end{matrix}");
    expect(out[caret - 1]).toBe("{");
    expect(out[caret]).toBe("}");
  });
});

describe("matrixResize — cases/aligned", () => {
  it("handles a cases environment", () => {
    const cases = "\\begin{cases}a&b\\\\c&d\\end{cases}";
    const caretInA = cases.indexOf("a");
    expect(resize(cases, caretInA, 3, 2)).toBe(
      "\\begin{cases}a&b\\\\c&d\\\\{}&{}\\end{cases}",
    );
  });
});
