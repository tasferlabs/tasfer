import { loadPage } from "../serlization/loadPage";
import { serializeToMarkdown } from "../serlization/serializer";
import { flattenBlockLevelLinks, stripFragmentLinks } from "./clipboard";
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

describe("stripFragmentLinks (in-page anchor links from defuddle)", () => {
  it("unwraps a TOC link to its text", () => {
    expect(stripFragmentLinks("see [Introduction](#intro) below")).toBe(
      "see Introduction below",
    );
  });

  it("drops a heading permalink marker entirely", () => {
    expect(stripFragmentLinks("## Overview [#](#overview)")).toBe(
      "## Overview ",
    );
    expect(stripFragmentLinks("## Overview [¶](#overview)")).toBe(
      "## Overview ",
    );
  });

  it("drops an empty anchor link", () => {
    expect(stripFragmentLinks("text [](#x) more")).toBe("text  more");
  });

  it("strips an anchor link that carries a title", () => {
    expect(stripFragmentLinks('[Top](#top "Back to top")')).toBe("Top");
  });

  it("handles a bare `#` fragment", () => {
    expect(stripFragmentLinks("[Skip](#)")).toBe("Skip");
  });

  it("unwraps a full URL that carries a fragment (section self-link)", () => {
    expect(
      stripFragmentLinks(
        "# [Training a neural network](https://www.hamza.se/blog/neural-networks#training-a-neural-network)",
      ),
    ).toBe("# Training a neural network");
  });

  it("leaves fragment-less URLs untouched", () => {
    const md = "see [the docs](https://example.com/page) ok";
    expect(stripFragmentLinks(md)).toBe(md);
  });

  it("leaves images with a fragment src untouched", () => {
    const md = "![diagram](https://x.y/d#fig1)";
    expect(stripFragmentLinks(md)).toBe(md);
  });
});
