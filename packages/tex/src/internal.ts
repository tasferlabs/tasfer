/**
 * @cypherkit/tex/internal — UNSTABLE internal surface.
 *
 * Everything re-exported here is engine machinery — the laid-out box tree and
 * the parse AST — that a host wiring its own math chrome may occasionally need,
 * but which is **NOT a public contract**. It carries no semver guarantee:
 * symbols may be renamed, reshaped, or removed in any release. External
 * consumers should depend only on the package root (`@cypherkit/tex`), whose
 * surface deals in `latex` strings and the opaque `MathLayout` handle.
 *
 * Mirrors `@cypherkit/editor/internal`: the root is the curated contract, this
 * entry is the explicitly-unstable escape hatch (reachable through the package's
 * `./*` subpath exports). New entries here are a smell — prefer promoting a
 * stable, curated API to the root over widening this surface.
 */

// ── Layout box tree ──────────────────────────────────────────────────────────
// The internal representation `layoutMath` produces and `paintMath`/the caret
// helpers consume. The root exposes it only as the opaque `MathLayout.box`
// handle — these names let a host that walks the tree itself spell its parts.
export type {
  Box,
  GlyphBox,
  ListBox,
  PlaceholderBox,
  RuleBox,
} from "./layout/box";

// ── Parse AST ────────────────────────────────────────────────────────────────
// `parse` turns LaTeX into this `Node`/`Span` tree. It has no stable shape (the
// node union grows with every supported command), so it lives here rather than
// at the root. The root's `isValidLatex` is the curated "does this parse" signal
// built on top of it.
export type { Node, Span } from "./parse/ast";
export type { ParseOptions } from "./parse/parser";
export { parse } from "./parse/parser";
