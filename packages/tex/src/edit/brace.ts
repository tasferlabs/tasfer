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
 * The escaped form (`\{` / `\}`) a brace typed at `offset` should enter the
 * source as, or `null` when the raw brace is structurally meant there:
 *
 *  - `char` isn't a brace — not this function's keystroke.
 *  - The caret sits right after a lone `\` the user is typing the escape with, so
 *    `\` + `{` is the literal `\{` glyph itself (see {@link afterCommandIntro}).
 *    A brace flush after a command WORD (`\text{`, `\begin{`) is NOT special: a
 *    typed `{` never opens an argument — it always escapes to a literal glyph.
 *  - A `}` while a raw-opened group is still unclosed (imported/pasted
 *    `\text{abc|`) closes that group. Typing can no longer produce such an
 *    unclosed group (every typed `{` escapes), so this only affects pasted source.
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
 * The escaped literal (`\$`, `\#`, `\%`, `\&`) a reserved character typed at
 * `offset` should enter the source as, or `null` when the raw character is meant
 * there.
 *
 * `$` (math-mode toggle), `#` (macro parameter), `%` (line comment) and `&`
 * (column separator) carry LaTeX syntax a user typing into a live formula almost
 * never intends: a raw `%` silently comments the rest of the source, and a raw
 * `&` outside a tabular environment is dropped by the parser entirely — the
 * keystroke vanishes. Rewriting each to its escaped symbol typesets the visible
 * glyph and keeps the source valid, exactly as {@link escapeTypedBrace} does for
 * grouping braces. (`^`, `_`, `\` and the braces are the OTHER reserved
 * characters; they are handled by the script / backslash / brace paths and are
 * not literal-escapes.)
 *
 * The raw character still enters legitimately:
 *  - the user is typing the escape itself — a lone `\` already sits before the
 *    caret, so `\` + `&` completes the `\&` glyph rather than escaping twice;
 *  - a `&` inside a `\begin{…}` environment, where it IS a real column separator
 *    (a matrix cell divider) — see {@link environmentDepthAt}.
 *
 * Pure over the source string; the host applies the rewrite before committing
 * the keystroke.
 */
const RESERVED_LITERAL: Readonly<Record<string, string>> = {
  $: "\\$",
  "#": "\\#",
  "%": "\\%",
  "&": "\\&",
};

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
 * Whether `offset` sits inside the raw-text argument body of a text command
 * (`\text{…}`, `\textbf{…}`, `\operatorname{…}`, …) — the region the parser reads
 * as literal characters (see `parseRawTextArg`), where a `\` is a literal
 * backslash and letters are prose, not a math control word.
 *
 * A live editor uses this to keep the math-mode command-word machinery — the
 * command separator and the `\`→command-intro rewrite — OUT of text runs, where
 * treating a typed `\`+letters as a command would seed a spurious control word in
 * prose (`\text{}` + `\hi`). Inside such a body the host instead escapes a typed
 * `\` to the literal `\textbackslash{}` glyph and lets letters land as plain text.
 *
 * "Inside" spans from just after the argument's opening `{` through the position
 * of its closing `}` (so a caret flush against either brace still counts); a
 * caret just PAST the `}` is back in math mode and returns false. An unterminated
 * body (mid-edit `\text{ab`) extends to the source end. Braces nest, so the body
 * scan tracks depth. Lexes rather than scanning chars so an escaped brace (`\{`)
 * inside the text never mis-terminates the body. Pure over the source string.
 */
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

/**
 * `latex` with every STRAY closing `}` — a `}` that matches no earlier unclosed
 * `{` — rewritten to its literal glyph `\}`. The counterpart of {@link
 * balanceBraces} for the other imbalance direction.
 *
 * Why this is needed: the parser drops a stray `}` silently (it emits no glyph
 * and no group boundary), so a source that is ALL stray closes — the imported
 * `$$}$$` — parses to an empty expression. Unlike an unclosed `{`, this doesn't
 * trap the caret; it does something worse. The block's source is non-empty
 * (`}`), so the host's empty-block placeholder never shows, yet the layout draws
 * nothing and yields zero caret stops — the block is a blank, caret-less,
 * uneditable dead cell (the reported bug). Escaping each stray `}` to `\}` makes
 * it a real brace glyph with its own caret stops, so the character is preserved
 * (never silently swallowed) and the block stays editable — exactly the
 * typed-brace philosophy ({@link escapeTypedBrace}) applied to imported source.
 *
 * Well-formed editing never produces a stray `}` (a typed `}` is escaped to `\}`
 * unless it closes a real group), so this only affects pasted / imported source,
 * like {@link balanceBraces}. Lexes rather than scanning chars so an escaped
 * brace (`\}`) is never mistaken for a grouping token. Idempotent: source with no
 * stray close is returned unchanged.
 */
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
 * The edits that escape every stray `}` in `latex` to `\}`, as `{ at, text: "\\" }`
 * inserts (a lone `\` spliced just before each stray brace) — the CRDT-op form of
 * {@link escapeStrayCloseBraces}, parallel to {@link balanceBraces}'s append.
 *
 * A live editor applies these to *heal an existing block* whose committed source
 * carries a stray `}` — source that predates import sanitization (it entered the
 * CRDT op-log directly, bypassing {@link escapeStrayCloseBraces}) and would
 * otherwise render as a blank, caret-less dead cell. Unlike the append-only
 * {@link balanceBraces}, an insert lands BEFORE the caret when the stray sits
 * left of it, so the caller must shift the caret by the number of such inserts.
 * Empty when there is no stray close.
 */
export function strayCloseBraceInserts(latex: string): readonly LatexInsert[] {
  return strayCloseBracePositions(latex).map((at) => ({ at, text: "\\" }));
}
