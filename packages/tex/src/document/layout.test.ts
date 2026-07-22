import {
  createDeterministicIdentityAllocator,
  hitTestMathDocument,
  layoutMathDocument,
  mathDocumentCaretFromSourceOffset,
  type MathDocumentCaretPosition,
  mathDocumentCaretStop,
  mathDocumentCaretVertical,
  parseMathDocument,
} from "../index";
import { describe, expect, it } from "vitest";

describe("MathDocument identity-keyed layout", () => {
  it("addresses plain-text geometry and every field caret by stable ids", () => {
    const document = parseMathDocument("abc", {
      identityAllocator: createDeterministicIdentityAllocator("plain"),
    });
    const row = document.root.body;
    const text = row.children[0];
    if (text?.type !== "raw-text") throw new Error("expected raw text");

    const layout = layoutMathDocument(document, { fontSize: 20 });
    expect([...layout.items.keys()]).toEqual(
      expect.arrayContaining([document.root.id, row.id, text.id]),
    );

    const textGeometry = layout.items.get(text.id);
    expect(textGeometry?.bounds.width).toBeGreaterThan(0);
    expect(textGeometry?.caretStops).toHaveLength(4);

    const fieldOffsets = new Set(
      textGeometry?.caretStops.flatMap((stop) =>
        stop.positions
          .filter(
            (position) =>
              position.kind === "field" && position.nodeId === text.id,
          )
          .map((position) => position.offset),
      ),
    );
    expect([...fieldOffsets]).toEqual([0, 1, 2, 3]);

    const position: MathDocumentCaretPosition = {
      kind: "field",
      rowId: row.id,
      nodeId: text.id,
      field: "text",
      offset: 2,
    };
    const stop = mathDocumentCaretStop(layout, position);
    expect(stop?.sourceOffset).toBe(2);
    expect(
      mathDocumentCaretStop(layout, {
        kind: "field",
        nodeId: text.id,
        field: "text",
        offset: 2,
      }),
    ).toBe(stop);
    expect(
      mathDocumentCaretFromSourceOffset(layout, stop?.sourceOffset ?? -1)
        ?.positions,
    ).toContainEqual(position);
    expect(
      hitTestMathDocument(layout, stop?.x ?? 0, stop?.y ?? 0)?.positions,
    ).toContainEqual(position);
  });

  it("keeps root, fraction, numerator, and denominator independently addressable", () => {
    const document = parseMathDocument(String.raw`\frac{a}{b}`, {
      identityAllocator: createDeterministicIdentityAllocator("fraction"),
    });
    const rootRow = document.root.body;
    const fraction = rootRow.children[0];
    if (fraction?.type !== "fraction") throw new Error("expected fraction");
    const numeratorText = fraction.numerator.children[0];
    const denominatorText = fraction.denominator.children[0];
    if (numeratorText?.type !== "raw-text")
      throw new Error("expected numerator text");
    if (denominatorText?.type !== "raw-text")
      throw new Error("expected denominator text");

    const layout = layoutMathDocument(document);
    for (const id of [
      document.root.id,
      rootRow.id,
      fraction.id,
      fraction.numerator.id,
      fraction.denominator.id,
      numeratorText.id,
      denominatorText.id,
    ]) {
      expect(layout.items.has(id), id).toBe(true);
    }

    const numerator = layout.items.get(fraction.numerator.id);
    const denominator = layout.items.get(fraction.denominator.id);
    expect(numerator?.baseline).toBeLessThan(denominator?.baseline ?? 0);
    expect(numerator?.bounds.width).toBeGreaterThan(0);
    expect(denominator?.bounds.width).toBeGreaterThan(0);

    expect(rowOffsets(layout, rootRow.id)).toEqual([0, 1]);
    expect(rowOffsets(layout, fraction.numerator.id)).toEqual([0, 1]);
    expect(rowOffsets(layout, fraction.denominator.id)).toEqual([0, 1]);

    const numeratorStart: MathDocumentCaretPosition = {
      kind: "field",
      rowId: fraction.numerator.id,
      nodeId: numeratorText.id,
      field: "text",
      offset: 0,
    };
    const numeratorStop = mathDocumentCaretStop(layout, numeratorStart);
    expect(numeratorStop?.sourceOffset).toBe(6);
    expect(
      mathDocumentCaretFromSourceOffset(layout, 6)?.positions,
    ).toContainEqual(numeratorStart);

    expect(
      mathDocumentCaretStop(layout, {
        kind: "row",
        rowId: rootRow.id,
        offset: 0,
      })?.sourceOffset,
    ).toBe(0);
    expect(
      mathDocumentCaretStop(layout, {
        kind: "row",
        rowId: rootRow.id,
        offset: 1,
      })?.sourceOffset,
    ).toBe(11);
  });

  it("keeps empty fraction slots visible and addressable", () => {
    const document = parseMathDocument(String.raw`\frac{}{}`);
    const fraction = document.root.body.children[0];
    if (fraction?.type !== "fraction") throw new Error("expected fraction");

    const layout = layoutMathDocument(document);
    const numerator = mathDocumentCaretStop(layout, {
      kind: "row",
      rowId: fraction.numerator.id,
      offset: 0,
    });
    const denominator = mathDocumentCaretStop(layout, {
      kind: "row",
      rowId: fraction.denominator.id,
      offset: 0,
    });

    expect(numerator?.placeholder).toBeDefined();
    expect(denominator?.placeholder).toBeDefined();
    expect(numerator?.y).toBeLessThan(denominator?.y ?? 0);
  });

  it("keeps each empty matrix cell at its own visual caret stop", () => {
    const document = parseMathDocument(
      String.raw`\frac{a}{b}\begin{pmatrix}&{}\\{}&{}\end{pmatrix}`,
    );
    const matrix = document.root.body.children[1];
    if (matrix?.type !== "matrix") throw new Error("expected matrix");
    const [[topLeft, topRight], [bottomLeft, bottomRight]] = matrix.rows.map(
      (row) => row.cells.map((cell) => cell.body),
    );
    const layout = layoutMathDocument(document);
    const stop = (rowId: string) =>
      mathDocumentCaretStop(layout, { kind: "row", rowId, offset: 0 });

    expect(stop(topRight.id)?.x).toBeGreaterThan(stop(topLeft.id)?.x ?? 0);
    expect(stop(bottomRight.id)?.x).toBeGreaterThan(
      stop(bottomLeft.id)?.x ?? 0,
    );
    expect(stop(bottomLeft.id)?.y).toBeGreaterThan(stop(topLeft.id)?.y ?? 0);
  });

  it("moves vertically between stable fraction-row addresses", () => {
    const document = parseMathDocument(String.raw`\frac{ab}{c}`);
    const fraction = document.root.body.children[0];
    if (fraction?.type !== "fraction") throw new Error("expected fraction");
    const numeratorText = fraction.numerator.children[0];
    const denominatorText = fraction.denominator.children[0];
    if (
      numeratorText?.type !== "raw-text" ||
      denominatorText?.type !== "raw-text"
    ) {
      throw new Error("expected editable fraction fields");
    }

    const numerator: MathDocumentCaretPosition = {
      kind: "field",
      rowId: fraction.numerator.id,
      nodeId: numeratorText.id,
      field: "text",
      offset: 1,
    };
    const denominator: MathDocumentCaretPosition = {
      kind: "field",
      rowId: fraction.denominator.id,
      nodeId: denominatorText.id,
      field: "text",
      offset: 1,
    };
    const layout = layoutMathDocument(document);

    expect(
      mathDocumentCaretVertical(layout, numerator, "down")?.positions,
    ).toContainEqual(denominator);
    expect(
      mathDocumentCaretVertical(layout, denominator, "up")?.positions,
    ).toContainEqual(numerator);
  });

  it("moves vertically through paired scripts and matrix columns", () => {
    const scripted = parseMathDocument(String.raw`x^{ab}_{c}`);
    const scripts = scripted.root.body.children[0];
    if (
      scripts?.type !== "scripts" ||
      !scripts.superscript ||
      !scripts.subscript
    ) {
      throw new Error("expected paired scripts");
    }
    const superscript = scripts.superscript.children[0];
    const subscript = scripts.subscript.children[0];
    if (superscript?.type !== "raw-text" || subscript?.type !== "raw-text") {
      throw new Error("expected editable scripts");
    }
    const superscriptPosition: MathDocumentCaretPosition = {
      kind: "field",
      rowId: scripts.superscript.id,
      nodeId: superscript.id,
      field: "text",
      offset: 1,
    };
    const subscriptPosition: MathDocumentCaretPosition = {
      kind: "field",
      rowId: scripts.subscript.id,
      nodeId: subscript.id,
      field: "text",
      offset: 1,
    };
    expect(
      mathDocumentCaretVertical(
        layoutMathDocument(scripted),
        superscriptPosition,
        "down",
      )?.positions,
    ).toContainEqual(subscriptPosition);

    const matrixDocument = parseMathDocument(
      String.raw`\begin{matrix}a&b\\c&d\end{matrix}`,
    );
    const matrix = matrixDocument.root.body.children[0];
    if (matrix?.type !== "matrix") throw new Error("expected matrix");
    const top = matrix.rows[0]?.cells[0]?.body.children[0];
    const bottom = matrix.rows[1]?.cells[0]?.body.children[0];
    if (top?.type !== "raw-text" || bottom?.type !== "raw-text") {
      throw new Error("expected editable matrix cells");
    }
    const topPosition: MathDocumentCaretPosition = {
      kind: "field",
      rowId: matrix.rows[0].cells[0].body.id,
      nodeId: top.id,
      field: "text",
      offset: 1,
    };
    const bottomPosition: MathDocumentCaretPosition = {
      kind: "field",
      rowId: matrix.rows[1].cells[0].body.id,
      nodeId: bottom.id,
      field: "text",
      offset: 1,
    };
    expect(
      mathDocumentCaretVertical(
        layoutMathDocument(matrixDocument),
        topPosition,
        "down",
      )?.positions,
    ).toContainEqual(bottomPosition);
  });

  it("aliases structural row edges onto wrapped text geometry", () => {
    const document = parseMathDocument(String.raw`\text{hi}`);
    const row = document.root.body;
    const text = row.children[0];
    if (text?.type !== "text") throw new Error("expected text node");
    const layout = layoutMathDocument(document);

    expect(rowOffsets(layout, row.id)).toEqual([0, 1]);
    expect(
      mathDocumentCaretStop(layout, {
        kind: "field",
        nodeId: text.id,
        field: "text",
        offset: 0,
      }),
    ).not.toBeNull();
    expect(
      mathDocumentCaretStop(layout, {
        kind: "field",
        nodeId: text.id,
        field: "text",
        offset: 2,
      }),
    ).not.toBeNull();
  });

  it("exposes unsupported raw LaTeX only through its atomic row edges", () => {
    const document = parseMathDocument(String.raw`\widehat{x}`);
    const row = document.root.body;
    const fallback = row.children[0];
    if (fallback?.type !== "raw-latex") {
      throw new Error("expected a raw LaTeX fallback");
    }
    const layout = layoutMathDocument(document);

    expect(rowOffsets(layout, row.id)).toEqual([0, 1]);
    expect(
      layout.items
        .get(fallback.id)
        ?.caretStops.flatMap((stop) => stop.positions)
        .some(
          (position) =>
            position.kind === "field" && position.nodeId === fallback.id,
        ),
    ).toBe(false);
    expect(
      mathDocumentCaretStop(layout, {
        kind: "field",
        nodeId: fallback.id,
        field: "latex",
        offset: 4,
      }),
    ).toBeNull();
  });
});

function rowOffsets(
  layout: ReturnType<typeof layoutMathDocument>,
  rowId: string,
): number[] {
  return [
    ...new Set(
      layout.items
        .get(rowId)
        ?.caretStops.flatMap((stop) =>
          stop.positions
            .filter(
              (position) => position.kind === "row" && position.rowId === rowId,
            )
            .map((position) => position.offset),
        ),
    ),
  ];
}
