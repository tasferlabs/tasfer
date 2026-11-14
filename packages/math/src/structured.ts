/**
 * Structured-content adapter for the optional math feature.
 *
 * `MathDocument` is the ergonomic nested model exposed by `@tasfer/tex`;
 * `StructuredDocument` is the normalized, schema-agnostic CRDT store owned by
 * editor core. This module is the only place that knows how those shapes map.
 */

import type { Block, Char, CharRun } from "@tasfer/editor/serlization/loadPage";
import { charsToRuns } from "@tasfer/editor/sync/char-runs";
import { generateNKeysBetween } from "@tasfer/editor/sync/fractional-index";
import {
  createDeterministicIdentityAllocator,
  type IdentityAllocator,
  parseAllocatedIdentity,
} from "@tasfer/editor/sync/id";
import {
  getStructuredChildren,
  getStructuredText,
  structuredContentId,
  type StructuredDocument,
  type StructuredMutation,
  type StructuredNode,
  type StructuredPlacement,
  type StructuredValue,
  validateStructuredDocument,
} from "@tasfer/editor/sync/structured-content";
import {
  isAccentCommand,
  isStackCommand,
  isWrapperCommand,
  type MathDocument,
  type MathMatrixCell,
  type MathMatrixRow,
  type MathNode,
  type MathRow,
  parseMathDocument,
  printMathDocument,
} from "@tasfer/tex/data";

/**
 * The `kind` value (`"math"`) that marks a structured document as a math
 * equation.
 */
export const MATH_STRUCTURED_KIND = "math";

/**
 * Returns the id a math block stores its equation under: `${blockId}/math`.
 *
 * @deprecated Use `structuredContentId(blockId, "math")` from `@tasfer/editor`. It returns the same value.
 */
export function mathContentIdForBlock(blockId: string): string {
  return structuredContentId(blockId, MATH_STRUCTURED_KIND);
}

/**
 * Returns the equation stored on a math block, as stored. It is not checked for
 * validity. Returns `undefined` when the block has none.
 */
export function getMathStructuredDocument(
  block: Pick<Block, "id" | "structuredContent">,
): StructuredDocument | undefined {
  const contentId = mathContentIdForBlock(block.id);
  const document = block.structuredContent?.[contentId];
  return document?.kind === MATH_STRUCTURED_KIND ? document : undefined;
}

/**
 * Returns a math block's equation as a `MathDocument`. Returns `undefined` when
 * the block has no structured equation or its data is not valid.
 */
export function getMathDocumentForBlock(
  block: Pick<Block, "id" | "structuredContent">,
): MathDocument | undefined {
  const document = getMathStructuredDocument(block);
  return document ? structuredToMathDocument(document) : undefined;
}

/**
 * Returns the block's equation as LaTeX, printed from its structured form.
 * Returns `undefined` when the block has no valid structured equation, such as
 * an older block.
 */
export function getStructuredMathSource(
  block: Pick<Block, "id" | "structuredContent">,
): string | undefined {
  const document = getMathDocumentForBlock(block);
  return document ? printMathDocument(document) : undefined;
}

/**
 * Options for how ids are made when a formula is converted to structured form.
 *
 * One allocator gives ids to both nodes and characters, so the two never clash.
 * Imports and tests can pass a fixed allocator. Code that creates live content
 * should pass the editor's `state.CRDTbinding`.
 */
export interface MathStructuredProjectionOptions {
  readonly identityAllocator?: IdentityAllocator;
  /**
   * Whether the formula is the block's whole content or sits inside text.
   *
   * Use `"block"` (the default) for an equation on its own line. The stored
   * formula is then marked as the block's content. Use `"supplemental"` for an
   * inline formula, which is held in the text by one placeholder character.
   * Nothing is stored for `"supplemental"`.
   */
  readonly authority?: "block" | "supplemental";
}

/** Options for initializing one structured document from LaTeX source. */
export interface ParseMathInitOptions extends MathStructuredProjectionOptions {
  /** Stable attachment id. It also becomes the structured root node id. */
  readonly contentId?: string;
}

/**
 * The single edit that creates a formula's whole structured document in one
 * step. {@link parseMathDocumentInit} builds one from LaTeX source.
 */
