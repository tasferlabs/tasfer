import prettierRecommended from "eslint-plugin-prettier/recommended";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import unusedImports from "eslint-plugin-unused-imports";
import tseslint from "typescript-eslint";

import { baseConfig } from "../../eslint.config.base.mjs";

// Shared monorepo base (rules + custom local rules live at the repo root). The
// plugins are passed in because each package installs its own eslint deps —
// there is no root package.json to hold them. See ../../eslint.config.base.mjs.
export default baseConfig({
  tseslint,
  simpleImportSort,
  unusedImports,
  prettierRecommended,
});
