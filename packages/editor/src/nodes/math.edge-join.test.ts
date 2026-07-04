/**
 * Typing flush against an inline-math chip's edge: what joins the formula and
 * what stays plain text. `mathJoinAtEdgeAfterInput` is given the block AFTER the
 * char was inserted (still unmarked) and reports the range to re-mark as math, or
 * `null` to leave the char as plain text. Sentence punctuation reads as prose —
 * so `$x^2$` + `,` must NOT swallow the comma — while letters keep extending the
 * same formula.
 */
import { type Block, loadPage } from "../serlization/loadPage";
import {
  mathAbsorbNumericPunctuationAfterInput,
  mathJoinAtEdgeAfterInput,
} from "./math";
import { describe, expect, it } from "vitest";

describe("mathJoinAtEdgeAfterInput — edge typing", () => {
  // "aa $x^2$X": "aa " is 0..2, the chip "x^2" spans [3, 6), and the char just
  // typed at the right edge is at index 6 (caret 7).
  const rightEdge = (trailing: string): Block =>
    loadPage(`aa $x^2$${trailing}`).blocks[0];

  it("a letter at the right edge joins the formula", () => {
    expect(mathJoinAtEdgeAfterInput(rightEdge("z"), 7)).toEqual({
      from: 3,
      to: 7,
    });
  });

  it.each([",", ".", ";", ":", "!", "?"])(
    "prose punctuation %s at the right edge stays plain text (no join)",
    (p) => {
      expect(mathJoinAtEdgeAfterInput(rightEdge(p), 7)).toBeNull();
    },
  );

  it("a closing paren at the right edge still joins (math-ambiguous, not prose)", () => {
    expect(mathJoinAtEdgeAfterInput(rightEdge(")"), 7)).toEqual({
      from: 3,
      to: 7,
    });
  });

  it("prose punctuation at the LEFT edge stays plain text too", () => {
    // ",$x^2$": the comma is at index 0, the chip now starts at index 1 (caret 1).
    const block = loadPage(",$x^2$").blocks[0];
    expect(mathJoinAtEdgeAfterInput(block, 1)).toBeNull();
  });

  it("a letter at the LEFT edge joins the formula", () => {
    // "a$x^2$": the letter is at index 0, the chip "x^2" spans [1, 4) (caret 1).
    const block = loadPage("a$x^2$").blocks[0];
    expect(mathJoinAtEdgeAfterInput(block, 1)).toEqual({ from: 0, to: 4 });
  });

  it("a brace at the right edge joins escaped — the caller splices in its \\", () => {
    // The typed `{` at index 6 must enter the formula as the literal `\{`, so
    // the join asks for a `\` insert at the brace before re-marking [3, 8).
    expect(mathJoinAtEdgeAfterInput(rightEdge("{"), 7)).toEqual({
      from: 3,
      to: 7,
      insert: { at: 6, text: "\\" },
    });
  });

  it("a brace at the LEFT edge joins escaped too", () => {
    // "{$x^2$": the brace is at index 0, the chip now starts at the caret (1).
    const block = loadPage("{$x^2$").blocks[0];
    expect(mathJoinAtEdgeAfterInput(block, 1)).toEqual({
      from: 0,
      to: 4,
      insert: { at: 0, text: "\\" },
    });
  });

  it("a } at the right edge of a chip with an unclosed group joins raw", () => {
    // Chip "\text{ab" spans [3, 11); the `}` typed at 11 closes the group the
    // user opened raw, so it joins without an escaping backslash.
    const block = loadPage("aa $\\text{ab$}").blocks[0];
    expect(mathJoinAtEdgeAfterInput(block, 12)).toEqual({ from: 3, to: 12 });
  });
});

describe("mathAbsorbNumericPunctuationAfterInput — digit resolves edge punctuation as numeric", () => {
  // "aa $3$.1": the chip "3" spans [3, 4), the ejected dot sits flush at 4, and
  // the digit just typed after it is at 5 (caret 6).
  it("a digit after a flush edge dot absorbs both (decimal point)", () => {
    const block = loadPage("aa $3$.1").blocks[0];
    expect(mathAbsorbNumericPunctuationAfterInput(block, 6)).toEqual({
      from: 3,
      to: 6,
    });
  });

  it("a digit after a flush edge comma absorbs both (decimal comma / separator)", () => {
    const block = loadPage("aa $1$,0").blocks[0];
    expect(mathAbsorbNumericPunctuationAfterInput(block, 6)).toEqual({
      from: 3,
      to: 6,
    });
  });

  it("other prose punctuation never absorbs — `;` is not a number character", () => {
    const block = loadPage("aa $x$;1").blocks[0];
    expect(mathAbsorbNumericPunctuationAfterInput(block, 6)).toBeNull();
  });

  it("a non-digit after the edge dot stays prose (sentence reading holds)", () => {
    const block = loadPage("aa $x$.a").blocks[0];
    expect(mathAbsorbNumericPunctuationAfterInput(block, 6)).toBeNull();
  });

  it("punctuation not flush against the chip never absorbs", () => {
    // "aa $x$ .5": the space at 4 separates the chip from the dot — the user
    // already left the formula, so the digit stays prose.
    const block = loadPage("aa $x$ .5").blocks[0];
    expect(mathAbsorbNumericPunctuationAfterInput(block, 7)).toBeNull();
  });
});
