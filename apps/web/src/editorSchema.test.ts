import { appDataSchema } from "./appDataSchema";
import { appSchema } from "./editorSchema";
import { MATH_STRUCTURED_KIND } from "@tasfer/editor/math/data";
import { describe, expect, it } from "vitest";

describe("app editor math composition", () => {
  it("installs both display and inline structured-tree input", () => {
    const ids = appSchema.data
      .inputRules("before-insert")
      .map((rule) => rule.id);

    expect(ids).toContain("math.tree.input");
    expect(ids).toContain("math.inline-tree.input");
  });

  it("carries math's spec facets on the worker-safe data schema", () => {
    expect(appDataSchema.syntaxRules().map((rule) => rule.id)).toEqual([
      "math.display-dollar-fence",
      "math.inline-dollar-delimiter",
    ]);
    expect(appDataSchema.structuredMark("math")).toBeDefined();
    // Live authoring facets stay out of reducers and workers.
    expect(appDataSchema.inputRules("before-insert")).toEqual([]);
  });

  it("installs the kind's selection adapters interactively only", () => {
    const workerKind = appDataSchema.structuredKind(MATH_STRUCTURED_KIND);
    const interactiveKind = appSchema.data.structuredKind(
      MATH_STRUCTURED_KIND,
    );

    // Both halves share the kind's snapshot clone adapter; only the
    // interactive schema adds the tex-layout-backed clipboard serializer and
    // range resolver.
    expect(workerKind?.clone).toBeDefined();
    expect(workerKind?.contentSelection).toBeUndefined();
    expect(workerKind?.resolveSelection).toBeUndefined();
    expect(interactiveKind?.clone).toBeDefined();
    expect(interactiveKind?.contentSelection).toBeDefined();
    expect(interactiveKind?.resolveSelection).toBeDefined();
  });
});
