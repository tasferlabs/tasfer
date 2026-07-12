import {
  createDeterministicIdentityAllocator,
  type MathDocument,
  mathDocumentsSemanticallyEqual,
  type MathNode,
  type MathRow,
  parseMathDocument,
  printMathDocument,
} from "../index";
import { describe, expect, it } from "vitest";

describe("MathDocument projection", () => {
  it("projects supported constructs into identity-bearing tree nodes", () => {
    const latex = String.raw`x+\frac{a_1}{\sqrt[3]{b}}+\left(\sin x\right)+\begin{bmatrix}a&b\\c&d\end{bmatrix}+\textbf{hi}`;
    const document = parseMathDocument(latex, {
      identityAllocator: createDeterministicIdentityAllocator("test"),
    });

    expect(document.version).toBe(1);
    expect(document.root.type).toBe("root");
    expect(document.root.body.type).toBe("row");
    expect(document.root.body.children.map((node) => node.type)).toEqual([
      "raw-text",
      "fraction",
      "raw-text",
      "delimited",
      "raw-text",
      "matrix",
      "raw-text",
      "text",
    ]);

    const fraction = document.root.body.children[1];
    if (fraction?.type !== "fraction") throw new Error("expected fraction");
    expect(fraction.numerator.children[0]?.type).toBe("scripts");
    expect(fraction.denominator.children[0]?.type).toBe("radical");

    const delimited = document.root.body.children[3];
    if (delimited?.type !== "delimited")
      throw new Error("expected delimited node");
    expect(delimited.body.children.map((node) => node.type)).toEqual([
      "operator",
      "raw-text",
    ]);

    const matrix = document.root.body.children[5];
    if (matrix?.type !== "matrix") throw new Error("expected matrix");
    expect(matrix.rows).toHaveLength(2);
    expect(matrix.rows.map((row) => row.cells.length)).toEqual([2, 2]);

    const ids = collectIds(document);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("test:"))).toBe(true);
  });

  it("uses deterministic ids when given equivalent allocators", () => {
    const latex = String.raw`\frac{x}{\sqrt{y}}`;
    const first = parseMathDocument(latex, {
      identityAllocator: createDeterministicIdentityAllocator("content"),
    });
    const second = parseMathDocument(latex, {
      identityAllocator: createDeterministicIdentityAllocator("content"),
    });
    expect(first).toEqual(second);
  });

  it("accepts an externally owned root without forking identity allocation", () => {
    const identities = createDeterministicIdentityAllocator("attachment");
    const document = parseMathDocument("x", {
      identityAllocator: identities,
      rootId: "block-7/math",
    });

    expect(document.root.id).toBe("block-7/math");
    expect(document.root.body.id).toBe("attachment:0");
    expect(document.root.body.children[0]?.id).toBe("attachment:1");
    expect(identities.nextId()).toBe("attachment:2");
  });

  it("rejects allocators outside the shared compound identity contract", () => {
    expect(() =>
      parseMathDocument("x", { identityAllocator: { nextId: () => "bad" } }),
    ).toThrow(/invalid identity/);
    expect(() =>
      parseMathDocument("x", {
        rootId: "collision:0",
        identityAllocator: createDeterministicIdentityAllocator("collision"),
      }),
    ).toThrow(/collided/);
  });

  it("separates named symbols from editable raw-text runs", () => {
    const document = parseMathDocument(String.raw`\alpha xy`);
    expect(document.root.body.children.map((node) => node.type)).toEqual([
      "symbol",
      "raw-text",
    ]);
    const symbol = document.root.body.children[0];
    if (symbol?.type !== "symbol") throw new Error("expected symbol");
    expect(symbol).toMatchObject({
      command: "alpha",
      value: "α",
      symbolClass: "mathord",
    });
    expect(document.root.body.children[1]).toMatchObject({ text: "xy" });
  });

  it("preserves unsupported subtrees as exact raw LaTeX", () => {
    const latex = String.raw`x+\widehat{ab}+\mathbf{z}+\doesnotexist`;
    const document = parseMathDocument(latex);
    const raw = document.root.body.children
      .filter((node) => node.type === "raw-latex")
      .map((node) => node.latex);

    expect(raw).toEqual([
      String.raw`\widehat{ab}`,
      String.raw`\mathbf{z}`,
      String.raw`\doesnotexist`,
    ]);
    expect(printMathDocument(document)).toBe(latex);
  });
});

