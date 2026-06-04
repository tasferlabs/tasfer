import prettierRecommended from "eslint-plugin-prettier/recommended";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

// Top-level (module-scoped) function values, in every form they can appear:
//   const f = () => {}          | export const f = () => {}
//   const f = function () {}    | export const f = function () {}
// These must instead be declared with the `function` keyword:
//   function f() {}             | export function f() {}
const TOP_LEVEL_FN_SELECTORS = [
  "VariableDeclaration",
  "ExportNamedDeclaration > VariableDeclaration",
]
  .flatMap((decl) =>
    ["ArrowFunctionExpression", "FunctionExpression"].map(
      (fn) => `Program > ${decl} > VariableDeclarator > ${fn}`,
    ),
  )
  .join(", ");

export default tseslint.config(
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: TOP_LEVEL_FN_SELECTORS,
          message:
            "Module-level functions must be declared with the `function` keyword (e.g. `export function foo() {}`), not assigned to a `const` as an arrow/function expression.",
        },
      ],
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
    },
  },
  // Enables `prettier/prettier` and disables ESLint rules that conflict with
  // Prettier. Must stay last so it can turn off conflicting formatting rules.
  prettierRecommended,
);
