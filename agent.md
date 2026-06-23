# Agent Guide

Cypher is a local-first, peer-to-peer markdown editor. Its editor engine renders
directly to HTML canvas and stores document state in a CRDT.

## Non-negotiable rules

- Find the root cause before changing code. Check adjacent paths and edge cases.
- Do not run `git stash` unless the user explicitly requests it.
- Do not introduce mutable global state. Multiple editors must work on one page;
  keep state in instances, arguments, or scoped context.
- The editor core must remain node- and mark-agnostic. Put type-specific behavior
  in that node or mark. If the extension API cannot express a behavior, add a
  general extension mechanism instead of a type-name check in core code.
- All user-facing strings must use i18next. Add translation keys with the UI text.
- Keep public editor documentation accurate when changing a public API.

## Compatibility status

The product has not been released. Prefer a clean design over compatibility
shims, migrations, or preserving obsolete APIs and data formats. Update all
internal callers, tests, and docs in the same change.

Post-release compatibility requirements are documented in
[`apps/site/src/views/InternalsPage/pages/compatibility.mdx`](apps/site/src/views/InternalsPage/pages/compatibility.mdx);
they are currently design guidance, not a constraint.

## Repository map

| Path | Responsibility |
| --- | --- |
| `packages/editor` | Framework-agnostic canvas editor, document model, CRDT, actions, schema |
| `packages/tex` | Canvas-native LaTeX layout and rendering |
| `packages/react` | React bindings for the editor |
| `packages/provider-*` | Persistence and collaboration providers |
| `apps/web` | Main React host and cross-platform product logic |
| `apps/desktop` | Electron wrapper and native IPC |
| `apps/live` | Stateless WebRTC signaling relay |
| `apps/site` | Marketing site and public documentation |
| `apps/ios`, `apps/android` | Capacitor native wrappers |

There is no root package manager workspace. Run commands from the relevant
package or application directory.

## Canonical commands

| Area | Command | Purpose |
| --- | --- | --- |
| `apps/web` | `npm run build` | Canonical typecheck and production build |
| `apps/web` | `npm run dev` | Vite development server on port 4000 |
| `packages/editor` | `npm test` | Vitest CRDT and regression tests |
| `packages/editor` | `npm run lint` | ESLint and custom editor rules |
| `packages/editor` | `npm run format:check` | Prettier verification |
| `apps/site` | `npm run build` | Build public docs and marketing site |
| `apps/live` | `npm run dev` | Run signaling relay on port 8080 |

## Architecture invariants

- `Doc` and its operation log are the source of truth. Editors are views over a
  document; snapshots are rebuildable caches.
- Schemas, action buses, registries, interaction sessions, themes, and host
  integrations are per editor instance.
- Nodes and marks own their layout, painting, hit testing, serialization, and
  type-specific actions.
- Cross-cutting behavior is exposed through generic actions or schema facets.
- Editor actions are pure state transforms. Content mutations emit CRDT ops.
- CRDT merge behavior must be deterministic and covered by convergence tests.
- `packages/editor` is host-independent. React UI and platform concerns belong
  outside it.
- `apps/web/src/editor/` contains host UI chrome, not editor-engine logic.

See [`docs/engineering-reference.md`](docs/engineering-reference.md) before
making architectural, CRDT, persistence, or platform changes.

## Public API documentation

The editor API specification lives in:

- `apps/site/src/views/DocsPage/pages/editor/api-editor.mdx`
- `apps/site/src/views/DocsPage/pages/editor/api-commands.mdx`
- `apps/site/src/views/DocsPage/pages/editor/api-schema.mdx`
- `apps/site/src/views/DocsPage/pages/editor/custom-nodes.mdx`
- `apps/site/src/views/DocsPage/pages/editor/collaboration.mdx`

Update the relevant page whenever its public contract changes.

## Verification

Run the smallest checks that cover the changed behavior:

| Change | Required verification |
| --- | --- |
| Editor state, actions, CRDT, schema | `packages/editor`: tests and lint |
| Public editor types consumed by web | `apps/web`: build |
| React host or platform code | `apps/web`: build |
| Public docs | `apps/site`: build |
| Formatting-heavy change | Relevant package: format check |

For CRDT failures, preserve the printed seed. Use `FUZZ_SEED`, `FUZZ_PEERS`, and
`FUZZ_OPS` to reproduce or scale fuzz runs.

Canvas content is not reliably visible to DOM-based browser automation, and text
input uses a hidden contenteditable surface. Prefer unit tests and the web build
for engine behavior. Browser checks remain useful for React overlays, menus,
popovers, and other DOM-rendered chrome.

## Before finishing

- Confirm the change addresses the root cause, not only the observed symptom.
- Check for affected call sites, tests, public exports, and documentation.
- Run the relevant verification commands and report anything not run.
