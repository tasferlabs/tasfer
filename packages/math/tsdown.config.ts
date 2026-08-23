import { libConfig } from "../tsdown.base.js";

// Two published entries: the full feature (`.`) and the worker-safe data-only
// slice (`./data`), which carries no renderer and no `@tasfer/tex` layout call.
export default libConfig({
  exclude: ["!src/**/__testutils__/**"],
});
