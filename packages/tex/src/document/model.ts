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

/**
 * A whole formula, in the form a host saves. `version` is always `1` for now.
 */
export interface MathDocument {
  readonly version: 1;
  readonly root: MathRoot;
}

/** The top of a formula. Its `body` row holds the formula's content. */
export interface MathRoot {
  readonly type: "root";
  readonly id: MathItemId;
  readonly body: MathRow;
}

/**
 * An ordered list of formula pieces, like a fraction's top or a superscript. A
 * row can be empty, and the caret can still go in it.
 */
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

/**
 * An accent over a base (`\hat{x}`, `\vec{v}`, `\widehat{ab}`). `command` has
 * no leading backslash. Whether the accent stretches comes from the command, so
 * it is not stored.
 */
export interface MathAccent {
  readonly type: "accent";
  readonly id: MathItemId;
  readonly command: string;
  readonly base: MathRow;
}

/**
 * A command around one editable body: a line over or under it (`\overline{x}`),
 * a frame (`\boxed{y}`), a font (`\mathbb{R}`), a spacing-class change
 * (`\mathbin{…}`), a phantom, or `\not`. Only the command and its body are
 * stored. What it draws comes from the command. Unlike an accent, the body is
 * ordinary formula content, not a base being decorated.
 */
export interface MathWrapper {
  readonly type: "wrapper";
  readonly id: MathItemId;
  readonly command: string;
  readonly body: MathRow;
}

/**
 * `\overset` / `\underset` / `\stackrel` — a script stacked over or under a
 * base. Both slots are persistent and editable, in source order.
 */
export interface MathStack {
  readonly type: "stack";
  readonly id: MathItemId;
  readonly command: string;
  readonly script: MathRow;
  readonly base: MathRow;
}

/** A body surrounded by automatically sized delimiters. */
export interface MathDelimited {
  readonly type: "delimited";
  readonly id: MathItemId;
  readonly left: string;
  readonly right: string;
  readonly body: MathRow;
}

/** One row of a matrix, with its own id. */
export interface MathMatrixRow {
  readonly type: "matrix-row";
  readonly id: MathItemId;
  readonly cells: readonly MathMatrixCell[];
}

/**
 * One matrix cell, with its own id. Its `body` row is always there, even when
 * the cell is empty.
 */
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

/**
 * The styles a `\text`-family command can have, such as `\textbf` for `"bold"`.
 */
export type MathTextVariant =
  | "normal"
  | "bold"
  | "italic"
  | "monospace"
  | "sans-serif";

/**
 * Plain words inside a formula, written with `\text`, `\textbf` and similar
 * commands. `variant` says which one.
 */
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
 * LaTeX the formula model does not understand, kept exactly as written so
 * nothing is lost. A later version that understands it can turn it into real
 * nodes. Edit it as one piece. Never delete part of `latex`, or you can leave
 * half a command behind.
 */
export interface MathRawLatex {
  readonly type: "raw-latex";
  readonly id: MathItemId;
  readonly latex: string;
}

/**
 * Any one piece of a formula in a {@link MathDocument}: a symbol, a fraction, a
 * square root, a matrix, and so on. Check `type` to tell which one it is. The
 * math package (`@tasfer/math`) also exports this type as `MathDocumentNode`,
 * to keep it apart from its own `MathNode` block class.
 */
export type MathNode =
  | MathRawText
  | MathSymbol
  | MathFraction
  | MathRadical
  | MathScripts
  | MathAccent
  | MathWrapper
  | MathStack
  | MathDelimited
  | MathMatrix
  | MathText
  | MathOperator
  | MathRawLatex;
