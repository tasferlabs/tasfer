import { MATH_OPERATORS } from "../parse/parser";
import type {
  MathDelimited,
  MathDocument,
  MathFraction,
  MathItemId,
  MathMatrix,
  MathNode,
  MathOperator,
  MathRow,
  MathText,
} from "./model";

/** Internal source range used to bridge the stable tree to the legacy layout. */
export interface ProjectedMathItem {
  readonly id: MathItemId;
  readonly type:
    | "root"
    | "row"
    | "matrix-row"
    | "matrix-cell"
    | MathNode["type"];
  readonly start: number;
  readonly end: number;
  readonly parentRowId?: MathItemId;
}

/** Internal identity anchor at one boundary in the canonical source projection. */
export type ProjectedMathAnchor =
  | {
      readonly sourceOffset: number;
      readonly kind: "row";
      readonly rowId: MathItemId;
      readonly offset: number;
      readonly nodeId?: MathItemId;
    }
  | {
      readonly sourceOffset: number;
      readonly kind: "field";
      readonly rowId: MathItemId;
      readonly nodeId: MathItemId;
      readonly field: "text" | "latex" | "name";
      readonly offset: number;
    };

/**
 * Transient bridge consumed by `layoutMathDocument`. It is deliberately not a
 * public editor model: LaTeX is an implementation detail of the current layout
 * engine, while every range and caret boundary maps back to stable tree ids.
 */
export interface MathDocumentSourceProjection {
  readonly latex: string;
  readonly items: readonly ProjectedMathItem[];
  readonly anchors: readonly ProjectedMathAnchor[];
}

/** Serialize a structured math document to deterministic, canonical LaTeX. */
export function printMathDocument(document: MathDocument): string {
  return projectMathDocumentSource(document).latex;
}

/** Serialize one editable row. Primarily useful to extension authors. */
export function printMathRow(row: MathRow): string {
  const printer = new MathDocumentPrinter();
  printer.writeRow(row);
  return printer.result().latex;
}

/** @internal Create canonical source plus stable-id ranges for the layout bridge. */
export function projectMathDocumentSource(
  document: MathDocument,
): MathDocumentSourceProjection {
  const printer = new MathDocumentPrinter();
  const start = printer.offset;
  printer.writeRow(document.root.body);
  printer.recordItem(document.root.id, "root", start, printer.offset);
  return printer.result();
}

class MathDocumentPrinter {
  private latex = "";
  private readonly items: ProjectedMathItem[] = [];
  private readonly anchors: ProjectedMathAnchor[] = [];

  get offset(): number {
    return this.latex.length;
  }

  result(): MathDocumentSourceProjection {
    return {
      latex: this.latex,
      items: this.items,
      anchors: this.anchors,
    };
  }

  recordItem(
    id: MathItemId,
    type: ProjectedMathItem["type"],
    start: number,
    end: number,
    parentRowId?: MathItemId,
  ): void {
    this.items.push({ id, type, start, end, parentRowId });
  }

  writeRow(row: MathRow): void {
    const start = this.offset;
    const first = row.children[0];
    if (first) this.rowAnchor(row.id, 0, first.id);
    else this.rowAnchor(row.id, 0);

    for (let index = 0; index < row.children.length; index++) {
      const node = row.children[index];
      // A trailing editable `\` is command-entry scratch, not syntax owned by
      // either sibling. Keep it from fusing with a following semantic node
      // (notably `\frac`, which would otherwise become a matrix row break).
      if (index > 0 && rowEndsWithPendingBackslash(row, index)) {
        this.write(" ");
      }
      if (endsWithControlWord(this.latex) && nodeStartsWithLetter(node)) {
        this.write(" ");
      }
      this.writeNode(node, row.id);
      this.rowAnchor(row.id, index + 1, node.id);
    }

    this.recordItem(row.id, "row", start, this.offset);
  }

