/**
 * The version this build reports and updates against.
 *
 * Stamped in by the bundler from `/version.json` (see `tsdown.config.ts`), the
 * one file that carries every version in this repo. A bundle has no
 * package.json to read at runtime, and a literal here would be one more thing
 * to forget on release day.
 *
 * `0.0.0` is what an unbundled run reports — `tsc` output, a test. It sorts
 * below every published version, so `tasfer update` from a source checkout
 * finds one and then says to rebuild instead of downloading over the tree.
 */
declare const __TASFER_CLI_VERSION__: string;

export const VERSION: string =
  typeof __TASFER_CLI_VERSION__ === "string"
    ? __TASFER_CLI_VERSION__
    : "0.0.0";
