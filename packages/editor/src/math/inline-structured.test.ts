import { STRUCTURED_MARK_ANCHOR_CHAR } from "../feature-facets";
import type { MarkSpan } from "../serlization/loadPage";
import { createDeterministicIdentityAllocator } from "../sync/id";
import {
  createStructuredMathMarkAttachment,
  type InlineMathHostBlock,
  resolveStructuredInlineMathRuns,
} from "./inline-structured";
import { parseMathDocumentInit } from "./structured";
import { describe, expect, it } from "vitest";

function span(
  start: string,
  end: string,
  attrs?: Record<string, unknown>,
): MarkSpan {
  return {
    startCharId: start,
    endCharId: end,
    format: { type: "math", ...(attrs ? { attrs } : {}) },
    clock: { peerId: "author", counter: 0 },
  };
}

/** "a￼b" with the math mark on the anchor char (`author:1`). */
function chipBlock(
  attrs: Record<string, unknown> | undefined,
  structuredContent: InlineMathHostBlock["structuredContent"],
): InlineMathHostBlock {
  return {
    id: "block:1",
    charRuns: [
      {
        peerId: "author",
        startCounter: 0,
        text: `a${STRUCTURED_MARK_ANCHOR_CHAR}b`,
      },
    ],
    formats: [span("author:1", "author:1", attrs)],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

describe("structured inline math attachments", () => {
  it("allocates new marks and their tree from one generic identity source", () => {
    const created = createStructuredMathMarkAttachment(
      "\\frac{a}{b}",
      createDeterministicIdentityAllocator("author"),
    );

    expect(created.contentId).toBe("author:0");
    expect(created.format).toEqual({
      type: "math",
      attrs: { contentId: "author:0" },
    });
    expect(created.init.document.rootId).toBe("author:0");
    // Inline attachments are supplemental: they never claim block authority.
    expect(created.init.document.authority).toBeUndefined();
    expect(
      Object.keys(created.init.document.nodes).some((id) =>
        id.startsWith("author:"),
      ),
    ).toBe(true);
  });

  it("resolves an anchor char to its attachment's canonical source", () => {
    const created = createStructuredMathMarkAttachment(
      "\\frac{a}{b}",
      createDeterministicIdentityAllocator("tree"),
    );
    const block = chipBlock(
      { contentId: created.contentId },
      { [created.contentId]: created.init.document },
    );

    const runs = resolveStructuredInlineMathRuns(block);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    // The chip's flat projection is exactly one char.
    expect(run.startIndex).toBe(1);
    expect(run.endIndex).toBe(2);
    expect(run.charIds).toEqual(["author:1"]);
    expect(run.contentId).toBe(created.contentId);
    expect(run.document).toBeDefined();
    expect(run.latex).toBe("\\frac{a}{b}");
  });

  it("reports a broken attachment reference as latex: undefined", () => {
    // A mark whose contentId resolves to nothing: the run survives (so the
    // host can render an error chip and delete it whole) but carries no
    // document and no source — there is no flat-text fallback.
    const dangling = resolveStructuredInlineMathRuns(
      chipBlock({ contentId: "ghost:0" }, undefined),
    );
    expect(dangling).toHaveLength(1);
    expect(dangling[0].contentId).toBe("ghost:0");
    expect(dangling[0].document).toBeUndefined();
    expect(dangling[0].latex).toBeUndefined();

    // A mark that never persisted a contentId is equally broken.
    const missing = resolveStructuredInlineMathRuns(
      chipBlock(undefined, undefined),
    );
    expect(missing).toHaveLength(1);
    expect(missing[0].contentId).toBeUndefined();
    expect(missing[0].latex).toBeUndefined();
  });

  it("rejects a referenced attachment that claims block authority", () => {
    // Display equations own their block; an inline mark must never adopt one
    // (e.g. a corrupted reference to a math block's document).
    const contentId = "author:4";
    const authoritative = parseMathDocumentInit("x", { contentId });
    expect(authoritative.document.authority).toBe("block");

    const runs = resolveStructuredInlineMathRuns(
      chipBlock({ contentId }, { [contentId]: authoritative.document }),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0].contentId).toBe(contentId);
    expect(runs[0].document).toBeUndefined();
    expect(runs[0].latex).toBeUndefined();
  });
});
