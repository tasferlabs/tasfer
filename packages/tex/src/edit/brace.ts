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
import { RAW_TEXT_COMMANDS } from "../parse/parser";
import type { LatexInsert } from "./normalize";

/**
 * The caret sits flush after a lone `\` the user is typing the escape glyph with
 * — so a `{`/`}` typed here completes that escape (`\` + `{` → the literal `\{`)
 * and must NOT be re-escaped into `\\{`. This is the ONLY position a typed brace
 * enters the source raw: a `{` flush after a command WORD (`\text`, `\begin`)
 * used to open the command's argument, but a typed `{` no longer opens any
 * argument — it always escapes to a literal glyph — so only the lone-`\` case
 * remains. Excludes the trailing `\` of a row-break `\\` (that `\` introduces no
 * escape, so a following brace escapes normally).
 */
function afterCommandIntro(latex: string, offset: number): boolean {
  return latex[offset - 1] === "\\" && latex[offset - 2] !== "\\";
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
 * Returns what a `{` or `}` typed at `offset` should become: `\{` or `\}`, so
 * the user sees a brace. Returns `null` when the brace should go in as typed:
 *
 * - `char` is not a brace.
 * - A single `\` (not `\\`) sits right before the caret, so the user is typing
 *   `\{` or `\}` themselves.
 * - `char` is `}` and a `{` before the caret is never closed. This only happens
 *   in pasted LaTeX, because a typed `{` is always escaped.
 *
 * A `{` typed right after a command such as `\text` is escaped too. It does not
 * open the command's argument.
 *
 * This only reads `latex`. The editor applies the result before it inserts the
 * key.
 *
 * @group Source editing
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

/** How each reserved character is written so it shows as a plain symbol. */
const RESERVED_LITERAL: Readonly<Record<string, string>> = {
  $: "\\$",
  "#": "\\#",
  "%": "\\%",
  "&": "\\&",
};

/**
 * Returns what a `$`, `#`, `%` or `&` typed at `offset` should become: `\$`,
 * `\#`, `\%` or `\&`, so the user sees the symbol. Returns `null` for any other
 * character, and when the character should go in as typed:
 *
 * - A single `\` (not `\\`) sits right before the caret, so the user is typing
 *   the escape themselves.
 * - `char` is `&` inside a `\begin…\end` environment, where it separates matrix
 *   columns.
 *
 * Typed raw, these characters do LaTeX things the user rarely means. A `%`
 * hides the rest of the formula, and an `&` outside a matrix is dropped. Braces
 * are handled by {@link escapeTypedBrace}.
 *
 * This only reads `latex`. The editor applies the result before it inserts the
 * key.
 *
 * @group Source editing
 */
// `^`, `_`, `\` and the braces are the other reserved characters; they go
// through the script / backslash / brace paths, not this literal escape.
export function escapeTypedReserved(
  latex: string,
  offset: number,
  char: string,
): string | null {
  const escaped = RESERVED_LITERAL[char];
  if (escaped === undefined) return null;
  // A lone `\` already before the caret: this keystroke completes that escape
  // (`\` + `&` → `\&`), so leave the character raw instead of escaping it twice.
  if (latex[offset - 1] === "\\" && latex[offset - 2] !== "\\") return null;
  // A `&` inside a tabular / matrix environment is a real column separator.
  if (char === "&" && environmentDepthAt(latex, offset) > 0) return null;
  return escaped;
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
 * Returns `true` when `offset` is inside the text of a text command such as
 * `\text{…}`, `\textbf{…}` or `\operatorname{…}`. There, letters are plain
 * words and a `\` is a plain backslash, not the start of a command.
 *
 * Right after the opening `{` and right before the closing `}` count as inside.
 * Right after the `}` does not. In an unclosed `\text{ab`, everything up to the
 * end of the text counts as inside.
 *
 * A math editor uses this to turn off command handling inside text. There, a
 * typed `\` becomes `\textbackslash{}`.
 *
 * @group Source editing
 */
// Braces nest, so the body scan tracks depth. Lexes rather than scanning chars
// so an escaped `\{` inside the text never ends the body early. See
// parseRawTextArg.
export function inRawTextArg(latex: string, offset: number): boolean {
  const toks = [...tokenize(latex)];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== "command" || !RAW_TEXT_COMMANDS.has(t.value)) continue;
    // The argument is the next group; skip only intervening spaces.
    let j = i + 1;
    while (j < toks.length && toks[j].kind === "space") j++;
    if (j >= toks.length || toks[j].kind !== "lbrace") continue;
    const bodyStart = toks[j].end; // just after the opening `{`
    let depth = 1;
    let k = j + 1;
    for (; k < toks.length && depth > 0; k++) {
      if (toks[k].kind === "lbrace") depth++;
      else if (toks[k].kind === "rbrace") depth--;
    }
    // The closing `}` position, or the source end for an unterminated body.
    const bodyEnd = depth === 0 ? toks[k - 1].start : latex.length;
    if (offset >= bodyStart && offset <= bodyEnd) return true;
  }
  return false;
}

/**
 * Returns `true` when a `\` typed just before `offset` would join with the next
 * character and change what it means. For example, `\` before `int` makes the
 * command `\int`. `\` before `&` turns a column break into a plain `&`. `\`
 * before another `\` inside a matrix makes a row break.
 *
 * A math editor uses this to put a space between the `\` and the next
 * character, so that character keeps its meaning.
 *
 * Returns `false` before whitespace, at the end of the text, before a prime
 * `'`, and before another `\` outside a `\begin…\end` environment.
 *
 * @group Source editing
 */
// The prime `'` is left unguarded on purpose: a separator would detach it from
// its base rather than repair it, and typing `\` flush before `'` is very rare
// (see KaTeX prime handling). `[`/`]` lex as plain chars but the parser reads
// them as a `\sqrt[…]` index, so `\sqrt[3\]{x}` would swallow the radicand.
// Callers live in packages/math/src/math.ts; the lexer's `literalStart` masks
// the fusion only while the `\` is the one being typed.
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
 * Finds the `}` braces missing from `latex`, one for each `{` that is never
 * closed. Returns them as one insert at the end of the text, with `changed:
 * true`. When the braces already balance, returns no inserts and `changed:
 * false`.
 *
 * Pasted LaTeX like `\frac{a}{b+\frac{c}{d}` still renders, but the caret
 * cannot get past the end of the formula. Adding the missing braces fixes that
 * without changing how the formula looks. Escaped braces (`\{`, `\}`) and extra
 * `}` are ignored.
 *
 * Text is only added at the end, so every caret position stays valid. Unlike
 * {@link normalizeLatex}, you do not need to move the caret.
 *
 * For extra `}` braces, see {@link escapeStrayCloseBraces}.
 *
 * @group Source editing
 */
// Normal editing never unbalances braces (typed braces are escaped unless they
// close a real group, and construct insertion adds balanced `{}` pairs), so
// imbalance only comes from pasted or imported source. An unclosed group and
// its closed form parse to the same tree. Lexes rather than scanning chars so
// `\{`/`\}` never count.
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

/**
 * Returns `latex` with every extra `}` turned into `\}`, a visible brace. An
 * extra `}` is one with no open `{` before it. Text with no extra `}` comes
 * back unchanged.
 *
 * The parser drops an extra `}` without showing it. A pasted formula that is
 * only `}` would draw nothing and give the caret nowhere to go. Escaping keeps
 * the brace visible and editable. Escaped braces (`\{`, `\}`) already in the
 * text are left alone.
 *
 * For the opposite problem, a `{` that is never closed, see
 * {@link balanceBraces}.
 *
 * @group Source editing
 */
// Normal typing never makes a stray `}` (a typed `}` is escaped unless it
// closes a real group), so this only matters for pasted or imported source. The
// all-stray case (`$$}$$`) was the reported blank, caret-less block bug: the
// source is non-empty so the empty placeholder never shows. Lexes rather than
// scanning chars so `\}` never counts as grouping.
export function escapeStrayCloseBraces(latex: string): string {
  const strays = strayCloseBracePositions(latex);
  if (strays.length === 0) return latex;
  let out = "";
  let from = 0;
  for (const at of strays) {
    out += latex.slice(from, at) + "\\";
    from = at;
  }
  return out + latex.slice(from);
}

/** Source offsets of every stray `}` (matching no earlier unclosed `{`), in
 *  ascending order. Lexes so `\}` is never counted. Shared by the string form
 *  {@link escapeStrayCloseBraces} and the insert form {@link strayCloseBraceInserts}. */
function strayCloseBracePositions(latex: string): number[] {
  const strays: number[] = [];
  let open = 0;
  for (const t of tokenize(latex)) {
    if (t.kind === "lbrace") open++;
    else if (t.kind === "rbrace") {
      if (open > 0) open--;
      else strays.push(t.start);
    }
  }
  return strays;
}

/**
 * Returns the edits that turn every extra `}` in `latex` into `\}`. Each edit
 * inserts one `\` just before an extra `}`, as `{ at, text: "\\" }`. Empty when
 * there is no extra `}`.
 *
 * This does the same job as {@link escapeStrayCloseBraces}, but as small
 * inserts. Use it to repair a formula that is already in a document, without
 * replacing its whole text.
 *
 * An insert can land before the caret. Move the caret right by one for each
 * insert that lands before it.
 *
 * @group Source editing
 */
// Used to heal blocks whose source was saved before import-time escaping
// existed.
export function strayCloseBraceInserts(latex: string): readonly LatexInsert[] {
  return strayCloseBracePositions(latex).map((at) => ({ at, text: "\\" }));
}
