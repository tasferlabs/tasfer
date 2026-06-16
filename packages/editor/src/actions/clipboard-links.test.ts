import { loadPage } from "../serlization/loadPage";
import { serializeToMarkdown } from "../serlization/serializer";
import { flattenBlockLevelLinks } from "./clipboard";
import { describe, expect, it } from "vitest";

/** Round-trip flattened markdown through the parser + serializer. */
function pasteToMarkdown(md: string): string {
  return serializeToMarkdown(loadPage(flattenBlockLevelLinks(md)).blocks);
}

describe("flattenBlockLevelLinks (block-level links from defuddle)", () => {
  it("collapses a heading wrapped in a link into an inline heading link", () => {
    // Exact output defuddle/Turndown emits for <a href><h1>…</h1></a>.
    const md =
      "[\n\n# Introducing Myself and My Blog: A Fellow Creature\n\n](https://www.hamza.se/blog/a-fellow-creature)";
    expect(flattenBlockLevelLinks(md)).toBe(
      "# [Introducing Myself and My Blog: A Fellow Creature](https://www.hamza.se/blog/a-fellow-creature)",
    );
    expect(pasteToMarkdown(md)).toBe(
      "# [Introducing Myself and My Blog: A Fellow Creature](https://www.hamza.se/blog/a-fellow-creature)",
    );
  });

  it("preserves the heading level of the wrapped content", () => {
    expect(
      flattenBlockLevelLinks("[\n\n### Card Title\n\n](https://x.y/card)"),
    ).toBe("### [Card Title](https://x.y/card)");
  });

  it("collapses a paragraph wrapped in a link", () => {
    expect(flattenBlockLevelLinks("[\n\nTeaser text\n\n](https://x.y/p)")).toBe(
      "[Teaser text](https://x.y/p)",
    );
  });

  it("joins multiple inner lines into the link text", () => {
    expect(
      flattenBlockLevelLinks("[\n\nLine one\nLine two\n\n](https://x.y/m)"),
    ).toBe("[Line one Line two](https://x.y/m)");
  });

  it("drops a title on the wrapping link", () => {
    expect(flattenBlockLevelLinks('[\n\n# T\n\n](https://x.y "Tip")')).toBe(
      "# [T](https://x.y)",
    );
  });

  it("leaves ordinary inline links untouched", () => {
    const md = "see [the docs](https://example.com) ok";
    expect(flattenBlockLevelLinks(md)).toBe(md);
  });
});
