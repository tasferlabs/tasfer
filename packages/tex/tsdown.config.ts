import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { libConfig } from "../tsdown.base.js";

const here = dirname(fileURLToPath(import.meta.url));

export default libConfig({
  alias: {
    "@shared": resolve(here, "../../shared"),
  },
});
