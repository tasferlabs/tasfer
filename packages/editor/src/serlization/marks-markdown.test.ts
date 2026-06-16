/**
 * Inline-mark markdown round-trips through the schema-driven MarkCodec path
 * (parser token → mark type on the way in, `MarkCodec.toMarkdown` on the way
 * out). Guards the Stage-3 change that replaced the per-mark `format.type ===`
 * if/else chains in the parser and markdown serializer with codec dispatch.
 */

import { serializeToHTML } from "./htmlSerializer";
import { loadPage } from "./loadPage";
import { serializeToMarkdown } from "./serializer";
import { describe, expect, it } from "vitest";

/** Parse markdown, then re-serialize it — should be a fixed point. */
function roundTrip(md: string): string {
  return serializeToMarkdown(loadPage(md).blocks);
}

describe("inline mark markdown round-trip", () => {
  it.each([
    ["strong", "Hello **bold** world."],
    ["emphasis", "Hello *italic* world."],
    ["strike", "Hello ~~struck~~ world."],
    ["code", "Run `npm test` now."],
    ["inline math", "Euler: $e^{i\\pi}+1=0$ done."],
    ["link", "See [the docs](https://example.com) here."],
  ])("round-trips %s", (_name, md) => {
    expect(roundTrip(md)).toBe(md);
  });

  it("round-trips several marks in one paragraph", () => {
    const md = "A **b** and *i* and `c` and [l](https://x.y).";
    expect(roundTrip(md)).toBe(md);
  });
});

describe("link target parsing (defuddle / Turndown output forms)", () => {
  it("drops the link title so it doesn't leak into the URL", () => {
    expect(
      roundTrip('See [the docs](https://example.com "Documentation").'),
    ).toBe("See [the docs](https://example.com).");
    // Single-quoted and parenthesised titles too.
    expect(roundTrip("[a](https://x.y 'T').")).toBe("[a](https://x.y).");
    expect(roundTrip("[a](https://x.y (T)).")).toBe("[a](https://x.y).");
  });

  it("keeps balanced parentheses inside the URL", () => {
    const md = "[Bar](https://en.wikipedia.org/wiki/Bar_(disambiguation)).";
    expect(roundTrip(md)).toBe(md);
  });

  it("unescapes backslash-escaped parentheses in the URL", () => {
    expect(roundTrip("[Bar](https://en.wikipedia.org/wiki/Bar_\\(x\\)).")).toBe(
      "[Bar](https://en.wikipedia.org/wiki/Bar_(x)).",
    );
  });

  it("parses angle-bracketed URLs", () => {
    expect(roundTrip("[a](<https://x.y/a b>).")).toBe("[a](https://x.y/a b).");
  });

  it("reduces a linked image to its alt text", () => {
    expect(roundTrip("[![logo](https://img.test/l.png)](https://x.y)")).toBe(
      "[logo](https://x.y)",
    );
  });

  it("allows nested brackets in link text", () => {
    expect(roundTrip("[a [b] c](https://x.y)")).toBe("[a [b] c](https://x.y)");
  });

  it("leaves a non-link [text] untouched", () => {
    expect(roundTrip("a [not a link] b")).toBe("a [not a link] b");
  });
});

describe("inline mark HTML output (via MarkCodec.html)", () => {
  const html = (md: string) => serializeToHTML(loadPage(md).blocks);

  it.each([
    ["strong", "**bold**", "<strong>bold</strong>"],
    ["emphasis", "*italic*", "<em>italic</em>"],
    ["strike", "~~struck~~", "<s>struck</s>"],
    ["code", "`snippet`", "<code>snippet</code>"],
    [
      "link",
      "[docs](https://example.com)",
      '<a href="https://example.com">docs</a>',
    ],
  ])("emits %s", (_name, md, fragment) => {
    expect(html(md)).toContain(fragment);
  });

  it("nests code innermost under strong (preserved order)", () => {
    // `**` opens strong, `` ` `` opens code over the same run.
    expect(html("**`x`**")).toContain("<strong><code>x</code></strong>");
  });
});
