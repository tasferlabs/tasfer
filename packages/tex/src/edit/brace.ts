/**
 * Edit-time rewrite of a typed brace into its escaped, literal form.
 *
 * A raw `{`/`}` in LaTeX source is a GROUPING token: it paints no glyph and
 * silently restructures the formula around the caret — the reader sees nothing
 * where the keystroke landed. A user typing a brace into a live formula almost
 * always means the visible character (set notation `\{1,2\}`), not an invisible
 * group, so a host rewrites the keystroke to the escaped `\{`/`\}` symbol,
 * which typesets as a real brace glyph. Grouping braces still enter the source
 * legitimately — the host's construct materializer inserts them (`\frac` →
 * `\frac{}{}`), and the exceptions below keep raw-LaTeX typing possible.
 */
import { tokenize } from "../parse/lexer";
import type { LatexInsert } from "./normalize";

/**
 * The caret sits flush after a command intro — a `\` + letter run (`\`, `\tex`,
 * `\begin`) ending exactly at `offset`. Excludes the trailing `\` of a
 * row-break `\\`, which introduces no command. Mirrors the back-scan in
 * `needsCommandSeparator`/`pendingCommandRange`.
 */
function afterCommandIntro(latex: string, offset: number): boolean {
  let i = offset;
  while (i > 0 && /[a-zA-Z]/.test(latex[i - 1])) i--;
  return i > 0 && latex[i - 1] === "\\" && latex[i - 2] !== "\\";
}

/**
 * The caret sits flush after a control WORD — a `\` + one or more letters
 * (`\text`, `\begin`, `\sqrt`) ending exactly at `offset`. Unlike {@link
 * afterCommandIntro} this requires at least one letter, so it excludes a lone
 * `\` (whose following `{` is the escaped brace glyph `\{`, not an argument).
 *
 * A `{` typed here opens the command's argument. On its own that raw `{` is left
 * unclosed and the end-of-source brace heal then swallows every trailing atom
 * into the argument (`x+y` + `\text{` → `\text{x+y}`); the host uses this to
 * auto-close the argument at the caret (`\text{}`) instead — see the brace
 * handling in `nodes/math.ts`. Pure over the source string.
 */
export function afterCommandWord(latex: string, offset: number): boolean {
  let i = offset;
  while (i > 0 && /[a-zA-Z]/.test(latex[i - 1])) i--;
  return i < offset && latex[i - 1] === "\\" && latex[i - 2] !== "\\";
}

/**
 * Whether an unclosed `{` group opened before `offset` exists in `latex` — a
 * raw `}` typed at `offset` would close it rather than dangle. Balanced over
 * the WHOLE string so a caret inside an already-closed construct slot
 * (`\frac{12|}{2}`) doesn't mistake the slot's opener for something to close.
 * Lexes rather than scans chars so escaped braces (`\{`) don't count.
 */
function hasOpenGroupBefore(latex: string, offset: number): boolean {
  const open: number[] = [];
  for (const t of tokenize(latex)) {
    if (t.kind === "lbrace") open.push(t.start);
    else if (t.kind === "rbrace") open.pop();
  }
  return open.some((at) => at < offset);
}

/**
 * The escaped form (`\{` / `\}`) a brace typed at `offset` should enter the
 * source as, or `null` when the raw brace is structurally meant there:
 *
 *  - `char` isn't a brace — not this function's keystroke.
 *  - The caret sits right after a command intro: a `\` + `{` is the user typing
 *    the escape itself, and a brace after a control word opens its argument or
 *    delimiter (`\text{`, `\begin{matrix}`, `\left{`).
 *  - A `}` while a raw-opened group is still unclosed (`\text{abc|`) closes
 *    that group.
 *
 * Pure over the source string; the host applies the rewrite before committing
 * the keystroke.
 */
export function escapeTypedBrace(
  latex: string,
  offset: number,
  char: string,
): string | null {
  if (char !== "{" && char !== "}") return null;
  if (afterCommandIntro(latex, offset)) return null;
  if (char === "}" && hasOpenGroupBefore(latex, offset)) return null;
  return "\\" + char;
}

/**
 * Whether a `}` typed at `offset` lands flush before the grouping `}` that closes
 * the group the caret sits in — so the keystroke should STEP OVER that existing
 * closer rather than insert a second (escaped) brace.
 *
 * The construct materializer auto-closes an argument the instant its `{` is typed
 * (`\text{` → `\text{}`, caret between the braces). A user who then types the
 * matching `}` themselves would otherwise get a literal `\}` wedged in
 * (`\text{hi\}}`) — because the group is already balanced, {@link
 * escapeTypedBrace} treats the keystroke as a literal glyph — and the formula
 * renders a stray brace. Stepping over the closer keeps natural `\text{hi}`
 * typing clean, matching the auto-pair behavior of every code editor.
 *
 * True only when the char at `offset` is a grouping `}` (a lexer `rbrace`, so a
 * `\}` glyph never counts) that closes a group still open at the caret. Lexes
 * rather than scanning chars so escaped braces never mislead the depth count.
 * Pure over the source string.
 */