describe("MathDocument LaTeX printer", () => {
  it.each([
    [String.raw`\frac{a}{b}`, String.raw`\frac{a}{b}`],
    [String.raw`\sqrt[3]{x}`, String.raw`\sqrt[3]{x}`],
    [String.raw`x^2_i`, String.raw`{x}_{i}^{2}`],
    [String.raw`\left(\alpha\right)`, String.raw`\left(\alpha\right)`],
    [
      String.raw`\left\langle x\right\rangle`,
      String.raw`\left\langle x\right\rangle`,
    ],
    [String.raw`\binom{n}{k}`, String.raw`\binom{n}{k}`],
    [String.raw`\textbf{hello}`, String.raw`\textbf{hello}`],
    [String.raw`\operatorname*{rank}`, String.raw`\operatorname*{rank}`],
    [
      String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`,
      String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`,
    ],
  ])("prints %s canonically", (input, expected) => {
    const document = parseMathDocument(input);
    expect(printMathDocument(document)).toBe(expected);
    expect(printMathDocument(document)).toBe(expected);
  });

  it("inserts a command separator only when a following letter needs it", () => {
    expect(printMathDocument(parseMathDocument(String.raw`\alpha x`))).toBe(
      String.raw`\alpha x`,
    );
    expect(printMathDocument(parseMathDocument(String.raw`\alpha+1`))).toBe(
      String.raw`\alpha+1`,
    );
  });

  it("escapes braces and backslashes in text mode", () => {
    const input = String.raw`\text{a\{b\}\textbackslash{}c}`;
    const printed = printMathDocument(parseMathDocument(input));
    expect(printed).toBe(input);
    expect(
      mathDocumentsSemanticallyEqual(
        parseMathDocument(input),
        parseMathDocument(printed),
      ),
    ).toBe(true);
  });

  it("keeps pending backslashes from consuming matrix structure", () => {
    const initial = parseMathDocument(
      String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`,
    );
    const matrix = initial.root.body.children[0];
    if (matrix?.type !== "matrix") throw new Error("expected matrix");
    const firstCell = matrix.rows[0].cells[0];
    const pending: MathDocument = {
      ...initial,
      root: {
        ...initial.root,
        body: {
          ...initial.root.body,
          children: [
            {
              ...matrix,
              rows: [
                {
                  ...matrix.rows[0],
                  cells: [
                    {
                      ...firstCell,
                      body: {
                        ...firstCell.body,
                        children: [
                          { type: "raw-text", id: "pending", text: "a\\" },
                        ],
                      },
                    },
                    matrix.rows[0].cells[1],
                  ],
                },
                matrix.rows[1],
              ],
            },
          ],
        },
      },
    };

    const printed = printMathDocument(pending);
    expect(printed).toBe(String.raw`\begin{bmatrix}a\ &b\\c&d\end{bmatrix}`);
    const reparsed = parseMathDocument(printed);
    const reparsedMatrix = reparsed.root.body.children[0];
    expect(reparsedMatrix?.type).toBe("matrix");
    if (reparsedMatrix?.type !== "matrix") return;
    expect(reparsedMatrix.rows.map((row) => row.cells.length)).toEqual([2, 2]);
  });
});

describe("MathDocument semantic round trips", () => {
  const corpus = [
    "",
    "x+1",
    String.raw`\alpha x+\frac{a_1}{\sqrt[3]{b}}`,
    String.raw`\left(\sin x\right)`,
    String.raw`\binom{n}{k}+\operatorname*{rank}`,
    String.raw`{a\over b}+{c\atop d}+{n\choose k}`,
    String.raw`\begin{array}{lcr}a&b&c\\d&e&f\end{array}`,
    String.raw`\text{hello world}+\textit{there}`,
    String.raw`x'`,
    String.raw`x+\widehat{ab}+y`,
  ];

  for (const latex of corpus) {
    it(`round-trips ${JSON.stringify(latex)}`, () => {
      const first = parseMathDocument(latex, {
        identityAllocator: createDeterministicIdentityAllocator("first"),
      });
      const printed = printMathDocument(first);
      const second = parseMathDocument(printed, {
        identityAllocator: createDeterministicIdentityAllocator("second"),
      });
      expect(mathDocumentsSemanticallyEqual(first, second)).toBe(true);
    });
  }

  it("ignores ids and raw-text chunk boundaries", () => {
    const first = parseMathDocument("abc", {
      identityAllocator: createDeterministicIdentityAllocator("one"),
    });
    const second: MathDocument = {
      version: 1,
      root: {
        type: "root",
        id: "other-root",
        body: {
          type: "row",
          id: "other-row",
          children: [
            { type: "raw-text", id: "a", text: "a" },
            { type: "raw-text", id: "b", text: "bc" },
          ],
        },
      },
    };
    expect(mathDocumentsSemanticallyEqual(first, second)).toBe(true);
  });

  it("treats equivalent symbol aliases as the same semantics", () => {
    expect(
      mathDocumentsSemanticallyEqual(
        parseMathDocument(String.raw`\sdot`),
        parseMathDocument(String.raw`\cdot`),
      ),
    ).toBe(true);
  });
});

function collectIds(document: MathDocument): string[] {
  const ids = [document.root.id];
  collectRowIds(document.root.body, ids);
  return ids;
}

function collectRowIds(row: MathRow, ids: string[]): void {
  ids.push(row.id);
  for (const node of row.children) collectNodeIds(node, ids);
}

function collectNodeIds(node: MathNode, ids: string[]): void {
  ids.push(node.id);
  switch (node.type) {
    case "fraction":
      collectRowIds(node.numerator, ids);
      collectRowIds(node.denominator, ids);
      break;
    case "radical":
      if (node.index) collectRowIds(node.index, ids);
      collectRowIds(node.radicand, ids);
      break;
    case "scripts":
      collectRowIds(node.base, ids);
      if (node.superscript) collectRowIds(node.superscript, ids);
      if (node.subscript) collectRowIds(node.subscript, ids);
      break;
    case "delimited":
      collectRowIds(node.body, ids);
      break;
    case "matrix":
      for (const matrixRow of node.rows) {
        ids.push(matrixRow.id);
        for (const cell of matrixRow.cells) {
          ids.push(cell.id);
          collectRowIds(cell.body, ids);
        }
      }
      break;
    case "raw-text":
    case "symbol":
    case "text":
    case "operator":
    case "raw-latex":
      break;
  }
}
