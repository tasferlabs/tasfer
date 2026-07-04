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
