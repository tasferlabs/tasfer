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
import {
  ACCENTS,
  MATH_FONTS,
  MATH_OPERATORS,
  MCLASS_FORMS,
  OVER_UNDER,
  PHANTOM_FORMS,
  STRETCHY_ACCENTS,
} from "./parse/parser";

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

/**
 * Accent control words (`hat`, `vec`, `widehat`) without the backslash. Unlike
 * the two tiers above these DO take a base, so they are listed separately: a
 * host inserting one needs a `{}` slot, and the structured document model
 * validates a stored accent command against this vocabulary.
 */
export const accentCommands: readonly string[] = [...ACCENTS].sort();

/** Whether `name` (no backslash) is an accent that takes a base. */
export function isAccentCommand(name: string): boolean {
  return ACCENTS.has(name);
}

/** Whether `name` is an accent whose glyph stretches over the whole base. */
export function isStretchyAccentCommand(name: string): boolean {
  return STRETCHY_ACCENTS.has(name);
}

/**
 * Control words taking exactly one braced body: over/under rules, frames,
 * fonts and alphabets, atom-class overrides, phantoms, and `\not`. Like the
 * accents these are constructs, not glyphs — a host inserting one needs a `{}`
 * slot, and the structured model validates a stored command against this list.
 */
export const wrapperCommands: readonly string[] = [
  ...OVER_UNDER,
  ...Object.keys(MATH_FONTS),
  ...Object.keys(MCLASS_FORMS),
  // `\smash` is excluded: its optional `[t]`/`[b]` argument is not part of the
  // one-body shape, so storing it as a wrapper would drop the option on the
  // next print. It stays an exact source leaf.
  ...Object.keys(PHANTOM_FORMS).filter((name) => name !== "smash"),
  "boxed",
  "fbox",
  "not",
].sort();

const WRAPPERS = new Set(wrapperCommands);

/** Whether `name` (no backslash) wraps exactly one braced body. */
export function isWrapperCommand(name: string): boolean {
  return WRAPPERS.has(name);
}

/** Control words stacking a script over/under a base: two braced slots. */
export const stackCommands: readonly string[] = [
  "overset",
  "stackrel",
  "underset",
];

const STACKS = new Set(stackCommands);

/** Whether `name` (no backslash) stacks a script over/under a base. */
export function isStackCommand(name: string): boolean {
  return STACKS.has(name);
}
