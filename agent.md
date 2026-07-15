# Agent Guide

Cypher is a local-first, peer-to-peer, canvas based editor. Its editor engine renders
directly to HTML canvas and stores document state in a CRDT.

## Non-negotiable rules

- Do not run `git stash`, `git checkout` or similar unless the user explicitly requests it.
- Do not introduce mutable global state. Multiple editors must work on one page;
  keep state in instances, arguments, or scoped context.
- The editor core must remain node- and mark-agnostic. So that users who use package can opt in what to use.
- All user-facing strings must be i18n'd. Add translation keys with the UI text.
- Keep public editor documentation accurate when changing a public API.
- Never do things with git with your intuitive, if unsure please consult me.
- Stop wasting time on meaningless tests, there is no test for ux

## Recommendations

- I prefer concise comments and answers over verbose explanations. When adding comments, do not make it excessive. Some code explain for itself. Think if the comment adds value to future readers. This applies to conversation as well.

## Compatibility status

The product has not been released. Prefer a clean design over compatibility
shims, migrations, or preserving obsolete APIs and data formats. Update all
internal callers, tests, and docs in the same change.

Post-release compatibility requirements are documented in
[`apps/site/src/views/InternalsPage/pages/compatibility.mdx`](apps/site/src/views/InternalsPage/pages/compatibility.mdx);
they are currently design guidance, not a constraint.

## Repository map

| Path                       | Responsibility                                                          |
| -------------------------- | ----------------------------------------------------------------------- |
| `packages/editor`          | Framework-agnostic canvas editor, document model, CRDT, actions, schema |
| `packages/tex`             | Canvas-native LaTeX layout and rendering                                |
| `packages/react`           | React bindings for the editor                                           |
| `packages/provider-*`      | Persistence and collaboration providers                                 |
| `apps/web`                 | Main React host and cross-platform product logic                        |
| `apps/desktop`             | Electron wrapper and native IPC                                         |
| `apps/live`                | Stateless WebRTC signaling relay                                        |
| `apps/site`                | Marketing site and public documentation                                 |
| `apps/ios`, `apps/android` | Capacitor native wrappers                                               |

There is no root package manager workspace. Run commands from the relevant
package or application directory.

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

Canvas content is not reliably visible to DOM-based browser automation, and text
input uses a hidden contenteditable surface. Automation has hard time to deal with.
For things you can not test reliably as this please consult me.

## Before finishing

- Check for affected call sites, similar issues, i18n key sets, and
  documentation.
