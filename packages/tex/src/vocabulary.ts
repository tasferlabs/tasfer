/**
 * The engine's renderable command vocabulary, exposed so hosts can make it
 * discoverable (autocomplete, symbol pickers) without shipping their own copy
 * of what the renderer supports. Two tiers:
 *
 * - {@link symbolCommands} — control words that resolve to a single glyph
 *   (`\degree` → °, `\aleph` → ℵ). Accent and spacing control words are
 *   excluded: accents are constructs that take a base (`\hat{x}`) and spacing
 *   draws nothing to preview.
 * - {@link operatorCommands} — named operators (`\arcsin`, `\liminf`) that
 *   render as their own upright name; `limits` says whether scripts stack
 *   above/below in display style (so a picker can offer a `_{}` slot).
 *
 * Constructs that take arguments (fractions, roots, matrices, accents) are not
 * listed — a picker needs its own template with `{}` slots to insert those
 * usefully.
 */
import { mathSymbols } from "./data/symbols";
import { MATH_OPERATORS } from "./parse/parser";

export interface SymbolCommand {
  /** Command word without the backslash, e.g. `degree`. */
  readonly name: string;
  /** The glyph the command renders, e.g. `°`. */
  readonly char: string;
}

export interface OperatorCommand {
  /** Command word without the backslash, e.g. `liminf`. */
  readonly name: string;
  /** Whether scripts stack above/below in display style (`\lim`-like). */
  readonly limits: boolean;
}

export const symbolCommands: readonly SymbolCommand[] = Object.entries(
  mathSymbols,
)
  .filter(
    ([key, info]) =>
      /^\\[a-zA-Z]+$/.test(key) &&
      info.group !== "accent" &&
      info.group !== "spacing",
  )
  .map(([key, info]) => ({ name: key.slice(1), char: info.char }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));

export const operatorCommands: readonly OperatorCommand[] = Object.entries(
  MATH_OPERATORS,
)
  .map(([name, limits]) => ({ name, limits }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));
