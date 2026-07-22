import type { MathDocument, MathNode, MathRow } from "./model";

type SemanticValue =
  | null
  | boolean
  | number
  | string
  | readonly SemanticValue[];

/**
 * Compare formula meaning while deliberately ignoring all stable ids.
 * Adjacent raw-text leaves are treated as one run, so CRDT chunk boundaries do
 * not affect equality.
 */
export function mathDocumentsSemanticallyEqual(
  left: MathDocument,
  right: MathDocument,
): boolean {
  return (
    JSON.stringify(documentValue(left)) === JSON.stringify(documentValue(right))
  );
}

function documentValue(document: MathDocument): SemanticValue {
  return ["math-document", document.version, rowValue(document.root.body)];
}

function rowValue(row: MathRow): SemanticValue {
  const children: SemanticValue[] = [];
  let rawText = "";
  let hasRawText = false;
  const flushRawText = (): void => {
    if (!hasRawText) return;
    children.push(["raw-text", rawText]);
    rawText = "";
    hasRawText = false;
  };

  for (const node of row.children) {
    if (node.type === "raw-text") {
      rawText += node.text;
      hasRawText = true;
    } else {
      flushRawText();
      children.push(nodeValue(node));
    }
  }
  flushRawText();
  return ["row", children];
}

function nodeValue(
  node: Exclude<MathNode, { type: "raw-text" }>,
): SemanticValue {
  switch (node.type) {
    case "symbol":
      // `command` is a serialization hint (`\\ne` and `\\neq` may spell the
      // same glyph/class). It is deliberately absent from semantic identity.
      return ["symbol", node.value, node.symbolClass];
    case "fraction":
      return [
        "fraction",
        rowValue(node.numerator),
        rowValue(node.denominator),
        node.bar,
        node.style,
        node.continued,
        node.leftDelimiter,
        node.rightDelimiter,
      ];
    case "radical":
      return [
        "radical",
        node.index ? rowValue(node.index) : null,
        rowValue(node.radicand),
      ];
    case "scripts":
      return [
        "scripts",
        rowValue(node.base),
        node.superscript ? rowValue(node.superscript) : null,
        node.subscript ? rowValue(node.subscript) : null,
      ];
    case "delimited":
      return ["delimited", node.left, rowValue(node.body), node.right];
    case "matrix":
      return [
        "matrix",
        node.environment,
        node.columnAlignment ? [...node.columnAlignment] : null,
        node.rows.map((row) => [
          "matrix-row",
          row.cells.map((cell) => ["matrix-cell", rowValue(cell.body)]),
        ]),
      ];
    case "text":
      return ["text", node.text, node.variant];
    case "operator":
      return ["operator", node.name, node.limits];
    case "raw-latex":
      return ["raw-latex", node.latex];
  }
}
