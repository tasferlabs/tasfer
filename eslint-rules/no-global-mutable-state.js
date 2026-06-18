/**
 * Custom ESLint rule: forbid module-level mutable state (global variables).
 *
 * The editor must support multiple editor instances on the same page. Any
 * module-level mutable binding is shared across every instance, so two editors
 * would clobber each other's state. Keep all mutable state per-instance —
 * pass it through function arguments, instance fields, or scoped context.
 *
 * This flags `let`/`var` declared at module (Program) scope, including
 * `export let`/`export var`:
 *
 *   let fontsLoaded = false;            // reported
 *   export var counter = 0;            // reported
 *   const TOKENS = { ... };            // allowed (immutable binding)
 *
 * `const` bindings are allowed because the binding itself can't be
 * reassigned. (A `const` holding a mutated Map/array is still shared state,
 * but detecting that statically is unreliable; this rule targets the clear,
 * mechanical signal — a reassignable module-level binding.)
 *
 * @type {import("eslint").Rule.RuleModule}
 */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid module-level mutable state (`let`/`var` at module scope); keep all mutable state per-instance so multiple editor instances don't share it.",
    },
    schema: [],
    messages: {
      noGlobalMutableState:
        "Module-level mutable state is forbidden — it is shared across all editor instances on the page. Keep `{{name}}` per-instance (function argument, instance field, or scoped context) instead of a module-level `{{kind}}`.",
    },
  },

  create(context) {
    function isTopLevel(declaration) {
      const parent = declaration.parent;
      if (!parent) return false;
      if (parent.type === "Program") return true;
      // export let/var at module scope
      return (
        parent.type === "ExportNamedDeclaration" &&
        parent.parent?.type === "Program"
      );
    }

    return {
      VariableDeclaration(node) {
        // `const` bindings are immutable references, so they aren't the
        // reassignable module-level state this rule targets.
        if (node.kind === "const") return;
        if (!isTopLevel(node)) return;

        for (const declarator of node.declarations) {
          const name =
            declarator.id.type === "Identifier"
              ? declarator.id.name
              : "this binding";
          context.report({
            node: declarator,
            messageId: "noGlobalMutableState",
            data: { name, kind: node.kind },
          });
        }
      },
    };
  },
};

export default rule;
