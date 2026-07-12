/** Test-only helpers for suites that intentionally install optional math. */
import { mathExtension } from "../math-extension";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import { baseSchema } from "../schema";
import { loadPage } from "../serlization/loadPage";
import type { CRDTbinding } from "../state-types";
import { createInitialState } from "../state-utils";
import { createSyncEngine } from "../sync/sync";

// Historical flat-source suites still exercise import-time compatibility and
// the pure source/caret helpers. Keep that coverage isolated from the public
// extension, which installs structured display and inline editing exclusively.
const compatibilityMathExtension = mathExtension();
export const mathTestSchema = baseSchema.use({
  ...compatibilityMathExtension,
  inputRules: compatibilityMathExtension.inputRules.filter(
    (rule) =>
      rule.id !== "math.inline-tree.input" && rule.id !== "math.tree.migrate",
  ),
});

export function createMathTestNodeRegistry() {
  return createNodeRegistry(mathTestSchema.nodes);
}

export function createMathTestMarkRegistry() {
  return createMarkRegistry(mathTestSchema.marks);
}

export function mathTestStateOptions(crdtBinding?: CRDTbinding) {
  return {
    schema: mathTestSchema.data,
    nodes: createMathTestNodeRegistry(),
    marks: createMathTestMarkRegistry(),
    ...(crdtBinding ? { crdtBinding } : {}),
  };
}

export function createMathTestSyncEngine(binding: CRDTbinding) {
  return createSyncEngine(binding, mathTestSchema.data);
}

/** Parse markdown with the optional math syntax installed. */
export function loadMathPage(content: string) {
  return loadPage(content, mathTestSchema.data);
}

/** Create an editor state with math's data, node, mark, and action facets. */
export function createMathTestState(
  page: Parameters<typeof createInitialState>[0],
  options: NonNullable<Parameters<typeof createInitialState>[1]> = {},
) {
  return createInitialState(page, {
    ...mathTestStateOptions(options.crdtBinding),
    ...options,
  });
}