export type MathDocumentInitMutation = Extract<
  StructuredMutation,
  { readonly kind: "document_init" }
>;

/**
 * Converts a `MathDocument` into the structured form the editor stores. Throws
 * if the document cannot be converted.
 *
 * Without `identityAllocator`, ids come from a fixed allocator based on the
 * root id, so the same input gives the same ids.
 */
export function mathDocumentToStructured(
  value: MathDocument,
  options: MathStructuredProjectionOptions = {},
): StructuredDocument {
  const identities =
    options.identityAllocator ??
    createDeterministicIdentityAllocator(
      `math-text/${encodeURIComponent(value.root.id)}`,
    );
  const builder = new MathStructuredBuilder(
    identities,
    options.authority ?? "block",
  );
  const document = builder.build(value);
  const validated = validateStructuredDocument(document);
  if (!validated || !projectValidatedMathDocument(validated)) {
    throw new Error(
      "MathDocument could not be projected to structured content",
    );
  }
  return validated;
}

/**
 * Converts a stored structured equation back into a `MathDocument`.
 *
 * Returns `undefined` when the data is not a valid math equation. In that case
 * keep the stored data and show a placeholder, so nothing is lost.
 */
export function structuredToMathDocument(
  value: StructuredDocument,
): MathDocument | undefined {
  const validated = validateStructuredDocument(value);
  return validated ? projectValidatedMathDocument(validated) : undefined;
}

/**
 * Checks that a structured document is a valid math equation. Returns a checked
 * copy of it, or `undefined` when it is not valid.
 */
export function validateStructuredMathDocument(
  value: StructuredDocument,
): StructuredDocument | undefined {
  const validated = validateStructuredDocument(value);
  if (!validated || !projectValidatedMathDocument(validated)) return undefined;
  return validated;
}

/**
 * Parses LaTeX into the single edit that creates a formula's structured
 * document. `contentId` also becomes the formula's root id.
 *
 * When you create live content, pass the editor's `state.CRDTbinding` as
 * `identityAllocator`. Without one, ids come from a fixed allocator based on
 * `contentId`, which suits imports and tests. Throws if the parsed formula
 * cannot be converted.
 */
// Attachments are created by exactly one peer (the one typing or importing), so
// no cross-peer identity convergence is needed.
export function parseMathDocumentInit(
  latex: string,
  options: ParseMathInitOptions = {},
): MathDocumentInitMutation {
  const identities =
    options.identityAllocator ??
    createDeterministicIdentityAllocator(
      `math-import/${encodeURIComponent(options.contentId ?? "standalone")}`,
    );
  const math = parseMathDocument(latex, {
    identityAllocator: identities,
    rootId: options.contentId,
  });
  return {
    kind: "document_init",
    document: mathDocumentToStructured(math, {
      identityAllocator: identities,
      authority: options.authority,
    }),
  };
}

type TextValues = Readonly<Record<string, string>>;

class MathStructuredBuilder {
  private readonly nodes: Record<string, StructuredNode> = {};
  private readonly nodeIds = new Set<string>();
  private readonly charIds = new Set<string>();
  private readonly identities: IdentityAllocator;
  private readonly authority: "block" | "supplemental";

  constructor(
    identities: IdentityAllocator,
    authority: "block" | "supplemental",
  ) {
    this.identities = identities;
    this.authority = authority;
  }

  build(value: MathDocument): StructuredDocument {
    if (value.version !== 1 || value.root.type !== "root") {
      throw new Error("Unsupported MathDocument version or root");
    }
    this.addNode(
      value.root.id,
      "root",
      { parentId: null, slot: "", orderKey: "" },
      {},
      {},
    );
    this.addRows(value.root.id, "body", [value.root.body]);
    return {
      version: 1,
      kind: MATH_STRUCTURED_KIND,
      ...(this.authority === "block" ? { authority: "block" as const } : {}),
      rootId: value.root.id,
      nodes: this.nodes,
    };
  }

  private addRows(
    parentId: string,
    slot: string,
    rows: readonly MathRow[],
  ): void {
    this.addOrdered(parentId, slot, rows, (row, placement) => {
      if (row.type !== "row") throw new Error("Expected a math row");
      this.addNode(row.id, "row", placement, {}, {});
      this.addOrdered(row.id, "children", row.children, (node, childPlace) =>
        this.addMathNode(node, childPlace),
      );
    });
  }

