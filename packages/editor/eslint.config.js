import prettierRecommended from "eslint-plugin-prettier/recommended";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import unusedImports from "eslint-plugin-unused-imports";
import tseslint from "typescript-eslint";

import noGlobalMutableState from "./eslint-rules/no-global-mutable-state.js";
import preferFunctionDeclaration from "./eslint-rules/prefer-function-declaration.js";

export default tseslint.config(
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      "simple-import-sort": simpleImportSort,
      "unused-imports": unusedImports,
      // Local rules live in ./eslint-rules.
      local: {
        rules: {
          "prefer-function-declaration": preferFunctionDeclaration,
          "no-global-mutable-state": noGlobalMutableState,
        },
      },
    },
    rules: {
      // Module-level functions must use the `function` keyword. Autofixable:
      // rewrites top-level `const f = () => {}` into `function f() {}`.
      "local/prefer-function-declaration": "error",
      // Forbid module-level mutable state (`let`/`var` at module scope). Such
      // state is shared across every editor instance on the page; keep it
      // per-instance. See CLAUDE.md → "No Global Variables".
      "local/no-global-mutable-state": "error",
      // Single alphabetical group with no blank-line separation, matching
      // VSCode's "Organize Imports" so the two don't fight each other.
      "simple-import-sort/imports": ["error", { groups: [["^"]] }],
      "simple-import-sort/exports": "error",
      // Flag (and autofix-remove) imports that are never used. Unused vars are
      // warned but left in place since removing them can change behavior.
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
    },
  },
  // Enables `prettier/prettier` and disables ESLint rules that conflict with
  // Prettier. Must stay last so it can turn off conflicting formatting rules.
  prettierRecommended,
);
