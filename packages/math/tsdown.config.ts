import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { libConfig } from "../tsdown.base.js";

const here = dirname(fileURLToPath(import.meta.url));

// Two published entries: the full feature (`.`) and the worker-safe data-only
// slice (`./data`), which carries no renderer and no `@tasfer/tex` layout call.
//
// This package deep-imports `@tasfer/editor` from source, so its declaration
// emit must run from the repo-root project — see `tsconfig.dts.json`.
export default libConfig({
  exclude: ["!src/**/__testutils__/**"],
  dtsTsconfig: resolve(here, "../../tsconfig.dts.json"),
});
