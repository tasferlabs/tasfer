/**
 * Materialize incomplete constructs into their canonical placeholder form —
 * `\frac` → `\frac{}{}`, `\sqrt` → `\sqrt{}`, `x^` → `x^{}`, … — WITHOUT changing
 * what the formula renders to.
 *
 * Why this exists: the live caret is a single source offset into the LaTeX
 * string (see {@link caretStops}). A construct written without its brace groups
 * has no source text between its slots, so every empty slot collapses to the
 * SAME zero-length offset — the parser materializes a missing argument as an
 * empty `ord` whose span is zero-length ({@link parseArg}). With no distinct
 * offset per slot the caret can't sit *in* a slot, and left/right/up navigation
 * has nowhere to land. Inserting the literal `{}` braces gives each slot a real,
 * distinct source position, at which point the existing empty-slot caret stops
 * (faint placeholder boxes) just work.
 *
 * This is a pure string→string transform plus the insertions needed to get
 * there (so a host can apply them as real edits and keep a CRDT log consistent)
 * and a caret remap that lands the caret *inside* the first slot it fills — the
 * "type `\frac`, land in the numerator" completion behavior the `\` command menu
 * already gives for its braced entries. Idempotent: a fully-braced formula
 * (`\frac{}{}`) is returned unchanged.
 */
import type { Node } from "../parse/ast.ts";
import { parse } from "../parse/parser.ts";

/** A single placeholder insertion: `text` to splice in at source index `at`. */
export interface LatexInsert {
  /** Index into the ORIGINAL LaTeX string at which to insert. */
  readonly at: number;
  /** The text to insert (always a run of empty `{}` slots). */
  readonly text: string;
}

export interface LatexNormalization {
  /** The fully-materialized LaTeX (every construct slot has its braces). */
  readonly latex: string;
  /**
   * The insertions, by ascending source index, that turn the original into
   * {@link latex}. Each `at` is an offset into the ORIGINAL string — a host
   * applies them right-to-left (or accounts for the shift) to keep indices
   * valid. Empty when nothing needed filling.
   */
  readonly inserts: readonly LatexInsert[];
  /** Whether anything changed (i.e. `inserts.length > 0`). */
  readonly changed: boolean;
  /**
   * Map a caret offset in the ORIGINAL string to its position in {@link latex}.
   * A caret that sat exactly where a slot was filled lands *inside* that slot's
   * first brace pair, so completing `\frac` drops the caret in the numerator.
   */
  mapCaret(offset: number): number;
}

/** An empty argument slot the parser synthesized for a missing brace group:
 * an `ord` with no body and a zero-length span (so it carries no source text). */
function isEmptySlot(node: Node): boolean {
  return (
    node.type === "ord" &&
    node.body.length === 0 &&
    node.span.start === node.span.end
  );
}

/**
 * A node's child slots, split into the **brace-bearing argument slots** (which
 * must be `{}` when empty — a fraction's numerator, a script, an accent's base)
 * and the **structural children** that are recursed for nested constructs but
 * never themselves braced (a super/subscript's base, a group/array body). This
 * mirrors the parser's own notion of which fields are mandatory `{…}` arguments;
 * any other node type contributes no children.
 */
function children(node: Node): { slots: Node[]; rest: Node[] } {
  const slot = (...ns: (Node | null)[]): Node[] =>
    ns.filter((n): n is Node => n != null);
  switch (node.type) {
    case "frac":
      return { slots: [node.num, node.den], rest: [] };
    case "supsub":
      // The scripts are braced slots; the base is scripted content, not an arg.
      return { slots: slot(node.sup, node.sub), rest: slot(node.base) };
    case "sqrt":
      // The radicand is a braced slot; the optional `[index]` uses brackets.
      return { slots: [node.body], rest: slot(node.index) };
    case "stack":
      return { slots: [node.script, node.base], rest: [] };
    case "accent":
    case "not":
      return { slots: [node.base], rest: [] };
    case "overunder":
    case "mathfont":
    case "mclass":
    case "boxed":
    case "phantom":
      return { slots: [node.body], rest: [] };
    case "ord":
    case "leftright":
    case "style":
      // Group/delimiter bodies aren't single mandatory args — recurse, don't brace.
      return { slots: [], rest: node.body };
    case "array":
      return { slots: [], rest: node.rows.flat() };
    default:
      return { slots: [], rest: [] };
  }
}

/** Collect the source offsets at which an empty argument slot must gain `{}`. */
function collect(node: Node, out: number[]): void {
  const { slots, rest } = children(node);
  for (const s of slots) {
    if (isEmptySlot(s)) out.push(s.span.start);
    else collect(s, out); // a filled slot may itself hold incomplete constructs
  }
  for (const r of rest) collect(r, out);
}

/**
 * Materialize every incomplete construct in `latex` into canonical placeholder
 * form. Pure and idempotent. See {@link LatexNormalization}.
 */
export function normalizeLatex(latex: string): LatexNormalization {
  if (!latex) {
    return { latex, inserts: [], changed: false, mapCaret: (o) => o };
  }

  const offsets: number[] = [];
  collect(parse(latex), offsets);

  if (offsets.length === 0) {
    return { latex, inserts: [], changed: false, mapCaret: (o) => o };
  }

  // Merge slots that share an offset (consecutive empty args, e.g. bare `\frac`'s
  // numerator and denominator both at the command's end) into one `{}{}` insert.
  offsets.sort((a, b) => a - b);
  const inserts: LatexInsert[] = [];
  for (const at of offsets) {
    const last = inserts[inserts.length - 1];
    if (last && last.at === at) {
      inserts[inserts.length - 1] = { at, text: last.text + "{}" };
    } else {
      inserts.push({ at, text: "{}" });
    }
  }

  // Build the normalized string (insertions are by ascending offset).
  let out = "";
  let cursor = 0;
  for (const ins of inserts) {
    out += latex.slice(cursor, ins.at) + ins.text;
    cursor = ins.at;
  }
  out += latex.slice(cursor);

  const mapCaret = (offset: number): number => {
    let shift = 0;
    let landInside = 0;
    for (const ins of inserts) {
      if (ins.at < offset) shift += ins.text.length;
      else if (ins.at === offset) landInside = 1; // step inside the first `{`
    }
    return offset + shift + landInside;
  };

  return { latex: out, inserts, changed: true, mapCaret };
}
