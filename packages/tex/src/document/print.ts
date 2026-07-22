import { tokenize } from "../parse/lexer";
import { MATH_OPERATORS } from "../parse/parser";
import type {
  MathDelimited,
  MathDocument,
  MathFraction,
  MathItemId,
  MathMatrix,
  MathNode,
  MathOperator,
  MathRawText,
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
  /**
   * Offsets in `latex` of `\`s that are raw-text FIELD CONTENT — the opening
   * `\` of every uncommitted `\`+letters command run. The legacy parser must
   * treat them as inert scratch (no `\\` fusion, no environment/wall effects —
   * see `ParseOptions.literalBackslashes`), because a resting `\end` or
   * `\begin` typed in a matrix cell would otherwise re-structure the REAL
   * environment around it. Independent of the caret, unlike `literalRange`.
   */
  readonly literalBackslashes: readonly number[];
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
  private readonly literalBackslashes: number[] = [];

  get offset(): number {
    return this.latex.length;
  }

  result(): MathDocumentSourceProjection {
    return {
      latex: this.latex,
      items: this.items,
      anchors: this.anchors,
      literalBackslashes: this.literalBackslashes,
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
        this.writeRawText(node, parentRowId);
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
          this.writeRow(node.index);
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
        this.writeRawLatex(node.latex);
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
    this.writeRow(node.numerator);
    this.write("\\atop ");
    this.writeRow(node.denominator);
    this.write("}");
  }

  private writeDelimited(node: MathDelimited): void {
    this.writeCommandWithArgument("left", node.left || ".");
    this.writeRow(node.body);
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
        // The separators belong to the matrix tree, never to editable cell
        // text. `writeRawText` keeps cell scratch from fusing with the `&`,
        // `\\`, or `\end` printed next (a trailing `\` projects as
        // `\backslash`; a half-typed `\end` is literal-marked).
        this.writeRow(cell.body);
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

  /**
   * Write an editable raw-text field. Characters project verbatim — raw text
   * is command-entry scratch, so a `\`+letters run must lex exactly as typed —
   * except for the two ways a `\` could leak syntax outside its own field:
   *
   * - A `\` NOT starting a letter run projects as the `\backslash` command.
   *   Left verbatim, the projection's next character would fuse with it into
   *   different syntax: the barrier space once written after a trailing `\`
   *   lexed as the invisible control space `\ ` (making a pending `\` vanish
   *   the moment the caret left it), and in a matrix cell a bare `\` would
   *   combine with the `&`/`\\`/`\end` the matrix prints next. `\backslash`
   *   renders the same visible glyph regardless of caret state and survives a
   *   canonical-source re-parse as a backslash.
   * - A `\` that DOES start a letter run stays verbatim but is recorded in
   *   `literalBackslashes`, so a resting half-typed `\end`/`\begin`/`\left`
   *   never acts structurally on the projection around it (see
   *   `ParseOptions.literalBackslashes`).
   */
  private writeRawText(node: MathRawText, parentRowId: MathItemId): void {
    const characters = [...node.text];
    let fieldOffset = 0;
    this.fieldAnchor(parentRowId, node.id, "text", fieldOffset);
    for (let index = 0; index < characters.length; index++) {
      const character = characters[index];
      if (character === "\\") {
        if (startsWithLetter(characters[index + 1] ?? "")) {
          this.literalBackslashes.push(this.offset);
          this.write(character);
        } else {
          this.write("\\backslash");
        }
      } else {
        this.write(character);
      }
      fieldOffset += character.length;
      this.fieldAnchor(parentRowId, node.id, "text", fieldOffset);
    }
  }

  /**
   * Write a raw-latex fragment so it cannot fuse with what the printer emits
   * next. A dangling bare `\` — an empty-named command, i.e. a `\` sitting
   * before another command's intro or at the fragment's end — re-lexes in the
   * FULL projection against the next printed character: `\` + `}` steals a
   * construct argument's closing brace as the literal `\}` glyph (de-structuring
   * the construct and conjuring a `}` the user never typed), and `\` + letters
   * seeds a phantom command name. Spell each dangler `\backslash` — the same
   * rewrite {@link writeRawText} applies to field content — which renders the
   * identical glyph and survives any following character. Tokens the fragment
   * closes itself (`\{`, `\frac{...}`, an internal `\\` row break) are copied
   * verbatim.
   */
  private writeRawLatex(latex: string): void {
    let from = 0;
    for (const token of tokenize(latex)) {
      if (token.kind === "command" && token.value === "") {
        this.write(latex.slice(from, token.start));
        this.write("\\backslash");
        from = token.end;
      }
    }
    this.write(latex.slice(from));
  }

  private writeArgument(row: MathRow): void {
    this.write("{");
    this.writeRow(row);
    this.write("}");
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

function startsWithLetter(value: string): boolean {
  return /^[A-Za-z]/.test(value);
}

function escapeTextChar(character: string): string {
  if (character === "\\") return "\\textbackslash{}";
  if (character === "{") return "\\{";
  if (character === "}") return "\\}";
  return character;
}
