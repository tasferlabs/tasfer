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
