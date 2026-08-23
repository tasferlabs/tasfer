/**
 * Math is opt-in, end to end. The schema-optional serializer entry points parse
 * and print the CORE set, so a host that never installs math never pulls the
 * math codecs (or `@tasfer/tex`) into its bundle; `getCompatibilityDataSchema()`
 * from `@tasfer/math` restores the pre-split behavior for callers that
 * want it. With it installed, import is eager: `$…$` becomes one anchor char
 * plus a supplemental tree attachment, `$$…$$` a math block whose only content
 * is its block-authority document.
 */

import { getCompatibilityDataSchema, mathReplacementRenderer } from "./compat";
import { mathContentIdForBlock } from "./structured";
import { STRUCTURED_MARK_ANCHOR_CHAR } from "@tasfer/editor/feature-facets";
import { baseSchema } from "@tasfer/editor/schema";
import { serializeToHTML } from "@tasfer/editor/serlization/htmlSerializer";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import parsePage from "@tasfer/editor/serlization/parser";
import { serializeToMarkdown } from "@tasfer/editor/serlization/serializer";
import tokenizePage from "@tasfer/editor/serlization/tokenizer";
import { getVisibleTextFromRuns } from "@tasfer/editor/sync/char-runs";
import { describe, expect, it } from "vitest";

describe("schema-optional math compatibility", () => {
  const compat = getCompatibilityDataSchema();
  const source = "Euler: $e^{i\\pi}+1=0$.\n$$\n\\frac{1}{2}\n$$";
  // Export prints each tree's CANONICAL source (`e^{i\pi}` → `{e}^{i\pi}`),
  // so one import/export pass canonicalizes; the canonical text itself is a
  // serialization fixed point.
  const canonical = "Euler: ${e}^{i\\pi}+1=0$.\n$$\n\\frac{1}{2}\n$$\n";

  it("keeps the composable base schema math-free", () => {
    expect(baseSchema.data.hasBlock("math")).toBe(false);
    expect(baseSchema.data.hasMark("math")).toBe(false);
  });

  it("leaves math untouched when no schema is passed", () => {
    // The schema-optional default is the core set, so the dollars are ordinary
    // text: no math block, no math mark, and the source round-trips verbatim.
    const page = loadPage(source);

    expect(
      page.blocks.every(
        (block) => (block as { readonly type: string }).type !== "math",
      ),
    ).toBe(true);
    expect(serializeToMarkdown(page.blocks)).toBe(source);
  });

  it("loads math eagerly and Markdown-serializes it under the compat schema", () => {
    const page = loadPage(source, compat);

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

    const opts = { schema: compat };
    expect(serializeToMarkdown(page.blocks, undefined, opts)).toBe(canonical);
    expect(
      serializeToMarkdown(loadPage(canonical, compat).blocks, undefined, opts),
    ).toBe(canonical);
  });

  it("keeps the tokenizer/parser pipeline compatible", () => {
    const page = parsePage(tokenizePage(source, compat), compat);

    expect(page.blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "math",
    ]);
    expect(
      serializeToMarkdown(page.blocks, undefined, { schema: compat }),
    ).toBe(canonical);
  });

  it("renders inline and display math to SVG with the math renderer", () => {
    // The display block sits mid-document: the fragment serializer trims
    // leading/trailing empty-charRuns textual blocks, and a math block's flat
    // text is always empty (its content lives in the attachment).
    const html = serializeToHTML(
      loadPage(`${source}\n\ntail.`, compat).blocks,
      {
        schema: compat,
        renderReplacement: mathReplacementRenderer,
      },
    );

    expect(html.match(/<svg/g)).toHaveLength(2);
    // Neither formula degraded to the unrendered <code> fallback.
    expect(html).not.toContain("<code>");
  });

  it("emits math source, not SVG, when no renderer is supplied", () => {
    // Core never reaches for a renderer of its own: with none passed the math
    // codecs fall back to their LaTeX source.
    const html = serializeToHTML(
      loadPage(`${source}\n\ntail.`, compat).blocks,
      {
        schema: compat,
      },
    );

    expect(html).not.toContain("<svg");
    expect(html).toContain("\\frac{1}{2}");
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
