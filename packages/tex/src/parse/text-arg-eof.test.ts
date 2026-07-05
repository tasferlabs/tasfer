/**
 * Regression: an argument-less text-mode command sitting at end-of-source must
 * not crash the parser. `\text` (and the whole `\textbf`/`\operatorname` family)
 * reads a raw-text argument; when the command is typed but its `{…}` has not been
 * materialized yet (`\text` alone, or flush before a group closer), the reader
 * used to consume the terminal `eof` sentinel as a one-token argument, pushing the
 * position past the token array so the next `peek()` returned `undefined` and the
 * parser threw. The parser is contractually error-tolerant, so a missing argument
 * must degrade to an empty text run instead.
 */
import { parse } from "./parser";
import { describe, expect, it } from "vitest";

describe("text-mode command with no argument at EOF", () => {
  const cmds = [
    "\\text",
    "\\textbf",
    "\\textit",
    "\\texttt",
    "\\mathrm",
    "\\operatorname",
    "\\operatornamewithlimits",
  ];

  for (const cmd of cmds) {
    it(`parses ${cmd} at end-of-source without crashing`, () => {
      expect(() => parse(cmd)).not.toThrow();
    });

    it(`parses ${cmd} flush before a group closer without crashing`, () => {
      // e.g. `{\text}` — the command's argument slot is empty, the next token is
      // the group's `}`, which must NOT be consumed as its argument.
      expect(() => parse(`{${cmd}}`)).not.toThrow();
    });
  }

  it("keeps parsing content that FOLLOWS an argument-less \\text", () => {
    // The stuck-at-EOF hazard also corrupted anything after the command; guard
    // that a following atom still parses (here inside a group so `\text` is not
    // itself the last token).
    const node = parse("{\\text}x");
    expect(node.type).toBe("ord");
    // Two top-level atoms survive: the (empty) text group and the `x`.
    expect((node as { body: unknown[] }).body.length).toBe(2);
  });

  it("still reads a real single-token argument (`\\text x`)", () => {
    const node = parse("\\text x") as {
      body: Array<{ type: string; text?: string }>;
    };
    const textNode = node.body.find((n) => n.type === "text");
    expect(textNode?.text).toBe("x");
  });
});
