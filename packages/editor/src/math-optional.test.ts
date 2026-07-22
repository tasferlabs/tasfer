import { mathExtension } from "./math-extension";
import { baseSchema } from "./schema";
import parsePage from "./serlization/parser";
import { serializeToMarkdown } from "./serlization/serializer";
import tokenizePage from "./serlization/tokenizer";
import { describe, expect, it } from "vitest";

describe("optional math feature", () => {
  it("is absent from the base schema and available through composition", () => {
    expect(baseSchema.data.hasBlock("math")).toBe(false);
    expect(baseSchema.data.hasMark("math")).toBe(false);

    const withMath = baseSchema.use(mathExtension());
    expect(withMath.data.hasBlock("math")).toBe(true);
    expect(withMath.data.hasMark("math")).toBe(true);
  });

  it("preserves display-math source literally when math is not installed", () => {
    const source = "$$\n\\frac{1}{2}\n$$";
    const page = parsePage(
      tokenizePage(source, baseSchema.data),
      baseSchema.data,
    );

    expect(page.blocks[0].type).toBe("paragraph");
    expect(
      serializeToMarkdown(page.blocks, undefined, { schema: baseSchema.data }),
    ).toBe(source);
  });

  it("parses the same display source when math is installed", () => {
    const source = "$$\n\\frac{1}{2}\n$$";
    const schema = baseSchema.use(mathExtension()).data;
    const page = parsePage(tokenizePage(source, schema), schema);

    expect(page.blocks[0].type).toBe("math");
    expect(serializeToMarkdown(page.blocks, undefined, { schema })).toBe(
      source,
    );
  });

  it("keeps inline delimiters as text without the math mark", () => {
    const source = "Euler: $e^{i\\pi}+1=0$.";
    const page = parsePage(
      tokenizePage(source, baseSchema.data),
      baseSchema.data,
    );

    expect(
      serializeToMarkdown(page.blocks, undefined, { schema: baseSchema.data }),
    ).toBe(source);
  });
});