  private addMathNode(node: MathNode, placement: StructuredPlacement): void {
    switch (node.type) {
      case "raw-text":
        this.addNode(node.id, node.type, placement, {}, { text: node.text });
        return;
      case "symbol":
        this.addNode(
          node.id,
          node.type,
          placement,
          {
            symbolClass: node.symbolClass,
            commandPresent: node.command !== undefined,
          },
          {
            value: node.value,
            ...(node.command === undefined ? {} : { command: node.command }),
          },
        );
        return;
      case "fraction":
        this.addNode(
          node.id,
          node.type,
          placement,
          {
            bar: node.bar,
            style: node.style,
            continued: node.continued,
            leftDelimiterPresent: node.leftDelimiter !== null,
            rightDelimiterPresent: node.rightDelimiter !== null,
          },
          {
            ...(node.leftDelimiter === null
              ? {}
              : { leftDelimiter: node.leftDelimiter }),
            ...(node.rightDelimiter === null
              ? {}
              : { rightDelimiter: node.rightDelimiter }),
          },
        );
        this.addRows(node.id, "numerator", [node.numerator]);
        this.addRows(node.id, "denominator", [node.denominator]);
        return;
      case "radical":
        this.addNode(node.id, node.type, placement, {}, {});
        this.addRows(node.id, "index", node.index ? [node.index] : []);
        this.addRows(node.id, "radicand", [node.radicand]);
        return;
      case "scripts":
        this.addNode(node.id, node.type, placement, {}, {});
        this.addRows(node.id, "base", [node.base]);
        this.addRows(
          node.id,
          "superscript",
          node.superscript ? [node.superscript] : [],
        );
        this.addRows(
          node.id,
          "subscript",
          node.subscript ? [node.subscript] : [],
        );
        return;
      case "accent":
        this.addNode(
          node.id,
          node.type,
          placement,
          {},
          { command: node.command },
        );
        this.addRows(node.id, "base", [node.base]);
        return;
      case "wrapper":
        this.addNode(
          node.id,
          node.type,
          placement,
          {},
          { command: node.command },
        );
        this.addRows(node.id, "body", [node.body]);
        return;
      case "stack":
        this.addNode(
          node.id,
          node.type,
          placement,
          {},
          { command: node.command },
        );
        this.addRows(node.id, "script", [node.script]);
        this.addRows(node.id, "base", [node.base]);
        return;
      case "delimited":
        this.addNode(
          node.id,
          node.type,
          placement,
          {},
          { left: node.left, right: node.right },
        );
        this.addRows(node.id, "body", [node.body]);
        return;
      case "matrix":
        this.addNode(
          node.id,
          node.type,
          placement,
          { columnAlignment: node.columnAlignment },
          { environment: node.environment },
        );
        this.addOrdered(node.id, "rows", node.rows, (row, rowPlacement) =>
          this.addMatrixRow(row, rowPlacement),
        );
        return;
      case "text":
        this.addNode(
          node.id,
          node.type,
          placement,
          { variant: node.variant },
          { text: node.text },
        );
        return;
      case "operator":
        this.addNode(
          node.id,
          node.type,
          placement,
          { limits: node.limits },
          { name: node.name },
        );
        return;
      case "raw-latex":
        this.addNode(node.id, node.type, placement, {}, { latex: node.latex });
        return;
    }
  }

  private addMatrixRow(
    row: MathMatrixRow,
    placement: StructuredPlacement,
  ): void {
    if (row.type !== "matrix-row") throw new Error("Expected a matrix row");
    this.addNode(row.id, row.type, placement, {}, {});
    this.addOrdered(row.id, "cells", row.cells, (cell, cellPlacement) =>
      this.addMatrixCell(cell, cellPlacement),
    );
  }

  private addMatrixCell(
    cell: MathMatrixCell,
    placement: StructuredPlacement,
  ): void {
    if (cell.type !== "matrix-cell") throw new Error("Expected a matrix cell");
    this.addNode(cell.id, cell.type, placement, {}, {});
    this.addRows(cell.id, "body", [cell.body]);
  }

