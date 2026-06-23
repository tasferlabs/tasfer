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

const isLetter = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

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
 * new command (command-entry caret just past it — see `pendingCommandRange`). It
 * forces the same no-merge behavior even INSIDE an environment, so typing `\`
 * before a `\frac` in a matrix cell doesn't momentarily read as a row break.
 */
export function tokenize(src: string, literalStart?: number): Token[] {
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
      if (src[i + 1] === "\\" && envDepth > 0 && start !== literalStart) {
        i += 2;
        tokens.push({ kind: "dbackslash", value: "\\\\", start, end: i });
        continue;
      }
      // \name (letters) or \<single symbol> (e.g. \{ \, \|)
      i++; // consume backslash
      if (i < n && isLetter(src[i])) {
        while (i < n && isLetter(src[i])) i++;
      } else if (i < n && src[i] !== "\\") {
        i++; // single non-letter command char — but never a following \, which
        // begins its own command (an empty-named \ shows as a literal backslash).
      }
      const value = src.slice(start + 1, i);
      // Track environment nesting so the `\\` rule above knows where it is.
      if (value === "begin") envDepth++;
      else if (value === "end" && envDepth > 0) envDepth--;
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