export function typedBraceSkipsCloser(latex: string, offset: number): boolean {
  if (latex[offset] !== "}") return false;
  let depth = 0;
  for (const t of tokenize(latex)) {
    if (t.start >= offset) {
      // The token starting exactly at `offset` must be the grouping `}` we skip;
      // and it can only close something if a group is still open here.
      return t.start === offset && t.kind === "rbrace" && depth > 0;
    }
    if (t.kind === "lbrace") depth++;
    else if (t.kind === "rbrace" && depth > 0) depth--;
  }
  return false;
}

/** The `\begin`/`\end` nesting depth at `offset` — how many tabular (or other)
 *  environments enclose it. `\\` is a row separator only where this is > 0. */
function environmentDepthAt(latex: string, offset: number): number {
  let depth = 0;
  for (const t of tokenize(latex)) {
    if (t.start >= offset) break;
    if (t.kind === "command" && t.value === "begin") depth++;
    else if (t.kind === "command" && t.value === "end" && depth > 0) depth--;
  }
  return depth;
}

/**
 * Whether a bare `\` typed immediately before source `offset` would fuse with the
 * character already there into a single token, silently consuming that
 * character's role.
 *
 * A typed `\` swallows whatever follows it: a letter run becomes the command NAME
 * (`\`+`int` → the command `\int`, the existing `int` gone), and a single
 * non-letter becomes a one-char command whose glyph replaces the structural token
 * it escaped (`\&` a literal ampersand, not a column separator; `\}`/`\{` a brace
 * glyph, not a group boundary; `\^`/`\_` a literal, not a script). `[`/`]` lex as
 * ordinary chars but the PARSER reads them as a `\sqrt[…]` index delimiter, so
 * `\sqrt[3\]{x}` fuses `]`→`\]` and the index swallows the radicand. A `\` before
 * another `\` inside a tabular environment forms a row-break `\\`. Every case
 * destroys the adjacent construct — a command, a cell boundary, a slot, a script
 * — so a live editor wedges a command-separator space between the two (see the
 * callers in `nodes/math.ts`), keeping the `\` a lone command-intro; the lexer's
 * `literalStart` masks the fusion only while the `\` is the one being typed.
 *
 * The guard therefore fires for ANY adjacent character that is not:
 *  - whitespace or end-of-string — `\ ` is already a control space and a trailing
 *    `\` a harmless empty command;
 *  - a prime `'` — parser-structural, but a separator would detach it from its
 *    base rather than repair it, and typing `\` flush before a `'` is vanishingly
 *    rare (see KaTeX prime handling), so it is intentionally left unguarded;
 *  - a second `\` OUTSIDE a tabular environment — there the lexer keeps the two
 *    backslashes separate (a harmless literal `\\`), so no fusion occurs.
 *
 * Pure over the source string.
 */
export function backslashFusesWith(latex: string, offset: number): boolean {
  const ch = latex[offset];
  if (ch === undefined || /\s/.test(ch)) return false;
  if (ch === "'") return false;
  // `\` + `\` forms `\\` — a row break, but only inside an environment; elsewhere
  // the lexer keeps the two backslashes separate (a harmless literal backslash).
  if (ch === "\\") return environmentDepthAt(latex, offset) > 0;
  return true;
}

/**
 * Auto-heal: the appended closing braces that balance every unclosed grouping
 * `{` in `latex`, or an empty list when it is already balanced.
 *
 * Why this is needed: the parser is error-tolerant, so an unclosed group
 * (`\frac{a}{b+\frac{c}{d}` — one `{` too few) still *renders* — its group just
 * runs to the end of the source. But that swallows every trailing offset into
 * the group: the source end sits INSIDE the open denominator, so there is no
 * top-level caret position after the construct and nothing can be typed beside
 * it — the formula becomes a right-side dead end. Well-formed editing never
 * produces this (a typed brace is escaped to `\{`/`\}` unless it closes a real
 * group — see {@link escapeTypedBrace} — and construct materialization inserts
 * balanced `{}` pairs), so imbalance only enters through pasted / imported
 * source. Closing the dangling groups restores the exit position.
 *
 * The heal is a pure suffix of `}` appended at the very end, one per still-open
 * `{` (innermost closes first, matching how the groups nest). That is exactly
 * render-neutral: an unclosed group and its explicitly-closed form parse to the
 * same tree, so the typeset formula is unchanged — only the missing caret stop
 * beyond it reappears. Escaped braces (`\{`) and stray unmatched `}` (which the
 * parser already drops harmlessly, and which don't trap the caret) are left
 * alone. Idempotent: balanced source yields no inserts. Lexes rather than
 * scanning chars so `\{`/`\}` never count as grouping tokens.
 *
 * Appending at the source end shifts no earlier offset, so a caret anywhere in
 * the original source keeps its position (it simply gains a reachable stop to
 * its right) — hence no caret remap, unlike {@link normalizeLatex}.
 */
export function balanceBraces(latex: string): {
  readonly inserts: readonly LatexInsert[];
  readonly changed: boolean;
} {
  let open = 0;
  for (const t of tokenize(latex)) {
    if (t.kind === "lbrace") open++;
    else if (t.kind === "rbrace" && open > 0) open--;
  }
  if (open === 0) return { inserts: [], changed: false };
  return {
    inserts: [{ at: latex.length, text: "}".repeat(open) }],
    changed: true,
  };
}
