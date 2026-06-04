//NOTE - Make the eslint and pretteir config global

/**
 * Custom ESLint rule: enforce the `function` keyword for module-level (global)
 * functions, with an autofix that rewrites const-assigned arrow/function
 * expressions into function declarations.
 *
 *   const f = (a) => { ... }          -> function f(a) { ... }
 *   export const f = (a): R => expr   -> export function f(a): R { return expr; }
 *   const f = function* () { ... }     -> function* f() { ... }
 *
 * The fix is intentionally conservative: anything that can't be rewritten
 * losslessly is reported without a fix (multiple declarators, a type-annotated
 * binding, `this`/`super`/`arguments` usage, unparenthesized single params,
 * named function expressions, etc.).
 *
 * @type {import("eslint").Rule.RuleModule}
 */
const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require module-level functions to use the `function` keyword instead of a const arrow/function expression.",
    },
    fixable: "code",
    schema: [],
    messages: {
      preferDeclaration:
        "Module-level functions must be declared with the `function` keyword (e.g. `export function foo() {}`), not assigned to a `const` as an arrow/function expression.",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    function isTopLevel(declaration) {
      const parent = declaration.parent;
      if (!parent) return false;
      if (parent.type === "Program") return true;
      // export const ... at module scope
      return (
        parent.type === "ExportNamedDeclaration" &&
        parent.parent?.type === "Program"
      );
    }

    // Returns the replacement text for the whole VariableDeclaration, or null
    // when the rewrite can't be done safely.
    function buildReplacement(declarator) {
      const declaration = declarator.parent;
      if (declaration.declarations.length !== 1) return null;
      if (declarator.id.type !== "Identifier") return null;
      // A binding type annotation (`const f: MyFn = () => {}`) would be lost.
      if (declarator.id.typeAnnotation) return null;

      const fn = declarator.init;
      const name = declarator.id.name;

      // Named function expressions may self-reference their inner name.
      if (fn.type === "FunctionExpression" && fn.id) return null;

      // `this`/`super`/`arguments` semantics differ between arrows/functions,
      // so bail if they appear anywhere inside the expression.
      for (const token of sourceCode.getTokens(fn)) {
        if (
          token.type === "Keyword" &&
          (token.value === "this" || token.value === "super")
        ) {
          return null;
        }
        if (token.type === "Identifier" && token.value === "arguments") {
          return null;
        }
      }

      let keyword = fn.async ? "async function" : "function";
      if (fn.generator) keyword += "*";

      if (fn.type === "ArrowFunctionExpression") {
        // Unparenthesized single param (`x => ...`) — skip for simplicity.
        if (fn.params.length === 1) {
          const before = sourceCode.getTokenBefore(fn.params[0]);
          if (!before || before.value !== "(") return null;
        }

        // Nearest `=>` before the body — not `getTokenBefore(fn.body)`, which
        // would return a wrapping `(` for parenthesized bodies like `() => ({})`.
        const arrowToken = sourceCode.getTokenBefore(fn.body, {
          filter: (t) => t.value === "=>",
        });
        let head = sourceCode.text.slice(fn.range[0], arrowToken.range[0]);
        if (fn.async) head = head.replace(/^async\b\s*/, "");
        head = head.trim();

        const body =
          fn.body.type === "BlockStatement"
            ? sourceCode.getText(fn.body)
            : `{ return ${sourceCode.getText(fn.body)}; }`;

        return `${keyword} ${name}${head} ${body}`;
      }

      // FunctionExpression: keep everything from the type params / params on.
      const sigStart = fn.typeParameters
        ? fn.typeParameters.range[0]
        : sourceCode.getFirstToken(fn, {
            filter: (t) => t.value === "(",
          })?.range[0];
      if (sigStart == null) return null;

      const sig = sourceCode.text.slice(sigStart, fn.body.range[0]).trim();
      const body = sourceCode.getText(fn.body);
      return `${keyword} ${name}${sig} ${body}`;
    }

    return {
      VariableDeclarator(node) {
        const init = node.init;
        if (
          !init ||
          (init.type !== "ArrowFunctionExpression" &&
            init.type !== "FunctionExpression")
        ) {
          return;
        }

        const declaration = node.parent;
        if (declaration.type !== "VariableDeclaration") return;
        // Only `const` holds a fixed function definition. `let`/`var` bindings
        // are reassignable function-typed state, not global function decls.
        if (declaration.kind !== "const") return;
        if (!isTopLevel(declaration)) return;

        context.report({
          node: init,
          messageId: "preferDeclaration",
          fix(fixer) {
            const replacement = buildReplacement(node);
            if (replacement == null) return null;
            return fixer.replaceTextRange(declaration.range, replacement);
          },
        });
      },
    };
  },
};

export default rule;