  private addOrdered<T>(
    parentId: string,
    slot: string,
    values: readonly T[],
    add: (value: T, placement: StructuredPlacement) => void,
  ): void {
    const keys = generateNKeysBetween(null, null, values.length);
    values.forEach((value, index) =>
      add(value, { parentId, slot, orderKey: keys[index] }),
    );
  }

  private addNode(
    id: string,
    type: string,
    placement: StructuredPlacement,
    attrs: Readonly<Record<string, StructuredValue>>,
    textValues: TextValues,
  ): void {
    if (id.length === 0 || this.nodeIds.has(id) || this.charIds.has(id)) {
      throw new Error(`Duplicate or empty math identity: ${id}`);
    }
    this.nodeIds.add(id);
    const textFields: Record<string, readonly CharRun[]> = {};
    for (const [field, text] of Object.entries(textValues)) {
      textFields[field] = this.textRuns(text);
    }
    this.nodes[id] = { id, type, placement, attrs, textFields };
  }

  private textRuns(text: string): CharRun[] {
    if (typeof text !== "string") throw new Error("Math text must be a string");
    const chars: Char[] = [];
    for (let offset = 0; offset < text.length; offset++) {
      const char = text[offset];
      const id = this.identities.nextId();
      assertCompoundCharId(id);
      this.recordCharId(id);
      chars.push({ id, char });
    }
    return charsToRuns(chars);
  }

  private recordCharId(id: string): void {
    if (this.charIds.has(id) || this.nodeIds.has(id)) {
      throw new Error(`Duplicate math character identity: ${id}`);
    }
    this.charIds.add(id);
  }
}

class MathStructuredProjector {
  private readonly visited = new Set<string>();
  private readonly document: StructuredDocument;

  constructor(document: StructuredDocument) {
    this.document = document;
  }

  project(): MathDocument {
    if (this.document.kind !== MATH_STRUCTURED_KIND) {
      throw new Error("Not a structured math document");
    }
    const root = this.requireNode(this.document.rootId, "root", [], []);
    const body = this.row(this.onlyChild(root.id, "body"));
    this.assertNoVisibleExtras();
    return {
      version: 1,
      root: { type: "root", id: root.id, body },
    };
  }

  private row(node: StructuredNode): MathRow {
    this.requireShape(node, "row", [], []);
    return {
      type: "row",
      id: node.id,
      children: getStructuredChildren(this.document, node.id, "children").map(
        (child) => this.mathNode(child),
      ),
    };
  }

