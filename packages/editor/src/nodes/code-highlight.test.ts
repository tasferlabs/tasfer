import { type CodeToken, highlightLine } from "./code-highlight";
import { describe, expect, it } from "vitest";

/** The concatenated token text must always reconstruct the input exactly. */
function expectLossless(line: string, language: string): CodeToken[] {
  const tokens = highlightLine(line, language);
  expect(tokens.map((t) => t.text).join("")).toBe(line);
  return tokens;
}

/** Kind of the first token whose (trimmed) text equals `text`. */
function kindOf(tokens: CodeToken[], text: string): string | undefined {
  return tokens.find((t) => t.text.trim() === text)?.kind;
}

describe("highlightLine", () => {
  it("colors keywords, numbers and strings (js)", () => {
    const tokens = expectLossless('const x = 42 + "hi"', "javascript");
    expect(kindOf(tokens, "const")).toBe("keyword");
    expect(kindOf(tokens, "42")).toBe("number");
    expect(tokens.find((t) => t.text.includes('"hi"'))?.kind).toBe("string");
  });

  it("treats an identifier before '(' as a function call", () => {
    const tokens = highlightLine("foo(bar)", "javascript");
    expect(kindOf(tokens, "foo")).toBe("function");
  });

  it("colors a line comment to end of line", () => {
    const tokens = expectLossless("x = 1 // done", "javascript");
    expect(tokens.at(-1)).toEqual({ text: "// done", kind: "comment" });
  });

  it("colors a block comment", () => {
    const tokens = expectLossless("a /* c */ b", "javascript");
    expect(tokens.find((t) => t.kind === "comment")?.text).toBe("/* c */");
  });

  it("uses python keywords for python", () => {
    const tokens = expectLossless("def f(): return None", "python");
    expect(kindOf(tokens, "def")).toBe("keyword");
    expect(kindOf(tokens, "return")).toBe("keyword");
    // `None` is a literal — folded onto the keyword color.
    expect(kindOf(tokens, "None")).toBe("keyword");
  });

  it("handles '#' comments in python (not c-family)", () => {
    const tokens = expectLossless("x = 1 # note", "python");
    expect(tokens.at(-1)).toEqual({ text: "# note", kind: "comment" });
  });

  it("renders an empty language as a single plain token", () => {
    const tokens = expectLossless('const "s"', "");
    expect(tokens).toEqual([{ text: 'const "s"', kind: "plain" }]);
  });

  it("renders an unknown language as a single plain token", () => {
    const tokens = expectLossless("whatever 123", "not-a-language");
    expect(tokens).toEqual([{ text: "whatever 123", kind: "plain" }]);
  });

  it("resolves a language alias to its grammar", () => {
    // "js" → javascript: still gets real keyword coloring (not plain).
    const tokens = expectLossless("const x = 1", "js");
    expect(kindOf(tokens, "const")).toBe("keyword");
  });

  it("returns no tokens for an empty line", () => {
    expect(highlightLine("", "javascript")).toEqual([]);
  });

  it("merges adjacent plain runs into one token", () => {
    const tokens = highlightLine("x = y", "javascript");
    // No two consecutive tokens share a kind.
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i].kind).not.toBe(tokens[i - 1].kind);
    }
  });
});
