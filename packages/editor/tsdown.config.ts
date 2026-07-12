import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { libConfig } from "../tsdown.base.js";

const here = dirname(fileURLToPath(import.meta.url));

// `@shared/*` is repo-root shared source (not a published package), so it is
// inlined into this package's dist. `@cypherkit/tex` is a real dependency and
// stays external (resolved from the consumer's node_modules at runtime).
export default libConfig({
  alias: {
    "@shared": resolve(here, "../../shared"),
  },
  exclude: ["!src/**/__testutils__/**"],
});
