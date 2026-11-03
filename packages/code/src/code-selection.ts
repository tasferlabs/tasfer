/**
 * The expand-selection ladder inside a code block.
 *
 * The highlighter tokenizes one line at a time and keeps no syntax tree, so the
 * rungs come from the text itself, the same way for every language: the word
 * under the caret, the inside of the nearest quotes, the inside of the nearest
 * bracket pair and then the pair itself (outward, pair by pair), the line
 * without its indentation, the whole line, the indented blocks around it, and
 * finally the whole block.
 *
 * Indented blocks are what give Python or YAML any structure at all. At each
 * indent level two rungs: the body (the run of lines at that indent or deeper,
 * blank lines included) and the header line above it together with that body.
 * Then the header's own level, and so on out to the left margin. A closing
 * bracket line at the header's indent (`}` in JS, `)` after a wrapped call)
 * joins the header's block, so brace languages get the whole `if (…) { … }`.
 * Indentation is counted in whitespace characters, so a block mixing tabs and
 * spaces can nest wrongly.
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

  rungs.push(...indentRungs(text, from, to));

  for (const [open, close] of pairs(text)) {
    if (open < from && close >= to) rungs.push({ from: open + 1, to: close });
    if (open <= from && close + 1 >= to) {
      rungs.push({ from: open, to: close + 1 });
    }
  }
  return rungs;
}

interface Line {
  start: number;
  end: number;
  indent: number;
  blank: boolean;
}

/** The indented blocks around `[from, to)`, innermost first. */
function indentRungs(
  text: string,
  from: number,
  to: number,
): SelectionRungRange[] {
  const lines: Line[] = [];
  for (let start = 0; ;) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(start, end);
    const trimmed = line.trimStart();
    lines.push({
      start,
      end,
      indent: line.length - trimmed.length,
      blank: trimmed.trimEnd() === "",
    });
    if (newline < 0) break;
    start = newline + 1;
  }
  const lineAt = (offset: number) => {
    let i = lines.length - 1;
    while (lines[i].start > offset) i--;
    return i;
  };

  const first = lineAt(from);
  // A range ending right after a newline does not reach into the next line.
  const last =
    to > from && lines[lineAt(to)].start === to ? lineAt(to) - 1 : lineAt(to);
  let level = Infinity;
  let top = -1;
  for (let i = first; i <= last; i++) {
    if (lines[i].blank) continue;
    level = Math.min(level, lines[i].indent);
    if (top < 0) top = i;
  }
  if (top < 0) return [];

  const rungs: SelectionRungRange[] = [];
  const span = (a: number, b: number) => {
    while (lines[b].blank) b--;
    rungs.push({ from: lines[a].start, to: lines[b].end });
  };
  // The header line `i` with everything indented under it.
  const block = (i: number) => {
    const indent = lines[i].indent;
    let b = i;
    while (b + 1 < lines.length) {
      const next = lines[b + 1];
      if (!next.blank && next.indent <= indent) {
        if (next.indent === indent && CLOSERS.has(text[next.start + indent])) {
          b++;
        }
        break;
      }
      b++;
    }
    span(i, b);
  };

  block(top);
  let a = first;
  let b = last;
  for (;;) {
    while (a > 0 && (lines[a - 1].blank || lines[a - 1].indent >= level)) a--;
    while (
      b + 1 < lines.length &&
      (lines[b + 1].blank || lines[b + 1].indent >= level)
    ) {
      b++;
    }
    const header = a - 1;
    while (lines[a].blank) a++;
    span(a, b);
    if (header < 0) return rungs;
    block(header);
    level = lines[header].indent;
    a = b = header;
  }
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
