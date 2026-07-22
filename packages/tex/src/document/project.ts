import { mathSymbols, type SymbolInfo } from "../data/symbols";
import type { Node } from "../parse/ast";
import { parse } from "../parse/parser";
import {
  type MathDocument,
  type MathFraction,
  type MathItemId,
  type MathMatrixCell,
  type MathMatrixRow,
  type MathNode,
  type MathRawLatex,
  type MathRawText,
  type MathRow,
  type MathSymbol,
  type MathTextVariant,
} from "./model";
import {
  createDeterministicIdentityAllocator,
  type IdentityAllocator,
  parseAllocatedIdentity,
} from "@shared/identity";

/** Options for importing a LaTeX string into a structured document. */
export interface ParseMathDocumentOptions {
  /**
   * Identity allocator for the imported tree. Defaults to deterministic ids
   * scoped to this standalone value. A collaborative host should inject the
   * allocator owned by its document/CRDT for authoritative live identities.
   */
  readonly identityAllocator?: IdentityAllocator;
  /**
   * Optional externally-owned root identity. Structured-content adapters use
   * this to make an attachment id and its root id the same stable identity.
   */
  readonly rootId?: MathItemId;
}

/** Options for projecting the package's unstable parse AST. */
export interface ProjectMathAstOptions extends ParseMathDocumentOptions {
  /** Original source used to create `ast`; required for lossless fallbacks. */
  readonly source: string;
}

/** Parse LaTeX into the stable, editable {@link MathDocument} representation. */
export function parseMathDocument(
  latex: string,
  options: ParseMathDocumentOptions = {},
): MathDocument {
  return projectMathAst(parse(latex), {
    source: latex,
    identityAllocator: options.identityAllocator,
    rootId: options.rootId,
  });
}

/**
 * Project the rendering parser's AST into a stable math document.
 *
 * This is intentionally an internal bridge: the source AST can change without
 * notice. Consumers should call {@link parseMathDocument}. Unsupported AST
 * nodes become exact `raw-latex` leaves instead of being discarded.
 */
export function projectMathAst(
  ast: Node,
  options: ProjectMathAstOptions,
): MathDocument {
  return new AstProjector(
    options.source,
    options.identityAllocator ??
      createDeterministicIdentityAllocator("tex-import"),
    options.rootId,
  ).project(ast);
}

class AstProjector {
  private readonly source: string;
  private readonly identities: IdentityAllocator;
  private readonly rootId?: MathItemId;
  private readonly issuedIds = new Set<MathItemId>();

  constructor(
    source: string,
    identities: IdentityAllocator,
    rootId?: MathItemId,
  ) {
    this.source = source;
    this.identities = identities;
    this.rootId = rootId;
    if (rootId !== undefined) {
      if (rootId.length === 0) throw new Error("Math root identity is empty");
      this.issuedIds.add(rootId);
    }
  }

  project(ast: Node): MathDocument {
    const rootId = this.rootId ?? this.nextId();
    return {
      version: 1,
      root: {
        type: "root",
        id: rootId,
        body: this.rowFromNode(ast),
      },
    };
  }

  private nextId(): MathItemId {
    const id = this.identities.nextId();
    if (!parseAllocatedIdentity(id)) {
      throw new Error("Identity allocator returned an invalid identity");
    }
    if (this.issuedIds.has(id)) {
      throw new Error(`Identity allocator collided with math identity: ${id}`);
    }
    this.issuedIds.add(id);
    return id;
  }

  private rowFromNode(node: Node): MathRow {
    return this.rowFromNodes(node.type === "ord" ? node.body : [node]);
  }

  private rowFromNodes(nodes: readonly Node[]): MathRow {
    const id = this.nextId();
    const children: MathNode[] = [];
    for (const node of nodes) {
      // An `ord` encountered as a child is an explicit group or a synthetic
      // parser expansion. Preserve that boundary verbatim. `ord` values used as
      // actual slots (root, arguments, matrix cells) are unwrapped by
      // `rowFromNode` above.
      if (node.type === "ord") {
        const structured = structuredGroupedNode(node);
        this.append(
          children,
          structured
            ? this.node(structured)
            : this.rawLatex(node, this.nextId()),
        );
      } else {
        this.append(children, this.node(node));
      }
    }
    return { type: "row", id, children };
  }

  private append(children: MathNode[], node: MathNode): void {
    const previous = children[children.length - 1];
    if (previous?.type === "raw-text" && node.type === "raw-text") {
      // Character tokens are intentionally coalesced into one editable run.
      // Keep the first run's id so appending text does not replace its identity.
      children[children.length - 1] = {
        ...previous,
        text: previous.text + node.text,
      };
      return;
    }
    children.push(node);
  }

