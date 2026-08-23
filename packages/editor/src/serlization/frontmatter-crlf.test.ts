import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./loadPage";

const BODY = "# Hello\n\nStart typing.";

describe("parseFrontmatter line endings", () => {
  it("parses LF frontmatter", () => {
    const { content, metadata } = parseFrontmatter(
      `---\ntask: true\ncolor: red\n---\n${BODY}`,
    );
    expect(metadata).toEqual({ task: true, color: "red" });
    expect(content).toBe(BODY);
  });

  it("parses CRLF frontmatter", () => {
    const { content, metadata } = parseFrontmatter(
      `---\r\ntask: true\r\ncolor: red\r\n---\r\n# Hello\r\n`,
    );
    expect(metadata).toEqual({ task: true, color: "red" });
    expect(content).toBe("# Hello\r\n");
  });

  it("leaves content untouched without a closing fence", () => {
    const input = `---\r\ntask: true\r\n${BODY}`;
    expect(parseFrontmatter(input)).toEqual({ content: input });
  });

  it("ignores a leading rule that is not frontmatter", () => {
    const input = `---\r\n\r\n${BODY}`;
    expect(parseFrontmatter(input)).toEqual({ content: input });
  });
});
