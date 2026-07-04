/**
 * `needsCommandSeparator` — the live-editor guard that stops a letter typed
 * right after a complete command from being swallowed into its name (`\oint` +
 * `x` → the unknown `\ointx`). It must fire for a finished command but stay out
 * of the way while a command (including a prefix-sharing one) is still typed.
 */
import { describe, expect, it } from "vitest";
import { needsCommandSeparator, parse, pendingCommandRange } from "./parser";
import type { Node } from "./ast";
import { layoutMath } from "../index";

/** Names of every `unknown` (unresolved/literal) command anywhere in the tree. */
function unknownNames(node: Node): string[] {
  const out: string[] = [];
  const visit = (n: Node): void => {
    if (n.type === "unknown") out.push(n.name);
    else if (n.type === "ord" || n.type === "leftright" || n.type === "style") {
      n.body.forEach(visit);
    } else if (n.type === "supsub") {
      [n.base, n.sup, n.sub].forEach((c) => c && visit(c));
    } else if (n.type === "frac") {
      visit(n.num);
      visit(n.den);
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

  it("is null for a complete command that can't grow into a longer one", () => {
    // `\frac` is a finished command (not a prefix of anything longer): the caret
    // parked at its trailing edge is NOT typing it. Were it flagged literal, the
    // parser would orphan its `{}{}` arguments and `\frac{dy}{dx}` would
    // de-structure into `\fracdydx`. `\alpha`/`\sum` are likewise terminal.
    expect(pendingCommandRange("\\frac{dy}{dx}", 5)).toBeNull();
    expect(pendingCommandRange("\\alpha", 6)).toBeNull();
    expect(pendingCommandRange("\\sum", 4)).toBeNull();
  });

  it("is null for a caret resting INSIDE a complete command, not just at its edge", () => {
    // Regression: the caret can land between the `\` and the end of `\frac` (e.g.
    // place it before the chip, then type a char). The completeness check must
    // weigh the WHOLE `\frac`, not the prefix up to the caret (`\`, `\f`, `\fr`,
    // `\fra`) — otherwise each interior offset looks like an in-progress command
    // and the fraction flashes literally as `\fracdydx`.
    for (let caret = 1; caret <= 5; caret++) {
      expect(pendingCommandRange("\\frac{dy}{dx}", caret)).toBeNull();
    }
    // `\alpha` likewise: every interior caret resolves, none is pending.
    for (let caret = 1; caret <= 6; caret++) {
      expect(pendingCommandRange("\\alpha", caret)).toBeNull();
    }
  });

  it("stays pending for a complete command still en route to a longer one", () => {
    // `\in` is a real relation (∈) but also a prefix of `\int`/`\infty`, so the
    // caret at its edge could still be mid-type — keep it literal.
    expect(pendingCommandRange("\\in", 3)).toEqual({ start: 0, end: 3 });
  });
});

describe("parse — a complete construct survives the caret at its command edge", () => {
  it("does not de-structure `\\frac{dy}{dx}` into `\\fracdydx`", () => {
    // End-to-end: the renderer derives literalRange from pendingCommandRange.
    // With the caret right after `\frac`, that range is null, so the fraction
    // parses as one `frac` node rather than a literal `\frac` + bare `dy`/`dx`.
    const range = pendingCommandRange("\\frac{dy}{dx}", 5) ?? undefined;
    const root = parse("\\frac{dy}{dx}", { literalRange: range });
    expect(root.type === "ord" && root.body.map((n) => n.type)).toEqual([
      "frac",
    ]);
    expect(unknownNames(root)).toEqual([]);
  });

  it("survives the caret resting INSIDE the command too", () => {
    // The reported bug: caret between the `\` and the end of `\frac`. Every such
    // offset must still parse as one `frac`, never the literal `\fracdydx`.
    for (let caret = 1; caret <= 5; caret++) {
      const range = pendingCommandRange("\\frac{dy}{dx}", caret) ?? undefined;
      const root = parse("\\frac{dy}{dx}", { literalRange: range });
      expect(root.type === "ord" && root.body.map((n) => n.type)).toEqual([
        "frac",
      ]);
      expect(unknownNames(root)).toEqual([]);
    }
  });

  it("typing a `\\` right before an existing `\\frac` keeps the fraction whole", () => {
    // The reported bug: caret before a `\frac{dy}{dx}` construct, type `\`. The
    // source becomes `\\frac{dy}{dx}` and `\\` would lex as a LINE BREAK, leaving
    // `frac{dy}{dx}` to de-structure into the literal `\fracdydx`. The freshly
    // typed `\` is command-entry (its `\` at offset 0), so the lexer must keep it
    // from merging: the in-progress `\` stays a standalone literal and the next
    // `\` still opens an intact `\frac`.
    const range = pendingCommandRange("\\\\frac{dy}{dx}", 1)!; // caret after typed \
    expect(range).toEqual({ start: 0, end: 1 });
    const root = parse("\\\\frac{dy}{dx}", { literalRange: range });
    expect(root.type === "ord" && root.body.map((n) => n.type)).toEqual([
      "unknown", // the in-progress `\`
      "frac", // the still-intact fraction
    ]);
    // The only literal is the in-progress `\` (empty name); `frac` is NOT literal.
    expect(unknownNames(root)).toEqual([""]);
  });

  it("keeps a stray `\\` VISIBLE (and the construct whole) even with no command-entry", () => {
    // After the caret moves on, the typed `\` is no longer command-entry — but it
    // must NOT silently vanish into a `\\` line break and de-structure the
    // fraction. Outside a row environment `\\` never merges: the stray `\` shows
    // as a literal backslash and `\frac{dy}{dx}` stays one `frac`.
    const root = parse("\\\\frac{dy}{dx}");
    expect(root.type === "ord" && root.body.map((n) => n.type)).toEqual([
      "unknown", // the stray `\`, rendered as a visible literal backslash
      "frac", // the intact fraction
    ]);
    expect(unknownNames(root)).toEqual([""]);
  });

  it("typing a `\\` inside a frac argument doesn't steal its closing brace", () => {
    // The reported bug: `\frac{dy|}{dx}`, type `\` (command entry). The fresh
    // `\` would merge with the frac's structural `}` into the single-char
    // command `\}` — swallowing the closer, de-structuring the fraction, and
    // flashing a red right-brace glyph (only the `\` itself is suppressed by
    // the pending range). The command-entry `\` must stay standalone so the
    // `}` keeps closing the numerator.
    const src = "\\frac{dy\\}{dx}";
    const range = pendingCommandRange(src, 9)!; // caret right after the typed \
    expect(range).toEqual({ start: 8, end: 9 });
    const root = parse(src, { literalRange: range });
    expect(root.type === "ord" && root.body.map((n) => n.type)).toEqual([
      "frac",
    ]);
    // The only literal is the in-progress `\`; the frac's brace was NOT eaten.
    expect(unknownNames(root)).toEqual([""]);
  });

  it("typing a `\\` before the denominator's `{` doesn't steal the opener", () => {
    // Same bug, left-brace flavor: `\frac{dy}|{dx}`, type `\`. Merging into
    // `\{` steals the denominator's opening brace and flashes a red left
    // brace. Standalone, the `\` becomes the momentary denominator atom (as
    // any typed char there would) and `{dx}` stays an intact group.
    const src = "\\frac{dy}\\{dx}";
    const range = pendingCommandRange(src, 10)!;
    expect(range).toEqual({ start: 9, end: 10 });
    const root = parse(src, { literalRange: range });
    expect(root.type === "ord" && root.body.map((n) => n.type)).toEqual([
      "frac",
      "ord",
    ]);
    expect(unknownNames(root)).toEqual([""]);
  });

  it("a deliberate escaped brace still resolves outside command entry", () => {
    // Once the user actually types the brace (caret moves past it, command
    // entry ends), `\{`/`\}` lex as one command and typeset as brace glyphs.
    expect(unknownNames(parse("\\{x\\}"))).toEqual([]);
  });

  it("`\\\\` is STILL a row separator inside a tabular environment", () => {
    // The split is scoped to outside-environment `\\`. A matrix/aligned/cases row
    // break must keep working — `\begin{matrix}a\\b\end{matrix}` is two rows.
    const root = parse("\\begin{matrix}a\\\\b\\end{matrix}") as Extract<
      Node,
      { type: "ord" }
    >;
    const arr = root.body[0];
    expect(arr.type).toBe("array");
    expect(arr.type === "array" && arr.rows.length).toBe(2); // a | b
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
