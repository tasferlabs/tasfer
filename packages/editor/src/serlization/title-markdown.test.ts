/**
 * extractTitleMarkdownFromBlocks — the rich (markdown) projection of a page's
 * title. Must pick the same block as the plain extractTitleFromBlocks, keep
 * mark delimiters intact through the codec path, and never slice inside a
 * formatted run when truncating (half a math run's LaTeX is corrupt source).
 */

import { mathTestSchema } from "../__testutils__/math";
import { renderToSVG } from "../nodes/math";
import { extractTitleFromBlocks, findTitleBlock } from "../sync/char-runs";
import { extractTitleMarkdownFromBlocks, inlineToHtml } from "./codecs/inline";
import { loadPage } from "./loadPage";
import { describe, expect, it } from "vitest";

const schema = mathTestSchema.data;

function titleMd(md: string, maxLength?: number): string {
  return extractTitleMarkdownFromBlocks(
    loadPage(md, schema).blocks,
    schema,
    maxLength,
  );
}

describe("extractTitleMarkdownFromBlocks", () => {
  it("returns the title line's inline markdown with marks intact", () => {
    // Math emits the attachment's CANONICAL source, so `mc^2` comes back
    // canonicalized — semantics preserved, delimiters intact.
    expect(titleMd("# Energy is **famously** $E=mc^2$\n\nBody text.")).toBe(
      "Energy is **famously** $E=m{c}^{2}$",
    );
  });

  it("agrees with the plain extractor on which block is the title", () => {
    const md = "plain paragraph first\n\n# Heading *later*\n";
    const blocks = loadPage(md, schema).blocks;
    // Plain extractor prefers the heading; the markdown extractor must too.
    expect(extractTitleFromBlocks(blocks)).toBe("Heading later");
    expect(extractTitleMarkdownFromBlocks(blocks, schema)).toBe(
      "Heading *later*",
    );
  });

  it("falls back to the first non-empty paragraph like the plain extractor", () => {
    expect(titleMd("\n\nSome `code` note\n")).toBe("Some `code` note");
  });

  it("returns empty string for an empty document", () => {
    expect(titleMd("")).toBe("");
    expect(titleMd("\n\n")).toBe("");
  });

  it("truncates plain text at the visible-length cap", () => {
    const long = "a".repeat(150);
    expect(titleMd(`# ${long}`, 100)).toBe("a".repeat(100));
  });

  it("keeps a formatted run whole instead of slicing its delimiters", () => {
    // 95 plain chars, then a 10-char bold run: slicing at 100 would cut the
    // bold source in half; the whole run is emitted (soft overflow).
    const md = `# ${"a".repeat(95)}**bbbbbbbbbb**`;
    expect(titleMd(md, 100)).toBe(`${"a".repeat(95)}**bbbbbbbbbb**`);
  });

  it("stops before a formatted run that would grossly overflow the cap", () => {
    const latex = "x".repeat(60);
    const md = `# ${"a".repeat(20)}$${latex}$`;
    // 20 + 60 > 2 × 30, so the math run is dropped rather than sliced.
    expect(titleMd(md, 30)).toBe("a".repeat(20));
  });

  it("counts a formatted run's cost by visible text, not delimiter length", () => {
    expect(titleMd("# **bold** and $x+y$ tail", 100)).toBe(
      "**bold** and $x+y$ tail",
    );
  });

  it("projects a math title block as an inline math run", () => {
    // A document whose first content is a display equation: its LaTeX must
    // come back as `$…$` so previews typeset it, never as bare source.
    expect(titleMd("$$\n\\dot{a}\\ aa\\degree C\n$$")).toBe(
      "$\\dot{a}\\ aa\\degree C$",
    );
  });

  it("drops a projected block that grossly overflows the cap", () => {
    const latex = "x".repeat(70);
    expect(titleMd(`$$\n${latex}\n$$`, 30)).toBe("");
  });
});

describe("title markdown → preview HTML (the TitlePreview pipeline)", () => {
  it("renders marks as HTML and math as typeset SVG, never raw LaTeX", () => {
    // The persisted titleMd record string, re-parsed the way a preview does.
    // The chip's flat text is only the anchor char; its LaTeX lives in the
    // attachment, so the preview must hand the block's structured content in.
    const md = titleMd("# The **famous** $E=mc^2$ law");
    const block = findTitleBlock(loadPage(md, schema).blocks)!;
    const html = inlineToHtml(
      block.charRuns ?? [],
      block.formats ?? [],
      schema,
      (_type, source, displayMode) => renderToSVG(source, displayMode, 14),
      undefined,
      block.structuredContent,
    );
    expect(html).toContain("<strong>famous</strong>");
    expect(html).toContain("<svg");
    // The formula must be typeset, not shown as its canonical source.
    expect(html).not.toContain("m{c}^{2}");
  });

  it("typesets a math-block title end to end", () => {
    // Doc whose title block IS a display equation → titleMd `$…$` (canonical
    // source) → the preview re-parse yields an inline math run and typesets it.
    const md = titleMd("$$\nE=mc^2\n$$");
    expect(md).toBe("$E=m{c}^{2}$");
    const block = findTitleBlock(loadPage(md, schema).blocks)!;
    const html = inlineToHtml(
      block.charRuns ?? [],
      block.formats ?? [],
      schema,
      (_type, source, displayMode) => renderToSVG(source, displayMode, 14),
      undefined,
      block.structuredContent,
    );
    expect(html).toContain("<svg");
    expect(html).not.toContain("m{c}^{2}");
  });
});
