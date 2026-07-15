# Contributing to Tasfer

Thank you for your interest in contributing to Tasfer! This guide will help you get started.

## How to Contribute

### Reporting Bugs

All bug reports are welcome — no issue is too small. Before filing one, please search [existing issues](https://github.com/hamza512b/tasfer/issues) to avoid duplicates.

When reporting a bug, include:

- A clear, descriptive title
- Steps to reproduce the behavior
- Expected vs actual behavior
- Platform and browser/app version
- Screenshots or screen recordings if applicable

### Suggesting Features

Open an issue with the **feature request** template. Describe the problem you're trying to solve and your proposed solution. We value ideas that align with Tasfer's core principles: local-first, peer-to-peer, and privacy-respecting.

### Submitting Changes

1. **Fork** the repository
2. **Create a branch** from `main` (`git checkout -b my-change`)
3. **Make your changes** — keep commits focused and atomic
4. **Test your changes** locally across platforms if applicable
5. **Push** to your fork and open a **Pull Request**

### Pull Request Guidelines

- Keep PRs focused on a single change
- Write a clear description of what changed and why
- Reference any related issues
- Make sure the app builds — `npm run build` in `apps/web` (this is the canonical
  typecheck; it also compiles the aliased `@cypherkit/*` source)
- If you touched the editor engine, run the tests — `npm test` in `packages/editor`

## Development Setup

### Prerequisites

- Node.js 22+
- npm (the repo uses `package-lock.json` lockfiles)

### Getting Started

There is **no root `package.json`** and no workspace tool — each app and package
manages its own dependencies and is built and run from its own directory. Install
and run the part you're working on:

```bash
git clone https://github.com/<your-fork>/tasfer.git
cd tasfer/apps/web
npm install
npm run dev
```

The web app runs at `http://localhost:4000`.

The web app consumes `@cypherkit/editor`, `@cypherkit/tex`, and `@cypherkit/react`
as raw TypeScript source via path aliases, so engine changes show up in `apps/web`
without a separate build step. `npm install` in `apps/web` also installs those
packages' own dependencies via a postinstall hook; other packages are installed
from their own directories.

### Mobile & HTTPS Development

The mobile WebViews (and any non-localhost browser) need a **secure context** for
`crypto.subtle`, OPFS, and Web Locks, so the LAN dev server must be served over
HTTPS with a locally trusted mkcert certificate. Generating the cert and trusting
it on each device (including the per-device iOS Simulator step) is documented in
[docs/ssl-dev-setup.md](docs/ssl-dev-setup.md).

### Project Structure

```
apps/
├── web/        # Main React SPA (Vite + React 19 + TypeScript) — the first host
├── desktop/    # Electron wrapper (IPC to native APIs)
├── live/       # WebRTC signaling relay (Cloudflare Worker)
├── site/       # Marketing site + docs (Next.js)
├── ios/        # iOS (Capacitor)
└── android/    # Android (Capacitor)
packages/       # the @cypherkit/* ecosystem — the product core, published for external consumers
├── editor/             # @cypherkit/editor — headless canvas + CRDT editor engine
├── tex/                # @cypherkit/tex — canvas-native LaTeX math layout & rendering
├── react/              # @cypherkit/react — React 19 bindings (useEditor, <Editor>)
└── provider-*/         # sync transports: -core, -indexeddb, -relay, -webrtc
examples/       # example apps built on @cypherkit/* (cypher-studio, foolscap)
shared/         # small shared utilities (e.g. invariant)
```

## Internationalization

All user-facing strings must use i18next — never hardcode text in components.

- Translation files: `apps/web/public/app/locales/{lang}/translation.json`
- In React: `const { t } = useTranslation()` then `t("key")`

## Code Style

- TypeScript throughout
- The `@cypherkit/*` packages have ESLint + Prettier configured — run `npm run lint`
  and `npm run format` from the package you touched (custom rules live in
  `eslint-rules/`)
- No global mutable state — the editor must support multiple instances on one page,
  so keep all state per-instance (enforced by the `no-global-mutable-state` rule)
- Prefer small, focused functions
- Avoid unnecessary abstractions

## Releases

Versioning is automated with [release-please](https://github.com/googleapis/release-please).
Use [Conventional Commits](https://www.conventionalcommits.org/) for anything
release-worthy — `fix:` bumps patch, `feat:` bumps minor, `feat!:`/`fix!:` bumps
major. A commit only affects the packages whose directories it touches.

How the cycle works:

- release-please maintains a release PR on `main` that accumulates version bumps
  and changelogs. The `packages/*` libraries are versioned in lockstep; the
  desktop app (`apps/desktop`) is versioned independently and tagged `v<version>`.
- Merging the release PR creates the tags and GitHub releases, then:
  - the packages are built in dependency order and published to npm
    (peer ranges between them are pinned at publish time), and
  - the desktop app is built and signed for macOS/Windows/Linux into a draft
    release, which is published once all platforms have uploaded.
- `apps/live` deploys to Cloudflare on every push to `main` that touches it.
- `apps/web` and `apps/site` deploy continuously via Vercel (two projects with
  root directories `apps/web` and `apps/site`; the web project needs "Include
  source files outside of the Root Directory" enabled).

Dry runs: the **npm Publish** workflow can be dispatched with `dry_run`, and
**Desktop Release** can be dispatched with `publish: false` to build without
touching a release.

### AUR (manual, after a desktop release)

From `aur/`: bump `pkgver`, reset `pkgrel` to 1, replace the checksum
(`makepkg -g`), regenerate `.SRCINFO` (`makepkg --printsrcinfo > .SRCINFO`), and
push to the AUR repository.

## Community

- Be respectful and constructive
- Follow our [Code of Conduct](CODE_OF_CONDUCT.md)

## License

Tasfer is dual-licensed by directory — see [LICENSING.md](LICENSING.md) for the
full breakdown:

- **`packages/*` and `examples/*` are MIT.** Contributions there are accepted
  under the [MIT License](LICENSE-MIT).
- **`apps/*` are AGPL-3.0-or-later _and_ offered commercially.** Because the apps
  are dual-licensed (the maintainer ships proprietary App Store / Play Store and
  paid builds alongside the AGPL source), contributions to `apps/*` are accepted
  under a **Contributor License Agreement (CLA)** that grants the project owner
  the right to relicense your contribution, including under proprietary terms. A
  simple sign-off ("I have read and agree to the CLA") is required on pull
  requests that touch `apps/*`.