  private writeNode(node: MathNode, parentRowId: MathItemId): void {
    const start = this.offset;
    switch (node.type) {
      case "raw-text":
        this.writeField(node.text, parentRowId, node.id, "text", identity);
        break;
      case "symbol":
        this.write(
          node.command === undefined ? node.value : `\\${node.command}`,
        );
        break;
      case "fraction":
        this.writeFraction(node);
        break;
      case "radical":
        this.write("\\sqrt");
        if (node.index) {
          this.write("[");
          this.writeStructuralRow(node.index);
          this.write("]");
        }
        this.writeArgument(node.radicand);
        break;
      case "scripts":
        this.writeArgument(node.base);
        if (node.subscript) {
          this.write("_");
          this.writeArgument(node.subscript);
        }
        if (node.superscript) {
          this.write("^");
          this.writeArgument(node.superscript);
        }
        break;
      case "delimited":
        this.writeDelimited(node);
        break;
      case "matrix":
        this.writeMatrix(node);
        break;
      case "text":
        this.writeText(node, parentRowId);
        break;
      case "operator":
        this.writeOperator(node, parentRowId);
        break;
      case "raw-latex":
        // Unsupported source is a lossless but atomic compatibility leaf.
        // Deliberately omit per-character field anchors: ordinary tree editing
        // may select/delete the whole node, but can never remove half a command
        // or one of its balancing braces.
        this.write(node.latex);
        break;
    }
    this.recordItem(node.id, node.type, start, this.offset, parentRowId);
  }

  private writeFraction(node: MathFraction): void {
    const noDelimiters =
      node.leftDelimiter === null && node.rightDelimiter === null;

    if (node.bar === "rule" && noDelimiters) {
      const command = node.continued
        ? "cfrac"
        : node.style === "display"
          ? "dfrac"
          : node.style === "text"
            ? "tfrac"
            : "frac";
      this.write(`\\${command}`);
      this.writeArgument(node.numerator);
      this.writeArgument(node.denominator);
      return;
    }

    if (
      node.bar === "none" &&
      node.leftDelimiter === "(" &&
      node.rightDelimiter === ")" &&
      !node.continued
    ) {
      const command =
        node.style === "display"
          ? "dbinom"
          : node.style === "text"
            ? "tbinom"
            : "binom";
      this.write(`\\${command}`);
      this.writeArgument(node.numerator);
      this.writeArgument(node.denominator);
      return;
    }

    if (node.bar === "none" && noDelimiters) {
      this.writeAtop(node);
      return;
    }

    this.writeCommandWithArgument("left", node.leftDelimiter ?? ".");
    if (node.bar === "rule") {
      this.write("\\frac");
      this.writeArgument(node.numerator);
      this.writeArgument(node.denominator);
    } else {
      this.writeAtop(node);
    }
    this.writeCommandWithArgument("right", node.rightDelimiter ?? ".");
  }

  private writeAtop(node: MathFraction): void {
    this.write("{");
    this.writeStructuralRow(node.numerator);
    this.write("\\atop ");
    this.writeStructuralRow(node.denominator);
    this.write("}");
  }

  private writeDelimited(node: MathDelimited): void {
    this.writeCommandWithArgument("left", node.left || ".");
    this.writeStructuralRow(node.body);
    this.writeCommandWithArgument("right", node.right || ".");
  }

  private writeMatrix(node: MathMatrix): void {
    this.write(`\\begin{${node.environment}}`);
    if (node.columnAlignment) {
      this.write(`{${node.columnAlignment.join("")}}`);
    }

    for (let rowIndex = 0; rowIndex < node.rows.length; rowIndex++) {
      if (rowIndex > 0) this.write("\\\\");
      const matrixRow = node.rows[rowIndex];
      const rowStart = this.offset;
      for (let cellIndex = 0; cellIndex < matrixRow.cells.length; cellIndex++) {
        if (cellIndex > 0) this.write("&");
        const cell = matrixRow.cells[cellIndex];
        const cellStart = this.offset;
        // The separator belongs to the matrix tree, never to editable cell
        // text. A pending trailing backslash therefore needs a lexical barrier
        // before `&`, `\\`, or `\end` is projected for the legacy parser.
        this.writeStructuralRow(cell.body);
        this.recordItem(cell.id, "matrix-cell", cellStart, this.offset);
      }
      this.recordItem(matrixRow.id, "matrix-row", rowStart, this.offset);
    }

    this.write(`\\end{${node.environment}}`);
  }

