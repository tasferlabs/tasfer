/**
 * Stable, editable representation of a formula.
 *
 * Unlike the rendering AST in `parse/ast.ts`, this tree has no source offsets
 * and every identity-bearing value has an id. Hosts can therefore keep a
 * selection anchored to a row/cell/node while its siblings change. The ids are
 * scoped to one {@link MathDocument}; callers that replicate the tree should
 * supply the identity allocator owned by their document/CRDT.
 */

/** Stable identity of an item in a {@link MathDocument}. */
export type MathItemId = string;

/** Versioned top-level value persisted by a host. */
export interface MathDocument {
  readonly version: 1;
  readonly root: MathRoot;
}

/** A formula root. Kept distinct from rows so future root metadata is additive. */
export interface MathRoot {
  readonly type: "root";
  readonly id: MathItemId;
  readonly body: MathRow;
}

/** An ordered, always-present editing slot. Empty rows are valid caret targets. */
export interface MathRow {
  readonly type: "row";
  readonly id: MathItemId;
  readonly children: readonly MathNode[];
}

/** Plain math-mode source that can be edited as a character run. */
export interface MathRawText {
  readonly type: "raw-text";
  readonly id: MathItemId;
  readonly text: string;
}

/** The spacing class carried by a named or otherwise atomic symbol. */
export type MathSymbolClass =
  | "mathord"
  | "textord"
  | "bin"
  | "rel"
  | "open"
  | "close"
  | "punct"
  | "inner"
  | "op"
  | "accent"
  | "spacing";

/**
 * An atomic symbol. `command` excludes the leading backslash; when absent,
 * `value` is printed literally.
 */
export interface MathSymbol {
  readonly type: "symbol";
  readonly id: MathItemId;
  readonly value: string;
  readonly command?: string;
  readonly symbolClass: MathSymbolClass;
}

/** A generalized fraction with persistent numerator and denominator slots. */
export interface MathFraction {
  readonly type: "fraction";
  readonly id: MathItemId;
  readonly numerator: MathRow;
  readonly denominator: MathRow;
  readonly bar: "rule" | "none";
  readonly style: "auto" | "display" | "text";
  readonly continued: boolean;
  readonly leftDelimiter: string | null;
  readonly rightDelimiter: string | null;
}

/** A square root, optionally with an index slot. */
export interface MathRadical {
  readonly type: "radical";
  readonly id: MathItemId;
  readonly index: MathRow | null;
  readonly radicand: MathRow;
}

/** A base with persistent optional super- and subscript slots. */
export interface MathScripts {
  readonly type: "scripts";
  readonly id: MathItemId;
  readonly base: MathRow;
  readonly superscript: MathRow | null;
  readonly subscript: MathRow | null;
}

/** A body surrounded by automatically sized delimiters. */
export interface MathDelimited {
  readonly type: "delimited";
  readonly id: MathItemId;
  readonly left: string;
  readonly right: string;
  readonly body: MathRow;
}

/** One identity-bearing row inside a matrix-like environment. */
export interface MathMatrixRow {
  readonly type: "matrix-row";
  readonly id: MathItemId;
  readonly cells: readonly MathMatrixCell[];
}

/** One identity-bearing matrix cell. Its body remains present when empty. */
export interface MathMatrixCell {
  readonly type: "matrix-cell";
  readonly id: MathItemId;
  readonly body: MathRow;
}

/** A matrix/array environment with structural rows and cells. */
export interface MathMatrix {
  readonly type: "matrix";
  readonly id: MathItemId;
  readonly environment: string;
  readonly columnAlignment: readonly ("l" | "c" | "r")[] | null;
  readonly rows: readonly MathMatrixRow[];
}

/** Canonical editable variants supported by a `\\text*` construct. */
export type MathTextVariant =
  | "normal"
  | "bold"
  | "italic"
  | "monospace"
  | "sans-serif";

/** Literal prose in a math formula (`\\text`, `\\textbf`, …). */
export interface MathText {
  readonly type: "text";
  readonly id: MathItemId;
  readonly text: string;
  readonly variant: MathTextVariant;
}

/** A named math operator, optionally taking display-style limits. */
export interface MathOperator {
  readonly type: "operator";
  readonly id: MathItemId;
  readonly name: string;
  readonly limits: boolean;
}

/**
 * Exact source for a construct the semantic projection does not understand.
 * Keeping it as a leaf makes import forward-compatible and lossless for that
 * subtree; installing support later can replace it with structured nodes.
 * Editors must treat this leaf atomically: `latex` is interchange payload, not
 * an ordinary character-editing field where half a command may be removed.
 */
export interface MathRawLatex {
  readonly type: "raw-latex";
  readonly id: MathItemId;
  readonly latex: string;
}

export type MathNode =
  | MathRawText
  | MathSymbol
  | MathFraction
  | MathRadical
  | MathScripts
  | MathDelimited
  | MathMatrix
  | MathText
  | MathOperator
  | MathRawLatex;
