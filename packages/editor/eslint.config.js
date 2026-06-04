import prettierRecommended from "eslint-plugin-prettier/recommended";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

import preferFunctionDeclaration from "./eslint-rules/prefer-function-declaration.js";

export default tseslint.config(
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      "simple-import-sort": simpleImportSort,
      // Local rules live in ./eslint-rules.
      local: {
        rules: {
          "prefer-function-declaration": preferFunctionDeclaration,
        },
      },
    },
    rules: {
      // Module-level functions must use the `function` keyword. Autofixable:
      // rewrites top-level `const f = () => {}` into `function f() {}`.
      "local/prefer-function-declaration": "error",
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
    },
  },
  // Enables `prettier/prettier` and disables ESLint rules that conflict with
  // Prettier. Must stay last so it can turn off conflicting formatting rules.
  prettierRecommended,
);
