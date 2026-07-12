import { iterateAllChars } from "../sync/char-runs";
import {
  createDeterministicIdentityAllocator,
  type IdentityAllocator,
} from "../sync/id";
import {
  applyStructuredEdit,
  applyStructuredEdits,
  getStructuredChildren,
  getStructuredText,
  invertStructuredEdit,
  type StructuredDocument,
  type StructuredEdit,
} from "../sync/structured-content";
import {
  mathDocumentToStructured,
  structuredToMathDocument,
  validateStructuredMathDocument,
} from "./structured";
import {
  backspaceMathTree,
  completeMathCommand,
  deleteForwardMathTree,
  deleteMathTreeRange,
  getMathTreeMatrixContext,
  getMathTreeRangeText,
  insertMathFraction,
  insertMathSemanticLatex,
  insertMathText,
  insertMathTextWithCompletion,
  type MathRowCaret,
  type MathTreeCaret,
  moveMathTreeCaret,
  replaceMathTreeRange,
  replaceMathTreeRangeWithSemanticLatex,
  resizeMathTreeMatrix,
} from "./tree-edit";
import {
  mathDocumentsSemanticallyEqual,
  parseMathDocument,
  printMathDocument,
} from "@cypherkit/tex";
import { describe, expect, it } from "vitest";

