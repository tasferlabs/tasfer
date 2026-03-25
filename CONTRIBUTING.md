# Contributing to Cypher

Thank you for your interest in contributing to Cypher! This guide will help you get started.

## How to Contribute

### Reporting Bugs

Before filing a bug, please search [existing issues](https://github.com/hamza512b/cypher/issues) to avoid duplicates.

When reporting a bug, include:

- A clear, descriptive title
- Steps to reproduce the behavior
- Expected vs actual behavior
- Platform and browser/app version
- Screenshots or screen recordings if applicable

### Suggesting Features

Open an issue with the **feature request** template. Describe the problem you're trying to solve and your proposed solution. We value ideas that align with Cypher's core principles: local-first, peer-to-peer, and privacy-respecting.

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
- Make sure the app builds (`npm run build` in `apps/web`)
- Add translations for any new user-facing strings (see [i18n](#internationalization))

## Development Setup

### Prerequisites

- Node.js 22+
- npm

### Getting Started

```bash
git clone https://github.com/<your-fork>/cypher.git
cd cypher
npm install
cd apps/web
npm run dev
```

The web app runs at `http://localhost:4000`.

### Project Structure

```
apps/
├── web/        # Main React SPA (Vite + React 19 + TypeScript)
├── desktop/    # Electron wrapper
├── live/       # Signaling server (Cloudflare Worker)
├── ios/        # iOS (Capacitor)
└── android/    # Android (Capacitor)
shared/         # Shared types and utilities
```

### Key Areas

| Area | Path | Notes |
|---|---|---|
| Canvas engine | `apps/web/src/editor/` | Rendering, events, selection |
| CRDT | `apps/web/src/editor/sync/` | RGA, HLC, operation log |
| Platform layer | `apps/web/src/platform/` | Cross-platform abstraction |
| React UI | `apps/web/src/app/` | Components, pages, hooks |
| Desktop | `apps/desktop/src/` | Electron IPC layer |
| Signaling | `apps/live/src/` | WebRTC relay |

## Internationalization

All user-facing strings must use i18next — never hardcode text in components.

- Translation files: `apps/web/public/app/locales/{lang}/translation.json`
- In React: `const { t } = useTranslation()` then `t("key")`
- When adding new strings, add the key to **all** locale files

## Code Style

- TypeScript throughout
- No linting or formatting tools are configured yet — just be consistent with the surrounding code
- Prefer small, focused functions
- Avoid unnecessary abstractions

## Community

- Be respectful and constructive
- Follow our [Code of Conduct](CODE_OF_CONDUCT.md)

## License

By contributing to Cypher, you agree that your contributions will be licensed under the [AGPL-3.0 License](LICENSE).