  private mathNode(node: StructuredNode): MathNode {
    switch (node.type) {
      case "raw-text":
        this.requireShape(node, node.type, [], ["text"]);
        return { type: node.type, id: node.id, text: this.text(node, "text") };
      case "symbol": {
        const commandPresent = this.booleanAttr(node, "commandPresent");
        this.requireShape(
          node,
          node.type,
          ["commandPresent", "symbolClass"],
          commandPresent ? ["command", "value"] : ["value"],
        );
        const symbolClass = this.enumAttr(node, "symbolClass", SYMBOL_CLASSES);
        return {
          type: node.type,
          id: node.id,
          value: this.text(node, "value"),
          ...(commandPresent ? { command: this.text(node, "command") } : {}),
          symbolClass,
        };
      }
      case "fraction": {
        const leftPresent = this.booleanAttr(node, "leftDelimiterPresent");
        const rightPresent = this.booleanAttr(node, "rightDelimiterPresent");
        this.requireShape(
          node,
          node.type,
          [
            "bar",
            "continued",
            "leftDelimiterPresent",
            "rightDelimiterPresent",
            "style",
          ],
          [
            ...(leftPresent ? ["leftDelimiter"] : []),
            ...(rightPresent ? ["rightDelimiter"] : []),
          ],
        );
        return {
          type: node.type,
          id: node.id,
          numerator: this.row(this.onlyChild(node.id, "numerator")),
          denominator: this.row(this.onlyChild(node.id, "denominator")),
          bar: this.enumAttr(node, "bar", FRACTION_BARS),
          style: this.enumAttr(node, "style", FRACTION_STYLES),
          continued: this.booleanAttr(node, "continued"),
          leftDelimiter: leftPresent ? this.text(node, "leftDelimiter") : null,
          rightDelimiter: rightPresent
            ? this.text(node, "rightDelimiter")
            : null,
        };
      }
      case "radical":
        this.requireShape(node, node.type, [], []);
        return {
          type: node.type,
          id: node.id,
          index: this.optionalRow(node.id, "index"),
          radicand: this.row(this.onlyChild(node.id, "radicand")),
        };
      case "scripts":
        this.requireShape(node, node.type, [], []);
        return {
          type: node.type,
          id: node.id,
          base: this.row(this.onlyChild(node.id, "base")),
          superscript: this.optionalRow(node.id, "superscript"),
          subscript: this.optionalRow(node.id, "subscript"),
        };
      case "accent": {
        this.requireShape(node, node.type, [], ["command"]);
        const command = this.text(node, "command");
        // An unknown command would print as a red unknown control word and
        // could re-lex against its own braces; refuse the tree instead, so the
        // attachment falls back to its authoritative source.
        if (!isAccentCommand(command)) {
          throw new Error(`Unsupported math accent: ${command}`);
        }
        return {
          type: node.type,
          id: node.id,
          command,
          base: this.row(this.onlyChild(node.id, "base")),
        };
      }
      case "wrapper": {
        this.requireShape(node, node.type, [], ["command"]);
        const command = this.text(node, "command");
        if (!isWrapperCommand(command)) {
          throw new Error(`Unsupported math wrapper: ${command}`);
        }
        return {
          type: node.type,
          id: node.id,
          command,
          body: this.row(this.onlyChild(node.id, "body")),
        };
      }
      case "stack": {
        this.requireShape(node, node.type, [], ["command"]);
        const command = this.text(node, "command");
        if (!isStackCommand(command)) {
          throw new Error(`Unsupported math stack: ${command}`);
        }
        return {
          type: node.type,
          id: node.id,
          command,
          script: this.row(this.onlyChild(node.id, "script")),
          base: this.row(this.onlyChild(node.id, "base")),
        };
      }
      case "delimited":
        this.requireShape(node, node.type, [], ["left", "right"]);
        return {
          type: node.type,
          id: node.id,
          left: this.text(node, "left"),
          right: this.text(node, "right"),
          body: this.row(this.onlyChild(node.id, "body")),
        };
      case "matrix": {
        this.requireShape(
          node,
          node.type,
          ["columnAlignment"],
          ["environment"],
        );
        const alignment = node.attrs.columnAlignment;
        if (
          alignment !== null &&
          (!Array.isArray(alignment) ||
            !alignment.every(
              (entry) => entry === "l" || entry === "c" || entry === "r",
            ))
        ) {
          throw new Error("Invalid matrix alignment");
        }
        return {
          type: node.type,
          id: node.id,
          environment: this.text(node, "environment"),
          columnAlignment: alignment === null ? null : [...alignment],
          rows: getStructuredChildren(this.document, node.id, "rows").map(
            (row) => this.matrixRow(row),
          ),
        };
      }
      case "text":
        this.requireShape(node, node.type, ["variant"], ["text"]);
        return {
          type: node.type,
          id: node.id,
          text: this.text(node, "text"),
          variant: this.enumAttr(node, "variant", TEXT_VARIANTS),
        };
      case "operator":
        this.requireShape(node, node.type, ["limits"], ["name"]);
        return {
          type: node.type,
          id: node.id,
          name: this.text(node, "name"),
          limits: this.booleanAttr(node, "limits"),
        };
      case "raw-latex":
        this.requireShape(node, node.type, [], ["latex"]);
        return {
          type: node.type,
          id: node.id,
          latex: this.text(node, "latex"),
        };
      default:
        throw new Error(`Unsupported structured math node: ${node.type}`);
    }
  }

  private matrixRow(node: StructuredNode): MathMatrixRow {
    this.requireShape(node, "matrix-row", [], []);
    return {
      type: "matrix-row",
      id: node.id,
      cells: getStructuredChildren(this.document, node.id, "cells").map(
        (cell) => this.matrixCell(cell),
      ),
    };
  }

