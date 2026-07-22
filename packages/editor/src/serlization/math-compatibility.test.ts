/**
 * Schema-optional math compatibility — the default (no-schema) serializer
 * entry points must keep handling math documents, because persistence and
 * tooling call them without wiring a schema. Import is eager: `$…$` becomes
 * one anchor char plus a supplemental tree attachment, `$$…$$` a math block
 * whose only content is its block-authority document.
 */

import { STRUCTURED_MARK_ANCHOR_CHAR } from "../feature-facets";
import { mathContentIdForBlock } from "../math/structured";
import { baseSchema } from "../schema";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { serializeToHTML } from "./htmlSerializer";
import { loadPage } from "./loadPage";
import parsePage from "./parser";
import { serializeToMarkdown } from "./serializer";
import tokenizePage from "./tokenizer";
import { describe, expect, it } from "vitest";

describe("schema-optional math compatibility", () => {
  const source = "Euler: $e^{i\\pi}+1=0$.\n$$\n\\frac{1}{2}\n$$";
  // Export prints each tree's CANONICAL source (`e^{i\pi}` → `{e}^{i\pi}`),
  // so one import/export pass canonicalizes; the canonical text itself is a
  // serialization fixed point.
  const canonical = "Euler: ${e}^{i\\pi}+1=0$.\n$$\n\\frac{1}{2}\n$$\n";

  it("keeps the composable base schema math-free", () => {
    expect(baseSchema.data.hasBlock("math")).toBe(false);
    expect(baseSchema.data.hasMark("math")).toBe(false);
  });

  it("loads math eagerly and Markdown-serializes it without options", () => {
    const page = loadPage(source);

    expect(page.blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "math",
    ]);

    // The inline formula collapses to one anchor char whose mark references
    // a supplemental attachment minted in the same import.
    const paragraph = page.blocks[0];
    if (!("charRuns" in paragraph) || !("formats" in paragraph)) {
      throw new Error("expected a textual paragraph");
    }
    expect(getVisibleTextFromRuns(paragraph.charRuns)).toBe(
      `Euler: ${STRUCTURED_MARK_ANCHOR_CHAR}.`,
    );
    const span = paragraph.formats.find((s) => s.format.type === "math");
    const contentId = span?.format.attrs?.contentId;
    expect(typeof contentId).toBe("string");
    expect(paragraph.structuredContent?.[contentId as string]).toBeDefined();

    // The display equation owns no flat chars; its content is the
    // block-authority document.
    const math = page.blocks[1];
    expect(
      "charRuns" in math ? getVisibleTextFromRuns(math.charRuns) : null,
    ).toBe("");
    expect(
      math.structuredContent?.[mathContentIdForBlock(math.id)]?.authority,
    ).toBe("block");

    expect(serializeToMarkdown(page.blocks)).toBe(canonical);
    expect(serializeToMarkdown(loadPage(canonical).blocks)).toBe(canonical);
  });

  it("keeps the schema-optional tokenizer/parser pipeline compatible", () => {
    const page = parsePage(tokenizePage(source));

    expect(page.blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "math",
    ]);
    expect(serializeToMarkdown(page.blocks)).toBe(canonical);
  });

  it("renders inline and display math to SVG in default HTML output", () => {
    // The display block sits mid-document: the fragment serializer trims
    // leading/trailing empty-charRuns textual blocks, and a math block's flat
    // text is always empty (its content lives in the attachment).
    const html = serializeToHTML(loadPage(`${source}\n\ntail.`).blocks);

    expect(html.match(/<svg/g)).toHaveLength(2);
    // Neither formula degraded to the unrendered <code> fallback.
    expect(html).not.toContain("<code>");
  });

  it("honors an explicit math-free schema", () => {
    const page = loadPage(source, baseSchema.data);

    expect(
      page.blocks.every(
        (block) => (block as { readonly type: string }).type !== "math",
      ),
    ).toBe(true);
    // Without math installed the dollars are plain text and round-trip as-is.
    expect(
      serializeToMarkdown(page.blocks, undefined, { schema: baseSchema.data }),
    ).toBe(source);
  });
});
