/**
 * `needsCommandSeparator` — the live-editor guard that stops a letter typed
 * right after a complete command from being swallowed into its name (`\oint` +
 * `x` → the unknown `\ointx`). It must fire for a finished command but stay out
 * of the way while a command (including a prefix-sharing one) is still typed.
 */
import { describe, expect, it } from "vitest";
import { needsCommandSeparator, parse, pendingCommandRange } from "./parser.ts";
import type { Node } from "./ast.ts";
import { layoutMath } from "../index.ts";

/** Names of every `unknown` (unresolved/literal) command anywhere in the tree. */
function unknownNames(node: Node): string[] {
  const out: string[] = [];
  const visit = (n: Node): void => {
    if (n.type === "unknown") out.push(n.name);
    else if (n.type === "ord" || n.type === "leftright" || n.type === "style") {
      n.body.forEach(visit);
    } else if (n.type === "supsub") {
      [n.base, n.sup, n.sub].forEach((c) => c && visit(c));
    }
  };
  visit(node);
  return out;
}

/** Caret sits at the end of `latex`; type `char` there. */
const sep = (latex: string, char: string) =>
  needsCommandSeparator(latex, latex.length, char);

describe("needsCommandSeparator", () => {
  it("separates a letter typed after a complete operator", () => {
    expect(sep("\\oint", "x")).toBe(true);
    expect(sep("\\alpha", "x")).toBe(true);
    expect(sep("\\times", "y")).toBe(true);
  });

  it("does NOT separate while still typing the command", () => {
    // "\al" is not a command yet (en route to \alpha).
    expect(sep("\\al", "p")).toBe(false);
    // "\oin" → "\oint" completes a command.
    expect(sep("\\oin", "t")).toBe(false);
  });

  it("does NOT interrupt a prefix-sharing command", () => {
    // \in is complete (∈) but \inf/\infty are longer commands — keep typing.
    expect(sep("\\in", "f")).toBe(false);
    expect(sep("\\inf", "t")).toBe(false);
    // \sin → \sinh.
    expect(sep("\\sin", "h")).toBe(false);
  });

  it("separates once the command can't grow any further", () => {
    expect(sep("\\infty", "x")).toBe(true);
    expect(sep("\\sinh", "x")).toBe(true);
  });

  it("only triggers on letters — digits/symbols terminate a command anyway", () => {
    expect(sep("\\oint", "2")).toBe(false);
    expect(sep("\\oint", "+")).toBe(false);
    expect(sep("\\oint", "_")).toBe(false);
  });

  it("ignores positions that aren't right after a control word", () => {
    expect(sep("x", "y")).toBe(false);
    expect(sep("ab", "c")).toBe(false);
    // After a line break `\\`, the trailing letters are ordinary atoms.
    expect(needsCommandSeparator("\\\\oint", 6, "x")).toBe(false);
  });

  it("works mid-string, not just at the end", () => {
    // "\oint+1", caret right after \oint (offset 5), type x.
    expect(needsCommandSeparator("\\oint+1", 5, "x")).toBe(true);
  });
});

describe("pendingCommandRange", () => {
  it("spans the `\\`+letters run ending at the caret", () => {
    // "\al" being typed: caret at 3 → the whole `\al` is in progress.
    expect(pendingCommandRange("\\al", 3)).toEqual({ start: 0, end: 3 });
    expect(pendingCommandRange("\\al", 1)).toEqual({ start: 0, end: 1 });
  });

  it("is null when the caret isn't at a control word's trailing edge", () => {
    expect(pendingCommandRange("\\al", 0)).toBeNull(); // before the `\`
    expect(pendingCommandRange("x+y", 3)).toBeNull(); // plain text
    // After a line break `\\`, trailing letters are ordinary atoms.
    expect(pendingCommandRange("\\\\al", 4)).toBeNull();
  });

  it("locates a command mid-string", () => {
    // "a\alb" — caret right after `\al` (offset 4).
    expect(pendingCommandRange("a\\al", 4)).toEqual({ start: 1, end: 4 });
  });
});

describe("parse literalRange — in-progress command stays literal", () => {
  it("resolves a complete command normally without a literalRange", () => {
    // `\in` is a real command (∈) — it must NOT be an unknown placeholder.
    expect(unknownNames(parse("\\in"))).toEqual([]);
  });

  it("keeps the marked command unresolved (literal) so it renders as source", () => {
    // The caller marks `\in` as still-being-typed (its `\` at offset 0): it
    // parses as a literal `unknown` instead of flashing the ∈ symbol.
    const range = pendingCommandRange("\\in", 3)!;
    expect(unknownNames(parse("\\in", { literalRange: range }))).toEqual(["in"]);
  });

  it("only affects the command whose `\\` sits at literalRange.start", () => {
    // A range pointing elsewhere leaves the command resolved.
    expect(unknownNames(parse("\\in", { literalRange: { start: 5, end: 8 } }))).toEqual([]);
    // Mid-string: `x+\in`, the `\` is at offset 2.
    const r = pendingCommandRange("x+\\in", 5)!;
    expect(unknownNames(parse("x+\\in", { literalRange: r }))).toEqual(["in"]);
  });

  it("leaves a following committed command resolved", () => {
    // `\in\int` while typing the first one — only `\in` goes literal; the
    // second stays a resolved operator (so the geometry of the rest is intact).
    const r = { start: 0, end: 3 };
    expect(unknownNames(parse("\\in\\int", { literalRange: r }))).toEqual(["in"]);
  });

  it("makes the literal command wider than its resolved symbol", () => {
    // The whole point: literal `\in` (3 glyphs) advances wider than ∈ (1), so
    // measuring with the range reserves the room the painted source needs.
    const resolved = layoutMath("\\in", { fontSize: 20 });
    const literal = layoutMath("\\in", {
      fontSize: 20,
      literalRange: { start: 0, end: 3 },
    });
    expect(literal.width).toBeGreaterThan(resolved.width);
  });
});