  private matrixCell(node: StructuredNode): MathMatrixCell {
    this.requireShape(node, "matrix-cell", [], []);
    return {
      type: "matrix-cell",
      id: node.id,
      body: this.row(this.onlyChild(node.id, "body")),
    };
  }

  private optionalRow(parentId: string, slot: string): MathRow | null {
    const children = getStructuredChildren(this.document, parentId, slot);
    if (children.length > 1) throw new Error(`Expected at most one ${slot}`);
    return children[0] ? this.row(children[0]) : null;
  }

  private onlyChild(parentId: string, slot: string): StructuredNode {
    const children = getStructuredChildren(this.document, parentId, slot);
    if (children.length !== 1) throw new Error(`Expected exactly one ${slot}`);
    return children[0];
  }

  private requireNode(
    id: string,
    type: string,
    attrs: readonly string[],
    fields: readonly string[],
  ): StructuredNode {
    const node = this.document.nodes[id];
    if (!node || node.deleted) throw new Error(`Missing math node: ${id}`);
    this.requireShape(node, type, attrs, fields);
    return node;
  }

  private requireShape(
    node: StructuredNode,
    type: string,
    attrs: readonly string[],
    fields: readonly string[],
  ): void {
    if (node.type !== type || this.visited.has(node.id)) {
      throw new Error(`Invalid or repeated math node: ${node.id}`);
    }
    const actualAttrs = Object.keys(node.attrs).sort();
    const actualFields = Object.keys(node.textFields).sort();
    if (
      !sameStrings(actualAttrs, [...attrs].sort()) ||
      !sameStrings(actualFields, [...fields].sort())
    ) {
      throw new Error(`Invalid math node fields: ${node.id}`);
    }
    this.visited.add(node.id);
  }

  private text(node: StructuredNode, field: string): string {
    if (!Object.prototype.hasOwnProperty.call(node.textFields, field)) {
      throw new Error(`Missing math text field: ${node.id}.${field}`);
    }
    return getStructuredText(this.document, node.id, field);
  }

  private booleanAttr(node: StructuredNode, key: string): boolean {
    const value = node.attrs[key];
    if (typeof value !== "boolean") throw new Error(`Invalid boolean ${key}`);
    return value;
  }

  private enumAttr<const T extends string>(
    node: StructuredNode,
    key: string,
    allowed: readonly T[],
  ): T {
    const value = node.attrs[key];
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      throw new Error(`Invalid enum ${key}`);
    }
    return value as T;
  }

  private assertNoVisibleExtras(): void {
    for (const node of Object.values(this.document.nodes)) {
      if (node.deleted || this.visited.has(node.id)) continue;
      if (this.isUnreachable(node)) continue;
      throw new Error(`Unprojected visible math node: ${node.id}`);
    }
  }

  /**
   * A subtree under a deleted ancestor is hidden; a subtree whose ancestor
   * chain hits a missing identity is an orphan the reducer retains without
   * surfacing (e.g. an edit built against a `document_init` that lost the
   * first-writer-wins race). Neither reaches the printed equation, so neither
   * may fail projection.
   */
  private isUnreachable(node: StructuredNode): boolean {
    const seen = new Set<string>();
    let parentId = node.placement.parentId;
    while (parentId !== null) {
      if (seen.has(parentId)) return false;
      seen.add(parentId);
      const parent = this.document.nodes[parentId];
      if (!parent || parent.deleted) return true;
      parentId = parent.placement.parentId;
    }
    return false;
  }
}

function projectValidatedMathDocument(
  document: StructuredDocument,
): MathDocument | undefined {
  try {
    return new MathStructuredProjector(document).project();
  } catch {
    return undefined;
  }
}

function assertCompoundCharId(id: string): void {
  if (!parseAllocatedIdentity(id)) {
    throw new Error(`Invalid math character identity: ${id}`);
  }
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

const SYMBOL_CLASSES = [
  "mathord",
  "textord",
  "bin",
  "rel",
  "open",
  "close",
  "punct",
  "inner",
  "op",
  "accent",
  "spacing",
] as const;
const FRACTION_BARS = ["rule", "none"] as const;
const FRACTION_STYLES = ["auto", "display", "text"] as const;
const TEXT_VARIANTS = [
  "normal",
  "bold",
  "italic",
  "monospace",
  "sans-serif",
] as const;
