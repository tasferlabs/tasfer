/**
 * The expand-selection ladder inside a code block.
 *
 * The highlighter tokenizes one line at a time and keeps no syntax tree, so the
 * rungs come from the text itself, the same way for every language: the word
 * under the caret, the inside of the nearest quotes, the inside of the nearest
 * bracket pair and then the pair itself (outward, pair by pair), the line
 * without its indentation, the whole line, and finally the whole block.
 *
 * Quotes only pair within one line, and brackets inside a quoted run are
 * skipped, so `f(")")` still pairs its real parentheses. A stray apostrophe in
 * a comment (`// don't`) can still mispair a line's quotes — the price of not
 * parsing — but never reaches past the line it is on.
 */

import type { SelectionRungRange } from "@tasfer/editor/actions/selection-expansion";
import {
  findWordEnd,
  findWordStart,
  isWordChar,
} from "@tasfer/editor/word-chars";

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set(Object.values(OPENERS));
const QUOTES = new Set(['"', "'", "`"]);

/** Every range the ladder may select around `[from, to)` in `text`. */
export function codeSelectionRungs(
  text: string,
  from: number,
  to: number,
): SelectionRungRange[] {
  const rungs: SelectionRungRange[] = [{ from: 0, to: text.length }];

  const seed =
    from < text.length && isWordChar(text[from])
      ? from
      : from > 0 && isWordChar(text[from - 1])
        ? from - 1
        : -1;
  if (seed >= 0) {
    rungs.push({
      from: findWordStart(text, seed),
      to: findWordEnd(text, seed),
    });
  }

  const lineStart = text.lastIndexOf("\n", from - 1) + 1;
  const newline = text.indexOf("\n", to);
  const lineEnd = newline < 0 ? text.length : newline;
  if (text.lastIndexOf("\n", to - 1) < lineStart) {
    rungs.push({ from: lineStart, to: lineEnd });
    const line = text.slice(lineStart, lineEnd);
    const indent = line.length - line.trimStart().length;
    const trailing = line.length - line.trimEnd().length;
    if (indent + trailing < line.length) {
      rungs.push({ from: lineStart + indent, to: lineEnd - trailing });
    }
  }

  for (const [open, close] of pairs(text)) {
    if (open < from && close >= to) rungs.push({ from: open + 1, to: close });
    if (open <= from && close + 1 >= to) {
      rungs.push({ from: open, to: close + 1 });
    }
  }
  return rungs;
}

/**
 * Matched bracket and quote pairs as `[open, close]` offsets. Brackets match
 * across lines; quotes match within a line, honoring backslash escapes, and
 * hide the brackets between them.
 */
function pairs(text: string): Array<readonly [number, number]> {
  const found: Array<readonly [number, number]> = [];
  const stack: number[] = [];
  let quote: { char: string; at: number } | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\n") {
      quote = null;
      continue;
    }
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote.char) {
        found.push([quote.at, i]);
        quote = null;
      }
      continue;
    }
    if (QUOTES.has(char)) {
      quote = { char, at: i };
    } else if (char in OPENERS) {
      stack.push(i);
    } else if (CLOSERS.has(char)) {
      // Pop to the matching opener; an unmatched closer is left alone.
      for (let k = stack.length - 1; k >= 0; k--) {
        if (OPENERS[text[stack[k]]] === char) {
          found.push([stack[k], i]);
          stack.length = k;
          break;
        }
      }
    }
  }
  return found;
}
