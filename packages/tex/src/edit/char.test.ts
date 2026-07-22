/**
 * `canRenderMathChar` must agree with what the engine actually lays out: a
 * character it rejects is exactly one that would render as the zero-width
 * fallback glyph (invisible, caret-less "latent" content), and a character it
 * accepts produces a glyph with real width.
 */
import { canRenderMathChar } from "./char";
import { layoutMath } from "../index";
import { describe, expect, it } from "vitest";

describe("canRenderMathChar", () => {
  it("accepts ordinary renderable characters", () => {
    for (const ch of ["a", "Z", "0", "9", "+", "=", "(", ")", "."]) {
      expect(canRenderMathChar(ch)).toBe(true);
    }
  });

  it("accepts structural characters that shape the formula without a glyph", () => {
    for (const ch of ["\\", "{", "}", "^", "_", "&", " "]) {
      expect(canRenderMathChar(ch)).toBe(true);
    }
  });

  it("rejects characters with no font metric (Arabic, CJK, emoji)", () => {
    for (const ch of ["ع", "ب", "中", "あ", "😀"]) {
      expect(canRenderMathChar(ch)).toBe(false);
    }
  });

  it("rejected characters lay out to zero width; accepted ones do not", () => {
    // Anchor the predicate to real layout so the two can't drift apart.
    expect(layoutMath("ع").width).toBe(0);
    expect(layoutMath("x").width).toBeGreaterThan(0);
  });
});
