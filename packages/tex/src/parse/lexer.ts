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

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const start = i;
    const c = src[i];

    if (isSpace(c)) {
      while (i < n && isSpace(src[i])) i++;
      tokens.push({ kind: "space", value: src.slice(start, i), start, end: i });
      continue;
    }

    if (c === "\\") {
      // \\  → line break
      if (src[i + 1] === "\\") {
        i += 2;
        tokens.push({ kind: "dbackslash", value: "\\\\", start, end: i });
        continue;
      }
      // \name (letters) or \<single symbol> (e.g. \{ \, \|)
      i++; // consume backslash
      if (i < n && isLetter(src[i])) {
        while (i < n && isLetter(src[i])) i++;
      } else if (i < n) {
        i++; // single non-letter command char
      }
      tokens.push({
        kind: "command",
        value: src.slice(start + 1, i),
        start,
        end: i,
      });
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
