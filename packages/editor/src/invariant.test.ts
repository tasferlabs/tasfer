/**
 * `invariant` — the Lexical-style internal assertion helper.
 */

import { invariant, InvariantError } from "@shared/invariant";
import { describe, expect, it } from "vitest";

describe("invariant", () => {
  it("does nothing when the condition holds", () => {
    expect(() => invariant(true, "should not throw")).not.toThrow();
    expect(() => invariant(1, "truthy")).not.toThrow();
  });

  it("throws a standalone InvariantError when falsy", () => {
    let caught: unknown;
    try {
      invariant(false, "boom");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvariantError);
    // An invariant is a bug signal — a plain `Error` subclass with no domain
    // base, so a host's catch for recoverable failures never swallows it.
    expect((caught as Error).message).toBe("boom");
    expect((caught as Error).name).toBe("InvariantError");
  });

  it("substitutes %s placeholders from args in order", () => {
    expect(() =>
      invariant(false, "empty text in %s at %s", "block-1", 7),
    ).toThrow("empty text in block-1 at 7");
  });

  it("leaves a %s with no corresponding arg untouched", () => {
    expect(() => invariant(false, "%s and %s", "only")).toThrow("only and %s");
  });

  it("narrows the type via `asserts`", () => {
    const value: string | null = "x" as string | null;
    invariant(value !== null, "value is null");
    // If `asserts` narrowing didn't apply, `value.length` would be a type error
    // under strict null checks (the web build is the canonical typecheck).
    expect(value.length).toBe(1);
  });
});
