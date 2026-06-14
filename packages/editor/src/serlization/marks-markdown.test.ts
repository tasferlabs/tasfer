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
