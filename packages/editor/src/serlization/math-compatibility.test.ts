import { baseSchema } from "../schema";
import { serializeToHTML } from "./htmlSerializer";
import { loadPage } from "./loadPage";
import parsePage from "./parser";
import { serializeToMarkdown } from "./serializer";
import tokenizePage from "./tokenizer";
import { describe, expect, it } from "vitest";

describe("schema-optional math compatibility", () => {
  const source = "Euler: $e^{i\\pi}+1=0$.\n$$\n\\frac{1}{2}\n$$";

  it("keeps the composable base schema math-free", () => {
    expect(baseSchema.data.hasBlock("math")).toBe(false);
    expect(baseSchema.data.hasMark("math")).toBe(false);
  });

  it("loads and Markdown-serializes legacy math without options", () => {
    const page = loadPage(source);

    expect(page.blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "math",
    ]);
    expect(
      "formats" in page.blocks[0]
        ? page.blocks[0].formats.some((span) => span.format.type === "math")
        : false,
    ).toBe(true);
    expect(serializeToMarkdown(page.blocks)).toBe(source);
  });

  it("keeps the schema-optional tokenizer/parser pipeline compatible", () => {
    const page = parsePage(tokenizePage(source));

    expect(page.blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "math",
    ]);
    expect(serializeToMarkdown(page.blocks)).toBe(source);
  });

  it("renders inline and display math to SVG in default HTML output", () => {
    const html = serializeToHTML(loadPage(source).blocks);

    expect(html.match(/<svg/g)).toHaveLength(2);
    expect(html).not.toContain("<code>$e^{i\\pi}+1=0$</code>");
    expect(html).not.toContain("<code>\\frac{1}{2}</code>");
  });

  it("honors an explicit math-free schema", () => {
    const page = loadPage(source, baseSchema.data);

    expect(
      page.blocks.every(
        (block) => (block as { readonly type: string }).type !== "math",
      ),
    ).toBe(true);
    expect(
      serializeToMarkdown(page.blocks, undefined, { schema: baseSchema.data }),
    ).toBe(source);
  });
});
