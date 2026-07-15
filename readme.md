<p align="center">
  <img src="logo.png" alt="Tasfer" width="128" height="128">
</p>

<h1 align="center">Tasfer</h1>

<p align="center">
  A local-first, peer-to-peer canvas text editor.<br>
  No accounts. No cloud. Your words, your device.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
  <a href="#"><img src="https://img.shields.io/badge/platform-web%20%7C%20desktop%20%7C%20mobile-brightgreen.svg" alt="Platforms"></a>
  <a href="#"><img src="https://img.shields.io/badge/PRs-welcome-orange.svg" alt="PRs Welcome"></a>
</p>

<p align="center">
  <a href="#features">Features</a> &middot;
  <a href="#getting-started">Getting Started</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#contributing">Contributing</a> &middot;
  <a href="#support">Support</a> &middot;
  <a href="#license">License</a>
</p>

---

Tasfer is a markdown text editor that renders directly on HTML5 Canvas — combining the editing experience of Google Docs with the block architecture of Notion. Everything runs locally on your device. Collaboration happens directly between peers over WebRTC. No central server, no accounts, no cloud dependency.

## Features

- **Canvas-native rendering** — Text drawn directly on HTML5 Canvas, not the DOM. Fast, precise, and consistent across platforms.
- **Local-first** — Your data lives on your device. Full offline support. No sign-up required.
- **Peer-to-peer collaboration** — Real-time editing via WebRTC DataChannels. Peers connect directly — the server only handles signaling.
- **CRDT-powered** — Operation-log CRDT ensures offline edits merge automatically without conflicts.
- **End-to-end encrypted** — All peer communication is encrypted. Only you and your collaborators can read your data.
- **Cross-platform** — Web, macOS, Windows, Linux (Electron), iOS, and Android (Capacitor).
- **Block-based editing** — Paragraphs, headings, bullet lists, numbered lists, to-do lists, images, and dividers.
- **Rich text formatting** — Bold, italic, strikethrough, inline code, and links.
- **RTL support** — Full bidirectional text rendering for Arabic, Hebrew, and other RTL languages.
- **Internationalized** — UI available in multiple languages via i18next.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- npm

### Run the web app

```bash
git clone https://github.com/hamza512b/cypher.git
cd cypher
npm install
cd apps/web
npm run dev
```

Open [http://localhost:4000](http://localhost:4000).

### Run the signaling server

The signaling server is a stateless relay that helps peers discover each other. Once connected, all data flows directly between peers.

```bash
cd apps/live
npm run dev
```

### Build for production

```bash
cd apps/web
npm run build
```

### Desktop (Electron)

```bash
cd apps/desktop
npm run dev
```

### Mobile (Capacitor)

```bash
# After building the web app
npm run cap:sync
npm run cap:open:ios       # Opens Xcode
npm run cap:open:android   # Opens Android Studio
```

## Architecture

```
apps/
├── web/        Main React SPA (Vite + React 19 + TypeScript)
├── desktop/    Electron wrapper with native IPC layer
├── live/       Stateless WebRTC signaling relay
├── ios/        iOS native wrapper (Capacitor)
└── android/    Android native wrapper (Capacitor)
shared/         Shared TypeScript types and utilities
```

### How it works

**Canvas engine** — A custom text rendering engine (`apps/web/src/editor/`) draws content directly on HTML5 Canvas with manual handling of keyboard, mouse, touch, and IME input events.

**CRDT** — An operation-log CRDT (`apps/web/src/editor/sync/`) powers collaborative editing. Each operation is stamped with a Hybrid Logical Clock (HLC). Character-level RGA ensures edits converge across peers without conflicts.

**Platform layer** — A cross-platform abstraction (`apps/web/src/platform/`) provides a single API across Web (OPFS + wa-sqlite), Electron (better-sqlite3 + node:fs), and Capacitor (native SQLite).

**P2P sync** — Peers discover each other via a signaling server, then establish direct WebRTC DataChannels. Replication is pull-based: peers exchange version vectors, then send missing operations. New operations are pushed in real-time after catch-up.

**Storage** — All data is stored locally in SQLite. The CRDT operation log is the source of truth — there are no files, just operations and snapshots. Assets are content-addressed and synced lazily.

**Identity** — Each device generates an Ed25519 keypair on first launch. Public keys serve as peer identities. Trust is established through one-time pairing invites with mutual signature verification.

## Contributing

We welcome contributions! Please read our [Contributing Guide](CONTRIBUTING.md) before submitting a pull request.

By contributing, you agree that your contributions will be licensed under the AGPL-3.0 License.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Security

If you discover a security vulnerability, please report it responsibly. See our [Security Policy](SECURITY.md) for details.

## Support

Need help using or contributing to Tasfer? See [SUPPORT.md](SUPPORT.md) for support channels and issue guidance.

## License

Tasfer is licensed under the [GNU Affero General Public License v3.0](LICENSE).