  private writeText(node: MathText, parentRowId: MathItemId): void {
    const command =
      node.variant === "bold"
        ? "textbf"
        : node.variant === "italic"
          ? "textit"
          : node.variant === "monospace"
            ? "texttt"
            : node.variant === "sans-serif"
              ? "textsf"
              : "text";
    this.write(`\\${command}{`);
    this.writeField(node.text, parentRowId, node.id, "text", escapeTextChar);
    this.write("}");
  }

  private writeOperator(node: MathOperator, parentRowId: MathItemId): void {
    this.fieldAnchor(parentRowId, node.id, "name", 0);
    if (
      /^[A-Za-z]+$/.test(node.name) &&
      Object.prototype.hasOwnProperty.call(MATH_OPERATORS, node.name) &&
      MATH_OPERATORS[node.name] === node.limits
    ) {
      this.write(`\\${node.name}`);
      this.fieldAnchor(parentRowId, node.id, "name", node.name.length);
      return;
    }

    this.write(`\\operatorname${node.limits ? "*" : ""}{`);
    for (const character of node.name) this.write(escapeTextChar(character));
    this.write("}");
    this.fieldAnchor(parentRowId, node.id, "name", node.name.length);
  }

  private writeArgument(row: MathRow): void {
    this.write("{");
    this.writeStructuralRow(row);
    this.write("}");
  }

  /** Write a row whose next source character is owned by its parent node. */
  private writeStructuralRow(row: MathRow): void {
    this.writeRow(row);
    if (rowEndsWithPendingBackslash(row)) this.write(" ");
  }

  private writeCommandWithArgument(command: string, argument: string): void {
    this.write(`\\${command}`);
    if (startsWithLetter(argument)) this.write(" ");
    this.write(argument);
  }

  private writeField(
    value: string,
    rowId: MathItemId,
    nodeId: MathItemId,
    field: "text" | "latex" | "name",
    encode: (character: string) => string,
  ): void {
    let fieldOffset = 0;
    this.fieldAnchor(rowId, nodeId, field, fieldOffset);
    for (const character of value) {
      this.write(encode(character));
      fieldOffset += character.length;
      this.fieldAnchor(rowId, nodeId, field, fieldOffset);
    }
  }

  private rowAnchor(
    rowId: MathItemId,
    offset: number,
    nodeId?: MathItemId,
  ): void {
    this.anchors.push({
      sourceOffset: this.offset,
      kind: "row",
      rowId,
      offset,
      nodeId,
    });
  }

  private fieldAnchor(
    rowId: MathItemId,
    nodeId: MathItemId,
    field: "text" | "latex" | "name",
    offset: number,
  ): void {
    this.anchors.push({
      sourceOffset: this.offset,
      kind: "field",
      rowId,
      nodeId,
      field,
      offset,
    });
  }

  private write(value: string): void {
    this.latex += value;
  }
}

function nodeStartsWithLetter(node: MathNode): boolean {
  if (node.type === "raw-text") return startsWithLetter(node.text);
  if (node.type === "raw-latex") return startsWithLetter(node.latex);
  return (
    node.type === "symbol" &&
    node.command === undefined &&
    startsWithLetter(node.value)
  );
}

function endsWithControlWord(value: string): boolean {
  return /\\[A-Za-z]+$/.test(value);
}

function rowEndsWithPendingBackslash(
  row: MathRow,
  end = row.children.length,
): boolean {
  const node = row.children[end - 1];
  return node?.type === "raw-text" && node.text.endsWith("\\");
}

function startsWithLetter(value: string): boolean {
  return /^[A-Za-z]/.test(value);
}

function identity(value: string): string {
  return value;
}

function escapeTextChar(character: string): string {
  if (character === "\\") return "\\textbackslash{}";
  if (character === "{") return "\\{";
  if (character === "}") return "\\}";
  return character;
}