describe("structured math tree editing", () => {
  it("inserts raw text at a row gap with injected stable identities", () => {
    const document = mathDocument("");
    const rowId = bodyRowId(document);
    const identities = identitySource("local");

    const result = insertMathText(
      document,
      rowCaret(rowId, null),
      "xy",
      identities,
    );
    const edited = applyResult(document, result);

    expect(result.handled).toBe(true);
    expect(result.edits).toHaveLength(1);
    expect(result.caret).toEqual({
      kind: "text",
      rowId,
      nodeId: "local:100",
      field: "text",
      afterCharId: "local:102",
    });
    expect(print(edited)).toBe("xy");
    expect(validateStructuredMathDocument(edited)).toBeDefined();
  });

  it("treats a non-finite requested caret offset as the insertion end", () => {
    const document = mathDocument("");
    const rowId = bodyRowId(document);
    const result = insertMathText(
      document,
      rowCaret(rowId, null),
      "xy",
      identitySource("offset"),
      Number.NaN,
    );

    expect(result.caret).toMatchObject({
      kind: "text",
      afterCharId: "offset:102",
    });
    expect(print(applyResult(document, result))).toBe("xy");
  });

  it("inserts into a raw-text field and each edit remains independently undoable", () => {
    const document = mathDocument("ab");
    const rowId = bodyRowId(document);
    const raw = child(document, rowId, "children", "raw-text");
    const [a] = visibleCharacterIds(raw);
    const before = textCaret(rowId, raw.id, a);

    const result = insertMathText(
      document,
      before,
      "XY",
      identitySource("insert", 100),
    );
    const { edited, undone } = applyWithUndo(document, result.edits);

    expect(result.edits.map((edit) => edit.kind)).toEqual([
      "text_insert",
      "text_insert",
    ]);
    expect(print(edited)).toBe("aXYb");
    expectSemanticallyEqual(undone, document);
  });

  it("inserts a fraction with stable slot ids and enters its numerator", () => {
    const document = mathDocument("");
    const rowId = bodyRowId(document);
    const result = insertMathFraction(
      document,
      rowCaret(rowId, null),
      identitySource("fraction"),
    );
    const { edited, undone } = applyWithUndo(document, result.edits);

    expect(result.caret).toEqual({
      kind: "row",
      rowId: "fraction:101",
      afterNodeId: null,
    });
    expect(result.edits.map((edit) => edit.kind)).toEqual([
      "node_insert",
      "node_insert",
      "node_insert",
    ]);
    expect(print(edited)).toBe(String.raw`\frac{}{}`);
    expectSemanticallyEqual(undone, document);
  });

  it("does not split a raw-text CRDT leaf for a middle structural insert", () => {
    const document = mathDocument("ab");
    const rowId = bodyRowId(document);
    const raw = child(document, rowId, "children", "raw-text");
    const [a] = visibleCharacterIds(raw);

    const result = insertMathFraction(
      document,
      textCaret(rowId, raw.id, a),
      identitySource("unused"),
    );

    expect(result).toMatchObject({
      handled: false,
      edits: [],
      reason: "unsupported-position",
    });
    expect(print(document)).toBe("ab");
  });

  it("commits a square-root menu value as a radical and enters its radicand", () => {
    const document = mathDocument("");
    const rowId = bodyRowId(document);
    const result = insertMathSemanticLatex(
      document,
      rowCaret(rowId, null),
      String.raw`\sqrt{}`,
      identitySource("semantic-radical"),
    );
    const { edited, undone } = applyWithUndo(document, result.edits);
    const radical = child(edited, rowId, "children", "radical");
    const radicand = child(edited, radical.id, "radicand", "row");

    expect(result.handled).toBe(true);
    expect(result.caret).toEqual(rowCaret(radicand.id, null));
    expect(result.edits.map((edit) => edit.kind)).toEqual([
      "node_insert",
      "node_insert",
    ]);
    expect(print(edited)).toBe(String.raw`\sqrt{}`);
    expectSemanticallyEqual(undone, document);
  });

  it("splices a semantic construct between the left and right halves of a text leaf", () => {
    const document = mathDocument("ab");
    const rowId = bodyRowId(document);
    const original = child(document, rowId, "children", "raw-text");
    const [a] = visibleCharacterIds(original);
    const result = insertMathSemanticLatex(
      document,
      textCaret(rowId, original.id, a),
      String.raw`\sqrt{}`,
      identitySource("semantic-middle"),
    );
    const { edited, undone } = applyWithUndo(document, result.edits);
    const children = getStructuredChildren(edited, rowId, "children");

    expect(children.map((node) => node.type)).toEqual([
      "raw-text",
      "radical",
      "raw-text",
    ]);
    expect(children[0].id).toBe(original.id);
    expect(getStructuredText(edited, children[0].id, "text")).toBe("a");
    expect(getStructuredText(edited, children[2].id, "text")).toBe("b");
    expect(print(edited)).toBe(String.raw`a\sqrt{}b`);
    expect(applyStructuredEdits(document, result.edits)).toEqual(edited);
    expectSemanticallyEqual(undone, document);
  });

  it.each([
    [String.raw`^{}`, "scripts"],
    [String.raw`\sum_{}^{}`, "scripts"],
    [String.raw`\left(\right)`, "delimited"],
    [String.raw`\begin{bmatrix}{}&{}\\{}&{}\end{bmatrix}`, "matrix"],
    [String.raw`\alpha`, "symbol"],
  ])("normalizes the committed menu source %s to a %s node", (latex, type) => {
    const document = mathDocument("");
    const rowId = bodyRowId(document);
    const result = insertMathSemanticLatex(
      document,
      rowCaret(rowId, null),
      latex,
      identitySource(`semantic-${type}`),
    );
    const edited = applyResult(document, result);
    const visible = getStructuredChildren(edited, rowId, "children");

    expect(visible).toHaveLength(1);
    expect(visible[0].type).toBe(type);
    expect(
      visible.some(
        (node) =>
          node.type === "raw-text" &&
          /[\\{}^_]/.test(getStructuredText(edited, node.id, "text")),
      ),
    ).toBe(false);
  });

  it("replaces a typed command query with one semantic subtree transaction", () => {
    const document = mathDocument(String.raw`\sq`);
    const rowId = bodyRowId(document);
    const raw = child(document, rowId, "children", "raw-text");
    const result = replaceMathTreeRangeWithSemanticLatex(
      document,
      {
        anchor: textCaret(rowId, raw.id, null),
        focus: textCaret(rowId, raw.id, visibleCharacterIds(raw).at(-1)!),
      },
      String.raw`\sqrt{}`,
      identitySource("semantic-replace"),
    );
    const { edited, undone } = applyWithUndo(document, result.edits);

    expect(print(edited)).toBe(String.raw`\sqrt{}`);
    expect(
      getStructuredChildren(edited, rowId, "children").map((node) => node.type),
    ).toContain("radical");
    expectSemanticallyEqual(undone, document);
  });

  it("keeps an unsupported parser fallback atomic under backward and forward delete", () => {
    const initial = mathDocument("");
    const rowId = bodyRowId(initial);
    const inserted = insertMathSemanticLatex(
      initial,
      rowCaret(rowId, null),
      String.raw`\widehat{x}`,
      identitySource("semantic-fallback"),
    );
    const document = applyResult(initial, inserted);
    const fallback = child(document, rowId, "children", "raw-latex");

    expect(print(document)).toBe(String.raw`\widehat{x}`);
    expect(inserted.caret).toEqual(rowCaret(rowId, fallback.id));

    const backward = backspaceMathTree(document, inserted.caret);
    expect(backward.edits).toEqual([
      { kind: "node_delete", nodeId: fallback.id },
    ]);
    expect(print(applyResult(document, backward))).toBe("");

    const forward = deleteForwardMathTree(document, rowCaret(rowId, null));
    expect(forward.edits).toEqual([
      { kind: "node_delete", nodeId: fallback.id },
    ]);
    expect(print(applyResult(document, forward))).toBe("");
  });

  it("grows a matrix with stable surviving cell identities and undoable node inserts", () => {
    const document = matrixDocument(
      String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`,
    );
    const matrix = child(document, bodyRowId(document), "children", "matrix");
    const rowsBefore = getStructuredChildren(document, matrix.id, "rows");
    const firstCellsBefore = getStructuredChildren(
      document,
      rowsBefore[0].id,
      "cells",
    );
    const body = child(document, firstCellsBefore[0].id, "body", "row");
    const caret = rowCaret(body.id, null);
    expect(getMathTreeMatrixContext(document, caret)).toMatchObject({
      matrixId: matrix.id,
      rows: 2,
      cols: 2,
      row: 0,
      col: 0,
    });
    const result = resizeMathTreeMatrix(
      document,
      caret,
      3,
      3,
      identitySource("matrix-grow", 200),
    );
    const { edited, undone } = applyWithUndo(document, result.edits);
    const rowsAfter = getStructuredChildren(edited, matrix.id, "rows");

    expect(result.handled).toBe(true);
    expect(result.caret).toEqual(caret);
    expect(rowsAfter).toHaveLength(3);
    expect(
      rowsAfter.map(
        (row) => getStructuredChildren(edited, row.id, "cells").length,
      ),
    ).toEqual([3, 3, 3]);
    expect(
      getStructuredChildren(edited, rowsAfter[0].id, "cells")
        .slice(0, 2)
        .map((cell) => cell.id),
    ).toEqual(firstCellsBefore.map((cell) => cell.id));
    expect(applyStructuredEdits(document, result.edits)).toEqual(edited);
    expectSemanticallyEqual(undone, document);
  });

  it("shrinks a matrix by tombstoning trailing rows/cells and clamps the caret", () => {
    const document = matrixDocument(
      String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`,
    );
    const matrix = child(document, bodyRowId(document), "children", "matrix");
    const rows = getStructuredChildren(document, matrix.id, "rows");
    const lastCells = getStructuredChildren(document, rows[1].id, "cells");
    const lastBody = child(document, lastCells[1].id, "body", "row");
    const firstCell = getStructuredChildren(document, rows[0].id, "cells")[0];
    const firstBody = child(document, firstCell.id, "body", "row");
    const result = resizeMathTreeMatrix(
      document,
      rowCaret(lastBody.id, null),
      1,
      1,
      identitySource("matrix-shrink", 200),
    );
    const { edited, undone } = applyWithUndo(document, result.edits);

    expect(result.caret).toEqual(rowCaret(firstBody.id, null));
    expect(getStructuredChildren(edited, matrix.id, "rows")).toHaveLength(1);
    expect(getStructuredChildren(edited, rows[0].id, "cells")).toHaveLength(1);
    expect(print(edited)).toBe(String.raw`\begin{bmatrix}a\end{bmatrix}`);
    expectSemanticallyEqual(undone, document);
  });

  it("completes a trailing literal \\frac and removes an exhausted text leaf", () => {
    const document = mathDocument("");
    const rowId = bodyRowId(document);

    const result = insertMathTextWithCompletion(
      document,
      rowCaret(rowId, null),
      String.raw`\frac`,
      identitySource("command"),
    );
    const { edited, undone } = applyWithUndo(document, result.edits);
    const visibleBody = getStructuredChildren(edited, rowId, "children");

    expect(result.completedCommand).toBe("frac");
    expect(result.edits.map((edit) => edit.kind)).toEqual([
      "node_insert",
      "text_insert",
      "text_insert",
      "text_insert",
      "text_insert",
      "text_delete",
      "node_delete",
      "node_insert",
      "node_insert",
      "node_insert",
    ]);
    expect(visibleBody.map((node) => node.type)).toEqual(["fraction"]);
    expect(print(edited)).toBe(String.raw`\frac{}{}`);
    expectSemanticallyEqual(undone, document);
  });

  it("deletes exactly the command suffix while preserving a literal prefix", () => {
    const document = mathDocument(String.raw`x\fra`);
    const rowId = bodyRowId(document);
    const raw = child(document, rowId, "children", "raw-text");
    const atEnd = textCaret(rowId, raw.id, visibleCharacterIds(raw).at(-1)!);
    const identities = identitySource("suffix", 100);

    const inserted = insertMathText(document, atEnd, "c", identities);
    const afterC = applyResult(document, inserted);
    const completion = completeMathCommand(afterC, inserted.caret, identities);
    const edited = applyResult(afterC, completion);

    expect(completion.completedCommand).toBe("frac");
    expect(completion.edits[0]).toMatchObject({
      kind: "text_delete",
      charIds: [...visibleCharacterIds(raw).slice(1), "suffix:100"],
    });
    expect(getStructuredText(edited, raw.id, "text")).toBe("x");
    expect(edited.nodes[raw.id].deleted).not.toBe(true);
    expect(print(edited)).toBe(String.raw`x\frac{}{}`);
  });

  it.each(["\\", String.raw`\sqrt`, String.raw`\unknown`])(
    "keeps unsupported command %s literal",
    (source) => {
      const document = mathDocument("");
      const rowId = bodyRowId(document);
      const result = insertMathTextWithCompletion(
        document,
        rowCaret(rowId, null),
        source,
        identitySource("literal"),
      );
      const edited = applyResult(document, result);

      expect(result.completedCommand).toBeUndefined();
      expect(print(edited)).toBe(source);
    },
  );

  it("moves numerator to denominator to after-fraction with Tab or ArrowRight", () => {
    const fixture = fractionFixture();
    const tabDenominator = moveMathTreeCaret(
      fixture.document,
      fixture.numerator,
      "tab",
    );
    const tabAfter = moveMathTreeCaret(
      fixture.document,
      tabDenominator.caret,
      "tab",
    );
    const arrowDenominator = moveMathTreeCaret(
      fixture.document,
      fixture.numerator,
      "arrow-right",
    );
    const arrowAfter = moveMathTreeCaret(
      fixture.document,
      arrowDenominator.caret,
      "arrow-right",
    );
    const shiftBack = moveMathTreeCaret(
      fixture.document,
      tabDenominator.caret,
      "shift-tab",
    );

    expect(tabDenominator.caret).toEqual(fixture.denominator);
    expect(tabAfter.caret).toEqual(
      rowCaret(fixture.outerRowId, fixture.fractionId),
    );
    expect(arrowDenominator.caret).toEqual(fixture.denominator);
    expect(arrowAfter.caret).toEqual(
      rowCaret(fixture.outerRowId, fixture.fractionId),
    );
    expect(shiftBack.caret).toEqual(fixture.numerator);
  });

  it("moves backwards after-fraction to denominator to numerator to before-fraction", () => {
    const fixture = fractionFixture();
    const after = rowCaret(fixture.outerRowId, fixture.fractionId);
    const denominator = moveMathTreeCaret(
      fixture.document,
      after,
      "arrow-left",
    );
    const numerator = moveMathTreeCaret(
      fixture.document,
      denominator.caret,
      "arrow-left",
    );
    const before = moveMathTreeCaret(
      fixture.document,
      numerator.caret,
      "arrow-left",
    );

    expect(denominator.caret).toEqual(fixture.denominator);
    expect(numerator.caret).toEqual(fixture.numerator);
    expect(before.caret).toEqual(rowCaret(fixture.outerRowId, null));
  });

  it("ArrowRight exits a populated numerator directly from its text end", () => {
    const fixture = fractionFixture();
    const inserted = insertMathText(
      fixture.document,
      fixture.numerator,
      "n",
      identitySource("numerator", 200),
    );
    const populated = applyResult(fixture.document, inserted);

    const moved = moveMathTreeCaret(populated, inserted.caret, "arrow-right");

    expect(moved.caret).toEqual(fixture.denominator);
  });

  it("does not stop twice at adjacent raw-text leaf boundaries", () => {
    const initial = mathDocument("a");
    const rowId = bodyRowId(initial);
    const first = child(initial, rowId, "children", "raw-text");
    const appended = insertMathText(
      initial,
      rowCaret(rowId, first.id),
      "b",
      identitySource("adjacent"),
    );
    const document = applyResult(initial, appended);
    const second = getStructuredChildren(document, rowId, "children")[1];
    const gapAfterA = rowCaret(rowId, first.id);
    const beforeB = textCaret(rowId, second.id, null);

    const right = moveMathTreeCaret(document, gapAfterA, "arrow-right");
    const left = moveMathTreeCaret(document, beforeB, "arrow-left");

    expect(right.caret).toEqual(appended.caret);
    expect(left.caret).toEqual(textCaret(rowId, first.id, null));
  });

  it("crosses a matrix cell boundary in one horizontal arrow press", () => {
    const document = matrixDocument(
      String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`,
    );
    const outerRow = child(document, document.rootId, "body", "row");
    const matrix = child(document, outerRow.id, "children", "matrix");
    const firstMatrixRow = getStructuredChildren(
      document,
      matrix.id,
      "rows",
    )[0];
    const cells = getStructuredChildren(document, firstMatrixRow.id, "cells");
    const firstBody = child(document, cells[0].id, "body", "row");
    const secondBody = child(document, cells[1].id, "body", "row");
    const a = child(document, firstBody.id, "children", "raw-text");
    const b = child(document, secondBody.id, "children", "raw-text");
    const afterA = textCaret(firstBody.id, a.id, visibleCharacterIds(a)[0]);

    const right = moveMathTreeCaret(document, afterA, "arrow-right");
    const left = moveMathTreeCaret(document, right.caret, "arrow-left");

    expect(right.caret).toEqual(textCaret(secondBody.id, b.id, null));
    expect(left.caret).toEqual(afterA);
  });

  it("visits every empty matrix cell once without cycling", () => {
    const document = matrixDocument(
      String.raw`\begin{bmatrix}&\\&\end{bmatrix}`,
    );
    const outerRow = child(document, document.rootId, "body", "row");
    const matrix = child(document, outerRow.id, "children", "matrix");
    let caret = rowCaret(outerRow.id, null);
    const visited = new Set<string>();
    const cellRows: string[] = [];

    for (let step = 0; step < 8; step++) {
      const moved = moveMathTreeCaret(document, caret, "arrow-right");
      if (!moved.handled) break;
      caret = moved.caret;
      const key = JSON.stringify(caret);
      expect(visited.has(key)).toBe(false);
      visited.add(key);
      if (caret.kind === "row" && caret.rowId !== outerRow.id) {
        cellRows.push(caret.rowId);
      }
    }

    expect(new Set(cellRows).size).toBe(4);
    expect(caret).toEqual(rowCaret(outerRow.id, matrix.id));
  });

  it("crosses a matrix cell containing an empty braced placeholder in one press", () => {
    const document = matrixDocument(
      String.raw`\begin{bmatrix}{}&{}\\{}&{}\end{bmatrix}`,
    );
    const outerRow = child(document, document.rootId, "body", "row");
    const matrix = child(document, outerRow.id, "children", "matrix");
    const firstMatrixRow = getStructuredChildren(
      document,
      matrix.id,
      "rows",
    )[0];
    const cells = getStructuredChildren(document, firstMatrixRow.id, "cells");
    const firstBody = child(document, cells[0].id, "body", "row");
    const secondBody = child(document, cells[1].id, "body", "row");

    const right = moveMathTreeCaret(
      document,
      rowCaret(firstBody.id, null),
      "arrow-right",
    );

    expect(right.caret).toEqual(rowCaret(secondBody.id, null));
  });

  it("backspaces a raw-text character and can restore it by inverse", () => {
    const document = mathDocument("ab");
    const rowId = bodyRowId(document);
    const raw = child(document, rowId, "children", "raw-text");
    const caret = textCaret(rowId, raw.id, visibleCharacterIds(raw).at(-1)!);

    const result = backspaceMathTree(document, caret);
    const { edited, undone } = applyWithUndo(document, result.edits);

    expect(print(edited)).toBe("a");
    expect(result.caret).toEqual(
      textCaret(rowId, raw.id, visibleCharacterIds(raw)[0]),
    );
    expectSemanticallyEqual(undone, document);
  });

  it("replaces a directional range in one raw-text leaf and undoes as one batch", () => {
    const document = mathDocument("abcd");
    const rowId = bodyRowId(document);
    const raw = child(document, rowId, "children", "raw-text");
    const [a, , c] = visibleCharacterIds(raw);

    const result = replaceMathTreeRange(
      document,
      {
        // Reversed selection direction must not change the replaced span.
        anchor: textCaret(rowId, raw.id, c),
        focus: textCaret(rowId, raw.id, a),
      },
      "X",
      identitySource("replace-range", 100),
    );
    const { edited, undone } = applyWithUndo(document, result.edits);

    expect(result.edits.map((edit) => edit.kind)).toEqual([
      "text_delete",
      "text_insert",
    ]);
    expect(print(edited)).toBe("aXd");
    expectSemanticallyEqual(undone, document);
  });

  it("normalizes identity anchors after concurrent insertion and tombstoning", () => {
    const initial = mathDocument("abcd");
    const rowId = bodyRowId(initial);
    const raw = child(initial, rowId, "children", "raw-text");
    const [a, b, c, d] = visibleCharacterIds(raw);
    const withRemotePrefix = applyStructuredEdit(initial, {
      kind: "text_insert",
      nodeId: raw.id,
      field: "text",
      afterCharId: null,
      charRuns: [{ peerId: "remote", startCounter: 50, text: "x" }],
    });
    const concurrent = applyStructuredEdit(withRemotePrefix, {
      kind: "text_delete",
      nodeId: raw.id,
      field: "text",
      charIds: [a],
    });

    const result = deleteMathTreeRange(concurrent, {
      // `a` is now a tombstone. Its stable stop falls after the remote prefix.
      anchor: textCaret(rowId, raw.id, a),
      focus: textCaret(rowId, raw.id, d),
    });
    const { edited, undone } = applyWithUndo(concurrent, result.edits);

    expect(result.edits).toEqual([
      {
        kind: "text_delete",
        nodeId: raw.id,
        field: "text",
        charIds: [b, c, d],
      },
    ]);
    expect(result.caret).toEqual(textCaret(rowId, raw.id, "remote:50"));
    expect(print(edited)).toBe("x");
    expectSemanticallyEqual(undone, concurrent);
  });

  it("deletes safely across raw leaves and whole row siblings", () => {
    const initial = mathDocument("ab");
    const rowId = bodyRowId(initial);
    const left = child(initial, rowId, "children", "raw-text");
    const [a] = visibleCharacterIds(left);
    const fractionResult = insertMathFraction(
      initial,
      rowCaret(rowId, left.id),
      identitySource("range-fraction", 100),
    );
    const withFraction = applyResult(initial, fractionResult);
    const fraction = child(withFraction, rowId, "children", "fraction");
    const rightResult = insertMathText(
      withFraction,
      rowCaret(rowId, fraction.id),
      "cd",
      identitySource("range-right", 200),
    );
    const document = applyResult(withFraction, rightResult);
    const right = getStructuredChildren(document, rowId, "children").at(-1)!;
    const [c] = visibleCharacterIds(right);

    const result = deleteMathTreeRange(document, {
      anchor: textCaret(rowId, left.id, a),
      focus: textCaret(rowId, right.id, c),
    });
    const { edited, undone } = applyWithUndo(document, result.edits);

    expect(result.edits.map((edit) => edit.kind)).toEqual([
      "text_delete",
      "node_delete",
      "text_delete",
    ]);
    expect(print(edited)).toBe("ad");
    expectSemanticallyEqual(undone, document);
    expect(
      getMathTreeRangeText(document, {
        anchor: textCaret(rowId, left.id, a),
        focus: textCaret(rowId, right.id, c),
      }),
    ).toEqual({
      handled: false,
      text: "",
      reason: "unsupported-position",
    });
  });

  it("extracts literal source across adjacent raw-text siblings", () => {
    const initial = mathDocument("ab");
    const rowId = bodyRowId(initial);
    const left = child(initial, rowId, "children", "raw-text");
    const [a] = visibleCharacterIds(left);
    const inserted = insertMathText(
      initial,
      rowCaret(rowId, left.id),
      "cd",
      identitySource("range-text", 100),
    );
    const document = applyResult(initial, inserted);
    const right = getStructuredChildren(document, rowId, "children").at(-1)!;
    const [c] = visibleCharacterIds(right);

    expect(
      getMathTreeRangeText(document, {
        anchor: textCaret(rowId, left.id, a),
        focus: textCaret(rowId, right.id, c),
      }),
    ).toEqual({ handled: true, text: "bc" });
  });

  it("implements forward delete without moving a stable text caret", () => {
    const document = mathDocument("ab");
    const rowId = bodyRowId(document);
    const raw = child(document, rowId, "children", "raw-text");
    const [a] = visibleCharacterIds(raw);

    const result = deleteForwardMathTree(document, textCaret(rowId, raw.id, a));
    const { edited, undone } = applyWithUndo(document, result.edits);

    expect(print(edited)).toBe("a");
    expect(result.caret).toEqual(textCaret(rowId, raw.id, a));
    expectSemanticallyEqual(undone, document);
  });

  it("reports cross-slot ranges instead of flattening them", () => {
    const fixture = fractionFixture();
    const result = deleteMathTreeRange(fixture.document, {
      anchor: fixture.numerator,
      focus: fixture.denominator,
    });

    expect(result).toMatchObject({
      handled: false,
      edits: [],
      reason: "unsupported-cross-slot-range",
    });
  });

  it("unwraps an empty denominator and preserves numerator children", () => {
    const fixture = fractionFixture();
    const inserted = insertMathText(
      fixture.document,
      fixture.numerator,
      "a",
      identitySource("numerator", 200),
    );
    const populated = applyResult(fixture.document, inserted);
    const numeratorNodeId = (inserted.caret as { nodeId: string }).nodeId;

    const result = backspaceMathTree(populated, fixture.denominator);
    const { edited, undone } = applyWithUndo(populated, result.edits);

    expect(result.edits.map((edit) => edit.kind)).toEqual([
      "node_move",
      "node_delete",
    ]);
    expect(result.caret).toEqual(rowCaret(fixture.outerRowId, numeratorNodeId));
    expect(print(edited)).toBe("a");
    expectSemanticallyEqual(undone, populated);
  });

  it("unwraps an empty numerator before preserved denominator children", () => {
    const fixture = fractionFixture();
    const inserted = insertMathText(
      fixture.document,
      fixture.denominator,
      "b",
      identitySource("denominator", 200),
    );
    const populated = applyResult(fixture.document, inserted);

    const result = backspaceMathTree(populated, fixture.numerator);
    const { edited, undone } = applyWithUndo(populated, result.edits);

    expect(result.caret).toEqual(rowCaret(fixture.outerRowId, null));
    expect(print(edited)).toBe("b");
    expectSemanticallyEqual(undone, populated);
  });

  it("removes a wholly empty fraction without leaving visible slot rows", () => {
    const fixture = fractionFixture();

    const result = backspaceMathTree(fixture.document, fixture.numerator);
    const { edited, undone } = applyWithUndo(fixture.document, result.edits);

    expect(result.edits).toEqual([
      { kind: "node_delete", nodeId: fixture.fractionId },
    ]);
    expect(result.caret).toEqual(rowCaret(fixture.outerRowId, null));
    expect(print(edited)).toBe("");
    expectSemanticallyEqual(undone, fixture.document);
  });

  it("rejects colliding or malformed injected identities without partial edits", () => {
    const document = mathDocument("");
    const rowId = bodyRowId(document);
    const collision = insertMathFraction(document, rowCaret(rowId, null), {
      nextId: () => document.rootId,
    });
    let allocations = 0;
    const malformed = insertMathText(document, rowCaret(rowId, null), "x", {
      nextId: () => (allocations++ === 0 ? "malformed:100" : "not-compound"),
    });

    expect(collision).toMatchObject({
      handled: false,
      edits: [],
      reason: "identity-collision",
    });
    expect(malformed).toMatchObject({
      handled: false,
      edits: [],
      reason: "invalid-identity",
    });
  });

  it("rejects an allocator that was not advanced past the existing RGA", () => {
    const document = mathDocument("ab");
    const rowId = bodyRowId(document);
    const raw = child(document, rowId, "children", "raw-text");
    const [a] = visibleCharacterIds(raw);

    const result = insertMathText(
      document,
      textCaret(rowId, raw.id, a),
      "X",
      createDeterministicIdentityAllocator("stale", 0),
    );

    expect(result).toMatchObject({
      handled: false,
      edits: [],
      reason: "invalid-identity",
    });
    expect(print(document)).toBe("ab");
  });
});

function mathDocument(text: string): StructuredDocument {
  return mathDocumentToStructured(
    {
      version: 1,
      root: {
        type: "root",
        id: "root",
        body: {
          type: "row",
          id: "body",
          children: text ? [{ type: "raw-text", id: "source", text }] : [],
        },
      },
    },
    {
      identityAllocator: createDeterministicIdentityAllocator("source-char"),
    },
  );
}

function matrixDocument(latex: string): StructuredDocument {
  const identities = createDeterministicIdentityAllocator("matrix-source");
  return mathDocumentToStructured(
    parseMathDocument(latex, { identityAllocator: identities }),
    { identityAllocator: identities },
  );
}

function fractionFixture(): {
  document: StructuredDocument;
  outerRowId: string;
  fractionId: string;
  numerator: MathRowCaret;
  denominator: MathRowCaret;
} {
  const initial = mathDocument("");
  const outerRowId = bodyRowId(initial);
  const inserted = insertMathFraction(
    initial,
    rowCaret(outerRowId, null),
    identitySource("fixture"),
  );
  const document = applyResult(initial, inserted);
  const fraction = child(document, outerRowId, "children", "fraction");
  const numerator = child(document, fraction.id, "numerator", "row");
  const denominator = child(document, fraction.id, "denominator", "row");
  return {
    document,
    outerRowId,
    fractionId: fraction.id,
    numerator: rowCaret(numerator.id, null),
    denominator: rowCaret(denominator.id, null),
  };
}

function identitySource(prefix: string, startCounter = 100): IdentityAllocator {
  return createDeterministicIdentityAllocator(prefix, startCounter);
}

function bodyRowId(document: StructuredDocument): string {
  return child(document, document.rootId, "body", "row").id;
}

function child(
  document: StructuredDocument,
  parentId: string,
  slot: string,
  type: string,
) {
  const values = getStructuredChildren(document, parentId, slot).filter(
    (node) => node.type === type,
  );
  if (values.length !== 1) {
    throw new Error(`expected one ${parentId}.${slot}:${type}`);
  }
  return values[0];
}

function visibleCharacterIds(node: {
  textFields: Readonly<
    Record<string, readonly import("../serlization/loadPage").CharRun[]>
  >;
}): string[] {
  return [...iterateAllChars([...(node.textFields.text ?? [])])]
    .filter((entry) => !entry.deleted)
    .map((entry) => entry.id);
}

function applyResult(
  document: StructuredDocument,
  result: { readonly edits: readonly StructuredEdit[] },
): StructuredDocument {
  const edited = applyStructuredEdits(document, result.edits);
  expect(validateStructuredMathDocument(edited)).toBeDefined();
  return edited;
}

function applyWithUndo(
  document: StructuredDocument,
  edits: readonly StructuredEdit[],
): { edited: StructuredDocument; undone: StructuredDocument } {
  let edited = document;
  const inverses: StructuredEdit[][] = [];
  for (const edit of edits) {
    inverses.unshift([...invertStructuredEdit(edit, edited)]);
    edited = applyStructuredEdit(edited, edit);
  }
  expect(validateStructuredMathDocument(edited)).toBeDefined();

  let undone = edited;
  for (const batch of inverses) {
    undone = applyStructuredEdits(undone, batch);
  }
  expect(validateStructuredMathDocument(undone)).toBeDefined();
  return { edited, undone };
}

function expectSemanticallyEqual(
  left: StructuredDocument,
  right: StructuredDocument,
): void {
  const leftMath = structuredToMathDocument(left);
  const rightMath = structuredToMathDocument(right);
  expect(leftMath).toBeDefined();
  expect(rightMath).toBeDefined();
  expect(mathDocumentsSemanticallyEqual(leftMath!, rightMath!)).toBe(true);
}

function print(document: StructuredDocument): string {
  const math = structuredToMathDocument(document);
  if (!math) throw new Error("invalid structured math fixture");
  return printMathDocument(math);
}

function rowCaret(rowId: string, afterNodeId: string | null): MathRowCaret {
  return { kind: "row", rowId, afterNodeId };
}

function textCaret(
  rowId: string,
  nodeId: string,
  afterCharId: string | null,
): MathTreeCaret {
  return { kind: "text", rowId, nodeId, field: "text", afterCharId };
}
