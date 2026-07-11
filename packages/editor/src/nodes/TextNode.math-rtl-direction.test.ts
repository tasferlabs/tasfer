/**
 * Inline-math source must not count toward a block's text direction.
 *
 * A math chip's visible characters ARE its LaTeX, so Arabic/Hebrew wrapped in
 * `\text{…}` sits in the block's `charRuns`. But the reader never sees those
 * source characters — the chip renders a typeset formula — so they must not
 * flip an otherwise-Latin paragraph to RTL. Only the surrounding prose decides
 * the block's base direction.
 */
import { createDefaultMarkRegistry } from "../rendering/marks";
import { loadPage } from "../serlization/loadPage";
import { resolveTheme } from "../styles";
import { TextNode, type TextualBlock } from "./TextNode";
import { describe, expect, it } from "vitest";

describe("block direction ignores inline-math source", () => {
  const styles = resolveTheme({});
  const marks = createDefaultMarkRegistry();
  const node = new TextNode();

  const directionOf = (markdown: string) => {
    const block = loadPage(markdown).blocks[0] as TextualBlock;
    return node.computeLayout(block, 400, styles, undefined, marks).isRTL;
  };

  it("stays LTR when Arabic lives only inside a math chip", () => {
    // Short Latin prose; the Arabic is all inside `\text{…}`. Counting the chip
    // source would make RTL dominate (many Arabic chars vs 2 Latin) and flip the
    // paragraph — the bug this guards against.
    expect(directionOf(String.raw`hi $\text{مرحبا بالعالم أهلا وسهلا}$`)).toBe(
      false,
    );
  });

  it("still resolves RTL from surrounding prose despite a math chip", () => {
    // The prose is Arabic; an inline LTR formula must not drag it back to LTR.
    expect(directionOf(String.raw`مرحبا بالعالم وأهلا $x^2 + y^2$`)).toBe(true);
  });

  it("plain Arabic-in-math with no prose falls back to the UI default (LTR)", () => {
    // No directional prose at all: the block has nothing to decide from once the
    // chip source is excluded, so it takes the default direction rather than RTL.
    expect(directionOf(String.raw`$\text{مرحبا}$`)).toBe(false);
  });
});
