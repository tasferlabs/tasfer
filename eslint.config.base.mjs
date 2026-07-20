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
 * TypeScript syntax is parsed with `@babel/eslint-parser` (not
 * typescript-eslint): TypeScript 7's native compiler no longer ships the JS
 * compiler API that typescript-eslint needs, and every rule here is
 * ESTree-based, so a syntax-only parser is enough. A syntax-only parser cannot
 * see type-position references, so unused imports/locals are NOT linted here —
 * `tsc --noEmit` enforces them via `noUnusedLocals`/`noUnusedParameters`.
 *
 * Usage (a package's own `eslint.config.js`):
 *
 *   import babelParser from "@babel/eslint-parser";
 *   import prettierRecommended from "eslint-plugin-prettier/recommended";
 *   import simpleImportSort from "eslint-plugin-simple-import-sort";
 *   import { fileURLToPath } from "node:url";
 *   import { baseConfig } from "../../eslint.config.base.mjs";
 *
 *   export default baseConfig({
 *     babelParser,
 *     // Babel runs in a worker; plugins must be cloneable path strings, and an
 *     // absolute path keeps resolution independent of ESLint's cwd.
 *     syntaxTypescript: fileURLToPath(
 *       import.meta.resolve("@babel/plugin-syntax-typescript"),
 *     ),
 *     simpleImportSort, prettierRecommended,
 *   });
 *
 * Pass `files` ({ ts, tsx } glob arrays) to override the default lint globs.
 */

import noGlobalMutableState from "./eslint-rules/no-global-mutable-state.js";
import preferFunctionDeclaration from "./eslint-rules/prefer-function-declaration.js";

export function baseConfig({
  babelParser,
  // Path string to @babel/plugin-syntax-typescript, not the imported module:
  // the parser sends babelOptions to a worker thread via structuredClone.
  syntaxTypescript,
  simpleImportSort,
  prettierRecommended,
  files = { ts: ["src/**/*.ts"], tsx: ["src/**/*.tsx"] },
}) {
  // `isTSX` must differ per extension: in .ts files `<T>` is a generic, in
  // .tsx it is JSX. Hence two config blocks sharing the same plugins/rules.
  const languageOptions = (isTSX) => ({
    parser: babelParser,
    parserOptions: {
      requireConfigFile: false,
      babelOptions: {
        plugins: [[syntaxTypescript, { isTSX }]],
      },
    },
  });

  const shared = {
    plugins: {
      "simple-import-sort": simpleImportSort,
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
    },
  };

  return [
    // Build output; the prettier block below has no `files` filter and would
    // otherwise lint bundled artifacts.
    { ignores: ["dist"] },
    { files: files.ts, languageOptions: languageOptions(false), ...shared },
    { files: files.tsx, languageOptions: languageOptions(true), ...shared },
    // Enables `prettier/prettier` and disables ESLint rules that conflict with
    // Prettier. Must stay last so it can turn off conflicting formatting rules.
    prettierRecommended,
  ];
}
