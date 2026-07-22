/**
 * `measureCRDTPositions` builds the cumulative caret x for every boundary on a
 * line — the hit-test hot path. It was rewritten to batch the line ONCE and
 * precompute replacement-chip geometry once, instead of calling
 * `measureTextUpToIndex` per position (which re-batched the whole prefix and
 * rebuilt chip maps every time — O(n²)/O(n³) on long or chip-bearing lines).
 *
 * This pins that the rewrite is output-identical to the per-position reference
 * it replaced, across plain text, mixed formatting (multiple batches), and
 * inline-math chips (the replacement path). If they ever diverge, hit-testing
 * would stop matching `caretRect`, so the caret would land on the wrong glyph.
 */
import { measureCRDTPositions, measureTextUpToIndex } from "./fonts";
import { TextNode, type TextualBlock } from "./nodes/TextNode";
import { createDefaultMarkRegistry } from "./rendering/marks";
import { loadPage } from "./serlization/loadPage";
import { resolveTheme } from "./styles";
import { describe, expect, it } from "vitest";

const styles = resolveTheme({});
const marks = createDefaultMarkRegistry();
const node = new TextNode();

/** The per-position reference: exactly what the old measureCRDTPositions did. */
function referencePositions(
  layout: ReturnType<TextNode["computeLayout"]>,
  startIndex: number,
  endIndex: number,
): number[] {
  const out = [0];
  for (let i = 1; i <= endIndex - startIndex; i++) {
    out.push(
      measureTextUpToIndex(
        layout.chars,
        layout.formats,
        startIndex,
        startIndex + i,
        layout.textStyle.fontSize,
        layout.textStyle.fontWeight,
        layout.fontFamily,
        layout.fonts,
        0,
        layout.marks,
        layout.replCharWidths,
      ),
    );
  }
  return out;
}

function assertParity(markdown: string, width = 1000): void {
  const block = loadPage(markdown).blocks[0] as TextualBlock;
  const layout = node.computeLayout(block, width, styles, undefined, marks);
  for (const line of layout.lines) {
    const fast = measureCRDTPositions(
      layout.chars,
      layout.formats,
      line.startIndex,
      line.endIndex,
      layout.textStyle.fontSize,
      layout.textStyle.fontWeight,
      layout.fontFamily,
      layout.fonts,
      layout.marks,
      layout.replCharWidths,
    );
    const ref = referencePositions(layout, line.startIndex, line.endIndex);
    expect(fast).toEqual(ref);
  }
}

describe("measureCRDTPositions parity with per-position reference", () => {
  it("plain single-run text", () => {
    assertParity("the quick brown fox jumps over the lazy dog");
  });

  it("mixed formatting (multiple batches)", () => {
    assertParity("plain **bold** and *italic* and `code` tail");
  });

  it("an inline-math chip (replacement run)", () => {
    assertParity("before $x^2 + y^2$ after");
  });

  it("multiple chips separated by text", () => {
    assertParity("$a$ mid $b_2$ end $\\frac{1}{2}$ done");
  });

  it("an RTL line with an embedded chip", () => {
    assertParity("اااا كلمة $x^2$ أخرى");
  });

  it("a chip forced to wrap across lines (replCharWidths)", () => {
    assertParity(
      "aaaa bbbb cccc dddd eeee ffff gggg $x^2 + y^2 + z^2 + w^2$ tail",
      120,
    );
  });

  it("a long single run (matrix-source-like)", () => {
    assertParity(
      "\\begin{matrix}{}&{}&{}\\\\{}&{}&{}\\\\{}&{}&{}\\end{matrix}",
    );
  });
});
