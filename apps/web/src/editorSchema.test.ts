import { appSchema } from "./editorSchema";
import { describe, expect, it } from "vitest";

describe("app editor math composition", () => {
  it("installs both display and inline structured-tree input", () => {
    const ids = appSchema.data.features
      .inputRules("before-insert")
      .map((rule) => rule.id);

    expect(ids).toContain("math.tree.migrate");
    expect(ids).toContain("math.inline-tree.input");
  });
});
