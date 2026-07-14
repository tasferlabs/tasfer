/**
 * Tokenizer for a LaTeX math string. Each token carries its source `[start,
 * end)` so the parser can thread spans onto every AST node. Whitespace is
 * emitted as its own token (math mode collapses it, but the caret still needs
 * to know it was there); the parser decides what to ignore.
 */
export type TokenKind =
  | "command" // \name  or  \<single non-letter>
  | "char" // a single literal character
  | "lbrace" // {
  | "rbrace" // }
  | "sup" // ^
  | "sub" // _
  | "amp" // &
  | "dbackslash" // \\
  | "space"
  | "eof";

export interface Token {
  readonly kind: TokenKind;
  /** For `command`, the name without the backslash; otherwise the raw text. */
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

const isLetter = (c: string) =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isSpace = (c: string) =>
  c === " " || c === "\t" || c === "\n" || c === "\r";

/**
 * `\\` is a row separator ONLY inside a tabular environment (`matrix`, `cases`,
 * `aligned`, …) — that's the only place the parser consumes it (`parseEnvironment`
 * splits rows on `dbackslash`). Outside one it has no meaning and used to be
 * silently dropped, which made a stray `\` typed before a construct vanish AND
 * de-structure it: `\frac{dy}{dx}` with a `\` typed in front lexes the `\\` as a
 * line break, orphaning `frac{dy}{dx}` into the literal `\fracdydx`.
 *
 * So the lexer tracks `\begin`/`\end` depth and only emits `dbackslash` inside an
 * environment. Outside one, a `\\` does NOT merge: the first `\` becomes a
 * standalone (empty-named) command — rendered as a visible literal backslash —
 * and the second `\` still opens its command, so the stray backslash shows and
 * the construct stays whole.
 *
 * `literalStart` is the source offset of a `\` the caller is actively typing as a
 * new command (command-entry caret just past it — see `pendingCommandRange`).
 * That `\` never merges with what follows it, in two ways:
 *
 *  - It forces the `\\` no-merge behavior even INSIDE an environment, so typing
 *    `\` before a `\frac` in a matrix cell doesn't momentarily read as a row
 *    break.
 *  - It also skips the single-non-letter-command merge, so typing `\` before an
 *    EXISTING structural char doesn't swallow it: in `\frac{a\|}{b}` the fresh
 *    `\` would otherwise lex as `\}`, stealing the frac's closing brace —
 *    de-structuring the fraction and flashing a red brace glyph. The typed `\`
 *    stays a standalone empty-named command until the user types the next char
 *    themselves (at which point the caret moves past it, command entry ends,
 *    and a deliberate `\}` lexes normally).
 *
 * Letters after the command-entry `\` still merge — they ARE the command name
 * being typed (`\al` en route to `\alpha`).
 */
export interface TokenizeOptions {
  /** Offset of the `\` being actively typed (see module docs above). */
  literalStart?: number;
  /**
   * Offsets of `\`s that are editable field CONTENT, not syntax — the printed
   * projection of a structured document's raw-text scratch (see
   * `projectMathDocumentSource`). Unlike `literalStart`, these do not depend on
   * where the caret is: the marks hold for every consumer of the projection.
   * Each marked `\` gets `literalStart`'s no-merge behavior, and a marked
   * `\begin`/`\end` additionally does NOT shift environment depth — a
   * half-typed `\end` resting in a matrix cell must not make the REAL matrix's
   * `\\` separators lex as literal backslashes (or a stray `\begin` make
   * outside `\\`s lex as row breaks).
   */
  literalBackslashes?: readonly number[];
}

export function tokenize(src: string, opts: TokenizeOptions = {}): Token[] {
  const fieldBackslashes = new Set(opts.literalBackslashes);
  const literalStarts = new Set(opts.literalBackslashes);
  if (opts.literalStart !== undefined) literalStarts.add(opts.literalStart);
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  // `\begin`/`\end` nesting depth — `\\` is a row separator only while inside one.
  let envDepth = 0;

  while (i < n) {
    const start = i;
    const c = src[i];

    if (isSpace(c)) {
      while (i < n && isSpace(src[i])) i++;
      tokens.push({ kind: "space", value: src.slice(start, i), start, end: i });
      continue;
    }

    if (c === "\\") {
      // \\  → row break, but ONLY inside an environment and not for the
      // command-entry `\` being typed. Otherwise keep the two `\`s separate (see
      // `tokenize` docs): a stray `\` stays a visible literal backslash and a
      // following \command stays intact instead of de-structuring.
      if (src[i + 1] === "\\" && envDepth > 0 && !literalStarts.has(start)) {
        i += 2;
        tokens.push({ kind: "dbackslash", value: "\\\\", start, end: i });
        continue;
      }
      // \name (letters) or \<single symbol> (e.g. \{ \, \|)
      i++; // consume backslash
      if (i < n && isLetter(src[i])) {
        while (i < n && isLetter(src[i])) i++;
      } else if (i < n && src[i] !== "\\" && !literalStarts.has(start)) {
        i++; // single non-letter command char — but never a following \, which
        // begins its own command (an empty-named \ shows as a literal backslash),
        // and never for a literal-marked \ (command entry, field content):
        // merging would steal an EXISTING structural char (`\frac{a\|}{b}` →
        // `\}` swallows the frac's closing brace, de-structuring it and
        // flashing a red brace glyph).
      }
      const value = src.slice(start + 1, i);
      // Track environment nesting so the `\\` rule above knows where it is.
      // Field-content `\begin`/`\end` scratch is inert (see TokenizeOptions).
      if (!fieldBackslashes.has(start)) {
        if (value === "begin") envDepth++;
        else if (value === "end" && envDepth > 0) envDepth--;
      }
      tokens.push({ kind: "command", value, start, end: i });
      continue;
    }

    i++;
    switch (c) {
      case "{":
        tokens.push({ kind: "lbrace", value: c, start, end: i });
        break;
      case "}":
        tokens.push({ kind: "rbrace", value: c, start, end: i });
        break;
      case "^":
        tokens.push({ kind: "sup", value: c, start, end: i });
        break;
      case "_":
        tokens.push({ kind: "sub", value: c, start, end: i });
        break;
      case "&":
        tokens.push({ kind: "amp", value: c, start, end: i });
        break;
      default:
        tokens.push({ kind: "char", value: c, start, end: i });
    }
  }

  tokens.push({ kind: "eof", value: "", start: n, end: n });
  return tokens;
}
