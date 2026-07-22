<h1 align="center">
  <img src="logo.png" alt="" height="48" valign="middle">&nbsp;Tasfer
</h1>

<p align="center">
  A local-first, peer-to-peer canvas text editor.<br>
  No accounts. No cloud. Your words, your device.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
  <a href="#"><img src="https://img.shields.io/badge/platform-web%20%7C%20desktop%20%7C%20mobile-brightgreen.svg" alt="Platforms"></a>
  <a href="#contributing"><img src="https://img.shields.io/badge/PRs-welcome-orange.svg" alt="PRs Welcome"></a>
</p>

<p align="center">
  <a href="https://www.tasfer.app/download">Download</a> &middot;
  <a href="https://www.tasfer.app/docs">Docs</a> &middot;
  <a href="#getting-started">Build from source</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#contributing">Contributing</a>
</p>

---

> **Just want to write?** You don't need to build anything.
> **[⬇&nbsp;Download the app](https://www.tasfer.app/download)** · **[📖&nbsp;Read the docs](https://www.tasfer.app/docs)** · or **[open it in your browser](https://tasfer.app)** — nothing to install, your work stays on your device.
>
> The rest of this page is for people who want to run, read, or build on the source.

Tasfer is a markdown editor that renders directly on HTML5 Canvas — the editing feel of Google Docs with the block model of Notion. Everything runs locally on your device. Collaboration happens directly between peers over WebRTC; a stateless relay only helps them find each other. No central server, no accounts, no cloud dependency.

The MIT-licensed editor engine is split into internal packages so its architecture can evolve independently from the app chrome. A supported public SDK is on the roadmap, but the packages are not published yet.

## Features

- **Canvas-native rendering** — Text drawn directly on HTML5 Canvas, not the DOM. Fast, precise, and consistent across platforms.
- **Local-first** — Your data lives on your device. Full offline support. No sign-up required.
- **Peer-to-peer collaboration** — Real-time editing via WebRTC DataChannels. Peers connect directly — the relay only handles signaling.
- **CRDT-powered** — An operation-log CRDT merges offline edits automatically, without conflicts.
- **End-to-end encrypted** — Peer communication is encrypted. Only you and your collaborators can read your data.
- **Cross-platform** — Web (PWA), macOS, Windows, Linux (Electron), iOS, and Android (Capacitor).
- **Block-based editing** — Paragraphs, headings, bullet/numbered/to-do lists, images, dividers, and canvas-native LaTeX math.
- **Rich text formatting** — Bold, italic, strikethrough, inline code, and links.
- **RTL support** — Full bidirectional text rendering for Arabic, Hebrew, and other RTL languages.
- **Internationalized** — UI available in multiple languages via i18next.

## Getting Started

This is a monorepo with **no root package manager workspace** — install and run commands from the specific package or app you're working on.

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- npm

### Run the web app

```bash
git clone https://github.com/hamza512b/tasfer.git
cd tasfer/apps/web
npm install          # postinstall links the local packages/* for you
npm run dev
```

Open [http://localhost:4000](http://localhost:4000).

### Run the signaling relay

The relay is a stateless service that helps peers discover each other. Once connected, all data flows directly between peers.

```bash
cd apps/live
npm install
npm run dev
```

### Build the web app for production

```bash
cd apps/web
npm run build
```

### Desktop (Electron)

```bash
cd apps/desktop
npm install
npm run dev
```

### Mobile (Capacitor)

From `apps/web`:

```bash
npm run cap:sync           # Builds the web app and syncs the native projects
npm run cap:open:ios       # Opens Xcode
npm run cap:open:android   # Opens Android Studio
```

## Architecture

The engine lives in `packages/`; the runnable apps live in `apps/`.

```
packages/
├── editor/              Internal canvas editor engine — document model, CRDT, actions, schema
├── react/               Internal React 19 bindings — useEditor hook + <Editor> component
├── tex/                 Canvas-native LaTeX layout and rendering
├── provider-core/       Transport-agnostic sync protocol
├── provider-webrtc/     Direct peer-to-peer transport
├── provider-relay/      Relay-forwarded transport (fallback)
└── provider-indexeddb/  Local op-log persistence

apps/
├── web/                 Main React SPA host (Vite + React 19) — also the PWA and Capacitor source
├── desktop/             Electron wrapper with native IPC layer
├── live/                Stateless WebRTC signaling relay
├── site/                Marketing site + documentation (Next.js, static export)
├── ios/                 iOS native wrapper (Capacitor)
└── android/             Android native wrapper (Capacitor)

shared/                  Shared TypeScript utilities (identity, invariants)
```

### How it works

**Canvas engine** — `packages/editor` is a headless, framework-agnostic core: document model, schema, actions, and a renderer that paints text straight onto HTML5 Canvas, handling keyboard, mouse, touch, and IME input by hand. `apps/web` mounts it through the React bindings in `packages/react`.

**CRDT** — `packages/editor/src/sync/` is an operation-log CRDT. Each operation is stamped with a Hybrid Logical Clock (HLC); character-level RGA converges edits across peers without conflicts.

**Platform layer** — `apps/web/src/platform/` abstracts storage and runtime behind one API across Web (OPFS + wa-sqlite), Electron (better-sqlite3 + node:fs), and Capacitor (native SQLite).

**P2P sync** — The `packages/provider-*` family carries the op log: peers discover each other via the relay, establish direct WebRTC DataChannels, exchange version vectors, then send missing operations. New operations stream in real time after catch-up.

**Storage** — All data is stored locally in SQLite. The operation log is the source of truth — there are no files, just operations and snapshots. Assets are content-addressed and synced lazily.

**Identity** — Each device generates an Ed25519 keypair on first launch. Public keys serve as peer identities. Trust is established through one-time pairing invites with mutual signature verification.

## Editor SDK roadmap

The `@tasfer/*` editor packages are **MIT-licensed source**. A supported public
SDK is on the roadmap, but the packages are not published to npm yet and do not
currently carry an external API, compatibility, documentation, or support
promise. Follow the [SDK roadmap](https://www.tasfer.app/docs/editor/roadmap) for
status updates.

## Contributing

We welcome contributions! Please read our [Contributing Guide](CONTRIBUTING.md) before submitting a pull request.

Contributions are licensed according to the directory they modify; see
[Licensing](LICENSING.md) for the full breakdown.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Security

If you discover a security vulnerability, please report it responsibly. See our [Security Policy](SECURITY.md) for details.

## Support

Need help using or contributing to Tasfer? See [SUPPORT.md](SUPPORT.md) for support channels and issue guidance.

## License

The Tasfer app is licensed under the [GNU Affero General Public License v3.0](LICENSE).
Internal packages remain MIT-licensed source even though they are not currently
published or supported as an SDK. See [Licensing](LICENSING.md).
