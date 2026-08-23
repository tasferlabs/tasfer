import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { libConfig } from "../tsdown.base.js";

const here = dirname(fileURLToPath(import.meta.url));

// `@shared/*` is repo-root shared source (not a published package), so it is
// inlined into this package's dist.
export default libConfig({
  alias: {
    "@shared": resolve(here, "../../shared"),
  },
  dtsTsconfig: resolve(here, "../../tsconfig.dts.json"),
});
