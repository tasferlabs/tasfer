import { fileURLToPath } from "node:url";

import babelParser from "@babel/eslint-parser";
import prettierRecommended from "eslint-plugin-prettier/recommended";
import simpleImportSort from "eslint-plugin-simple-import-sort";

import { baseConfig } from "../../eslint.config.base.mjs";

// Shared monorepo base (rules + custom local rules live at the repo root). The
// plugins are passed in because each package installs its own eslint deps —
// there is no root package.json to hold them. See ../../eslint.config.base.mjs.
export default baseConfig({
  babelParser,
  // Babel runs in a worker; plugins must be cloneable path strings, and an
  // absolute path keeps resolution independent of ESLint's cwd.
  syntaxTypescript: fileURLToPath(
    import.meta.resolve("@babel/plugin-syntax-typescript"),
  ),
  simpleImportSort,
  prettierRecommended,
});