  private node(node: Exclude<Node, { type: "ord" }>): MathNode {
    const id = this.nextId();
    switch (node.type) {
      case "atom":
        return this.atom(node.info, node, id);
      case "frac":
        return this.fraction(node, id);
      case "sqrt":
        return {
          type: "radical",
          id,
          index: node.index ? this.rowFromNode(node.index) : null,
          radicand: this.rowFromNode(node.body),
        };
      case "supsub":
        return {
          type: "scripts",
          id,
          base: node.base ? this.rowFromNode(node.base) : this.emptyRow(),
          superscript: node.sup ? this.rowFromNode(node.sup) : null,
          subscript: node.sub ? this.rowFromNode(node.sub) : null,
        };
      case "leftright":
        return {
          type: "delimited",
          id,
          left: node.left,
          right: node.right,
          body: this.rowFromNodes(node.body),
        };
      case "array":
        return {
          type: "matrix",
          id,
          environment: node.env,
          columnAlignment: node.colAlign ? [...node.colAlign] : null,
          rows: node.rows.map((row) => this.matrixRow(row)),
        };
      case "text": {
        const variant = textVariant(node.variant);
        return variant
          ? { type: "text", id, text: node.text, variant }
          : this.rawLatex(node, id);
      }
      case "opname":
        return {
          type: "operator",
          id,
          name: node.name,
          limits: node.limits,
        };
      case "unknown":
      case "sizeddelim":
      case "accent":
      case "overunder":
      case "mathfont":
      case "not":
      case "mclass":
      case "stack":
      case "boxed":
      case "phantom":
      case "style":
      case "infix":
      case "space":
        return this.rawLatex(node, id);
    }
  }

  private fraction(
    node: Extract<Node, { type: "frac" }>,
    id: MathItemId,
  ): MathFraction {
    return {
      type: "fraction",
      id,
      numerator: this.rowFromNode(node.num),
      denominator: this.rowFromNode(node.den),
      bar: node.hasRule === false ? "none" : "rule",
      style: node.forceStyle ?? "auto",
      continued: node.continued === true,
      leftDelimiter: node.leftDelim ?? null,
      rightDelimiter: node.rightDelim ?? null,
    };
  }

  private matrixRow(nodes: readonly Node[]): MathMatrixRow {
    const id = this.nextId();
    return {
      type: "matrix-row",
      id,
      cells: nodes.map((node) => this.matrixCell(node)),
    };
  }

  private matrixCell(node: Node): MathMatrixCell {
    const id = this.nextId();
    return {
      type: "matrix-cell",
      id,
      body: this.rowFromNode(node),
    };
  }

  private emptyRow(): MathRow {
    return { type: "row", id: this.nextId(), children: [] };
  }

  private atom(
    info: SymbolInfo,
    node: Extract<Node, { type: "atom" }>,
    id: MathItemId,
  ): MathRawText | MathSymbol | MathRawLatex {
    const latex = this.sourceFor(node);
    const command = commandName(latex);
    if (command !== null) {
      return {
        type: "symbol",
        id,
        value: info.char,
        command,
        symbolClass: info.group,
      };
    }

    if (latex !== "" && sameSymbolInfo(literalInfo(latex), info)) {
      return { type: "raw-text", id, text: latex };
    }

    // Prime shorthand is synthesized by the parser (`x'` becomes a `\prime`
    // superscript), so its source slice is not itself the resulting atom. Find a
    // deterministic command with the same symbol semantics for a safe print.
    const canonical = canonicalCommand(info);
    if (canonical !== null) {
      return {
        type: "symbol",
        id,
        value: info.char,
        command: canonical,
        symbolClass: info.group,
      };
    }

    return { type: "raw-latex", id, latex };
  }

  private rawLatex(node: Node, id: MathItemId): MathRawLatex {
    return { type: "raw-latex", id, latex: this.sourceFor(node) };
  }

  private sourceFor(node: Node): string {
    const start = Math.max(0, Math.min(this.source.length, node.span.start));
    const end = Math.max(start, Math.min(this.source.length, node.span.end));
    return this.source.slice(start, end);
  }
}

/**
 * A group containing only a generalized fraction is safe to make structural:
 * the printer can reproduce each of these forms without changing its meaning.
 * Other explicit groups stay raw until the model has a first-class group node.
 */
function structuredGroupedNode(
  node: Extract<Node, { type: "ord" }>,
): Exclude<Node, { type: "ord" }> | null {
  if (node.body.length !== 1 || node.body[0].type !== "frac") return null;
  const fraction = node.body[0];
  const noDelimiters =
    fraction.leftDelim === undefined && fraction.rightDelim === undefined;
  const binomial =
    fraction.hasRule === false &&
    fraction.leftDelim === "(" &&
    fraction.rightDelim === ")";
  return noDelimiters || binomial ? fraction : null;
}

function commandName(latex: string): string | null {
  const match = latex.match(/^\\([A-Za-z]+|[^A-Za-z])$/);
  return match ? match[1] : null;
}

function literalInfo(latex: string): SymbolInfo | undefined {
  return (
    mathSymbols[latex] ??
    (latex.length > 0
      ? { font: "main", group: "textord", char: latex }
      : undefined)
  );
}

function sameSymbolInfo(
  left: SymbolInfo | undefined,
  right: SymbolInfo,
): boolean {
  return (
    left?.font === right.font &&
    left.group === right.group &&
    left.char === right.char
  );
}

function canonicalCommand(info: SymbolInfo): string | null {
  const candidates = Object.entries(mathSymbols)
    .filter(
      ([latex, candidate]) =>
        latex.startsWith("\\") &&
        !latex.startsWith("\\@") &&
        sameSymbolInfo(candidate, info),
    )
    .map(([latex]) => latex.slice(1))
    .sort(
      (left, right) => left.length - right.length || left.localeCompare(right),
    );
  return candidates[0] ?? null;
}

function textVariant(variant: string): MathTextVariant | null {
  switch (variant) {
    case "Main-Regular":
      return "normal";
    case "Main-Bold":
      return "bold";
    case "Main-Italic":
      return "italic";
    case "Typewriter-Regular":
      return "monospace";
    case "SansSerif-Regular":
      return "sans-serif";
    default:
      return null;
  }
}
