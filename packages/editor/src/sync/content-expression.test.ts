/**
 * The content-expression compiler: grammar coverage, matching, and the
 * `fillBefore` repair/satisfiability probe. Pure functions over block-type
 * strings — no document, no CRDT — so the schema-level guards that build on
 * them have a trustworthy base.
 */

import { parseContentExpression } from "./content-expression";
import { InvariantError } from "@shared/invariant";
import { describe, expect, it } from "vitest";

const TYPES = ["heading1", "paragraph", "image", "bullet_list"] as const;
const GROUPS: Record<string, readonly string[]> = {
  block: TYPES,
  text: ["heading1", "paragraph", "bullet_list"],
  heading: ["heading1"],
  empty: [],
};

function resolve(name: string): readonly string[] | undefined {
  return (TYPES as readonly string[]).includes(name) ? [name] : GROUPS[name];
}

function compile(source: string) {
  return parseContentExpression(source, resolve);
}

/** Whether a whole sequence is a complete, legal document. */
function accepts(source: string, types: readonly string[]): boolean {
  return compile(source).match.matchSequence(types)?.validEnd ?? false;
}

describe("content expressions", () => {
  it("matches a sequence with a required head and a repeated tail", () => {
    const expr = "heading1 paragraph+";
    expect(accepts(expr, ["heading1", "paragraph"])).toBe(true);
    expect(accepts(expr, ["heading1", "paragraph", "paragraph"])).toBe(true);
    expect(accepts(expr, ["heading1"])).toBe(false);
    expect(accepts(expr, ["paragraph", "paragraph"])).toBe(false);
    expect(accepts(expr, ["heading1", "image"])).toBe(false);
  });

  it("honours alternation and counted repetition", () => {
    const expr = "heading1 (paragraph|image){1,3}";
    expect(accepts(expr, ["heading1", "image"])).toBe(true);
    expect(accepts(expr, ["heading1", "paragraph", "image", "paragraph"])).toBe(
      true,
    );
    expect(accepts(expr, ["heading1"])).toBe(false);
    expect(
      accepts(expr, ["heading1", "paragraph", "image", "paragraph", "image"]),
    ).toBe(false);
  });

  it("supports `*`, `?` and open-ended counts", () => {
    expect(accepts("heading1 block*", ["heading1"])).toBe(true);
    expect(
      accepts("heading1 block*", ["heading1", "image", "bullet_list"]),
    ).toBe(true);
    expect(accepts("heading1? paragraph", ["paragraph"])).toBe(true);
    expect(accepts("paragraph{2,}", ["paragraph"])).toBe(false);
    expect(accepts("paragraph{2,}", ["paragraph", "paragraph"])).toBe(true);
    expect(
      accepts("paragraph{2}", ["paragraph", "paragraph", "paragraph"]),
    ).toBe(false);
  });

  it("expands a group name to every member type", () => {
    const start = compile("text+").match;
    expect(start.matchType("paragraph")).not.toBeNull();
    expect(start.matchType("bullet_list")).not.toBeNull();
    expect(start.matchType("image")).toBeNull();
  });

  it("reports the types allowed at a position, in expression order", () => {
    const start = compile("heading1 (paragraph|image)+").match;
    expect(start.allowedTypes()).toEqual(["heading1"]);
    expect(start.matchType("heading1")?.allowedTypes()).toEqual([
      "paragraph",
      "image",
    ]);
  });

  it("fills the shortest legal tail", () => {
    const expr = compile("heading1 paragraph+");
    expect(expr.match.fillBefore([], true)).toEqual(["heading1", "paragraph"]);
    expect(
      expr.match.matchSequence(["heading1"])?.fillBefore([], true),
    ).toEqual(["paragraph"]);
    expect(
      expr.match.matchSequence(["heading1", "paragraph"])?.fillBefore([], true),
    ).toEqual([]);
  });

  it("names the whole document a satisfiable expression needs", () => {
    // fillBefore from the start state doubles as the satisfiability probe the
    // schema runs when compiling a `content` restriction.
    expect(compile("paragraph+").match.fillBefore([], true)).toEqual([
      "paragraph",
    ]);
    expect(compile("heading1 paragraph").match.fillBefore([], true)).toEqual([
      "heading1",
      "paragraph",
    ]);
  });

  it("rejects malformed expressions and unknown names", () => {
    expect(() => compile("")).toThrow(InvariantError);
    expect(() => compile("heading1 (paragraph")).toThrow(InvariantError);
    expect(() => compile("heading1)")).toThrow(InvariantError);
    expect(() => compile("paragraph{2,1}")).toThrow(InvariantError);
    expect(() => compile("paragraph{a}")).toThrow(InvariantError);
    expect(() => compile("nope+")).toThrow(/neither a registered block type/);
    expect(() => compile("empty+")).toThrow(/is empty in this schema/);
  });
});
