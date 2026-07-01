/**
 * Typing flush against an inline-math chip's edge: what joins the formula and
 * what stays plain text. `mathJoinAtEdgeAfterInput` is given the block AFTER the
 * char was inserted (still unmarked) and reports the range to re-mark as math, or
 * `null` to leave the char as plain text. Sentence punctuation reads as prose —
 * so `$x^2$` + `,` must NOT swallow the comma — while letters keep extending the
 * same formula.
 */
import { type Block, loadPage } from "../serlization/loadPage";
import { mathJoinAtEdgeAfterInput } from "./math";
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
});
