import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { libConfig } from "../tsdown.base.js";

const here = dirname(fileURLToPath(import.meta.url));

// Deep-imports `@tasfer/editor` from source, so its declaration emit must run
// from the repo-root project — see `tsconfig.dts.json`.
export default libConfig({
  dtsTsconfig: resolve(here, "../../tsconfig.dts.json"),
});
