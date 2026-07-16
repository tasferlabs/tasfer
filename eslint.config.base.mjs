/**
 * Shared ESLint base for the tasfer monorepo.
 *
 * There is no root `package.json` and no workspace tool — each app/package
 * manages its own dependencies and runs ESLint from its own directory (see
 * CLAUDE.md). So this base is a **factory**: a consuming package imports its own
 * locally-installed plugins and passes them in, and this file contributes the
 * shared `files`/`languageOptions`/`plugins`/`rules` wiring. The custom local
 * rules live beside this file (`./eslint-rules`) and are imported directly —
 * plain JS, no node resolution required.
 *
 * Usage (a package's own `eslint.config.js`):
 *
 *   import prettierRecommended from "eslint-plugin-prettier/recommended";
 *   import simpleImportSort from "eslint-plugin-simple-import-sort";
 *   import unusedImports from "eslint-plugin-unused-imports";
 *   import tseslint from "typescript-eslint";
 *   import { baseConfig } from "../../eslint.config.base.mjs";
 *
 *   export default baseConfig({
 *     tseslint, simpleImportSort, unusedImports, prettierRecommended,
 *   });
 *
 * Pass `files` to override the default lint globs.
 */

import noGlobalMutableState from "./eslint-rules/no-global-mutable-state.js";
import preferFunctionDeclaration from "./eslint-rules/prefer-function-declaration.js";

export function baseConfig({
  tseslint,
  simpleImportSort,
  unusedImports,
  prettierRecommended,
  files = ["src/**/*.ts", "src/**/*.tsx"],
}) {
  return tseslint.config(
    {
      files,
      languageOptions: {
        parser: tseslint.parser,
      },
      plugins: {
        "simple-import-sort": simpleImportSort,
        "unused-imports": unusedImports,
        // Local rules live in ./eslint-rules (repo root).
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
}
