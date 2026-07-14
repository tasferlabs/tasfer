/**
 * Render and edit must resolve an inline-math chip to the SAME extent and the
 * SAME canonical source.
 *
 * A chip is one atomic anchor char in the flat text whose math mark references
 * a supplemental structured document. The edit/caret path resolves it through
 * `resolveStructuredInlineMathRuns`; the render path (`TextNode.
 * replacementRuns`) resolves the run extent through the shared
 * `resolveMarkRunsFromChars` and the canonical source through the mark's
 * `replacement.source` hook over the block's attachments. If the two paths ever
 * disagreed, the painted chip and the live caret/serializer would diverge on
 * where the formula is or what it says.
 */
import { createMathTestMarkRegistry, loadMathPage } from "./__testutils__/math";
import { STRUCTURED_MARK_ANCHOR_CHAR } from "./feature-facets";
import { getInlineMathSpans, resolveMarkRunsFromChars } from "./inline-math-spans";
import { resolveStructuredInlineMathRuns } from "./math/inline-structured";
import type { TextualBlock } from "./nodes/TextNode";
import { charRunsToChars } from "./sync/char-runs";
import { describe, expect, it } from "vitest";

/** The single paragraph block of `before $latex$ after`, with one chip. */
function blockWithChip(latex: string): TextualBlock {
  const page = loadMathPage(`before $${latex}$ after`);
  return page.blocks[0] as TextualBlock;
}

/** The math run as the render path resolves it (mirrors `replacementRuns`). */
function renderMathRun(block: TextualBlock) {
  const run = resolveMarkRunsFromChars(
    charRunsToChars(block.charRuns),
    block.formats,
  ).find((r) => r.name === "math");
  if (!run) return null;
  const replacement = createMathTestMarkRegistry().get("math")?.replacement;
  const source = replacement?.source?.(run.text, {
    mark: { type: run.name, attrs: run.attrs },
    attachments: block.structuredContent,
  });
  return { start: run.startIndex, end: run.endIndex, source };
}

describe("inline-math render/edit resolution agree", () => {
  it("resolves the same atomic extent and canonical source for a chip", () => {
    const block = blockWithChip("\\frac{a}{b}");

    const edit = resolveStructuredInlineMathRuns(block);
    expect(edit).toHaveLength(1);
    // Atomic to the flat model: exactly one anchor char.
    expect(edit[0].endIndex).toBe(edit[0].startIndex + 1);

    const render = renderMathRun(block);
    expect(render).not.toBeNull();
    expect(render!.start).toBe(edit[0].startIndex);
    expect(render!.end).toBe(edit[0].endIndex);
    // Both paths read the SAME attachment, so the canonical source agrees.
    expect(render!.source).toBe(edit[0].latex);
    expect(render!.source).toBe("\\frac{a}{b}");
  });

  it("edit-path spans carry the anchor char, not the formula source", () => {
    // `InlineMathSpan.text` is the run's FLAT text — a structured chip's single
    // U+FFFC anchor — never LaTeX; canonical source lives on the resolved run.
    const block = blockWithChip("x+y");
    const spans = getInlineMathSpans(block);
    const runs = resolveStructuredInlineMathRuns(block);

    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe(STRUCTURED_MARK_ANCHOR_CHAR);
    expect(spans[0].startIndex).toBe(runs[0].startIndex);
    expect(spans[0].endIndex).toBe(runs[0].endIndex);
  });
});
