<h1 align="center">
  <img src="logo.png" alt="" height="48" valign="middle">&nbsp;Tasfer
</h1>

<p align="center">
  A local-first, peer-to-peer canvas text editor.<br>
  No cloud. Your words, your device.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
  <a href="#use-the-editor-in-your-own-app"><img src="https://img.shields.io/badge/editor%20engine-MIT-green.svg" alt="Editor engine: MIT"></a>
  <a href="#"><img src="https://img.shields.io/badge/platform-web%20%7C%20desktop%20%7C%20mobile-brightgreen.svg" alt="Platforms"></a>
  <a href="#contributing"><img src="https://img.shields.io/badge/PRs-welcome-orange.svg" alt="PRs Welcome"></a>
</p>

<p align="center">
  <a href="https://www.tasfer.app/app">Web</a> &middot;
  <a href="https://www.tasfer.app/download">Download</a> &middot;
  <a href="https://www.tasfer.app/docs">Docs</a> &middot;
  <a href="CONTRIBUTING.md#getting-started">Build from source</a> &middot;
  <a href="#contributing">Contributing</a>
</p>

---

Tasfer is a markdown editor that renders directly on HTML5 Canvas. The editing feel of Google Docs with the block model of Notion. Everything runs locally on your device. Collaboration happens directly between peers over WebRTC; a stateless relay helps them find each other, and relays traffic when a direct connection isn't possible.

The engine is a headless, framework-agnostic core (`@tasfer/editor`, MIT) that the app in this repo is one host for; you can embed it in your own app.

## Features

- **Canvas-native rendering**: Text drawn directly on HTML5 Canvas, not the DOM. Fast, precise, and consistent across platforms.
- **Local-first**: Your data lives on your device. Full offline support. No sign-up required.
- **Peer-to-peer collaboration**: Real-time editing via WebRTC DataChannels. Peers connect directly; the relay steps in only for signaling, or when a direct connection fails.
- **CRDT-powered**: An operation-log CRDT merges offline edits automatically, without conflicts.
- **Cross-platform**: Web (PWA), macOS, Windows, Linux (Electron), iOS, and Android (Capacitor). (**Android app is not published**)
- **Block-based editing**: Paragraphs, headings, bullet/numbered/to-do lists, images, dividers, and canvas-native LaTeX math.
- **Rich text formatting**: Bold, italic, strikethrough, inline code, and links.
- **RTL support**: Full bidirectional text rendering for Arabic, Hebrew, and other RTL languages.
- **IME support**: Works with input method editors for Chinese, Japanese, Korean, and other languages.
- **Powerful LaTeX support**: Render and edit LaTeX math directly on the canvas.

## Use the editor in your own app

The editor engine is not tied to Tasfer, the app. It ships as a standalone, **MIT-licensed** package (`@tasfer/editor` for the framework-agnostic core, `@tasfer/react` for React 19 bindings), so you can drop a canvas-native, CRDT-backed editor into your own product and bring your own nodes, marks, theme, and providers.

Start with the [editor documentation](https://www.tasfer.app/docs/editor/install): installation, your first editor, custom nodes, theming, collaboration, and the full API reference.

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

The Tasfer app is licensed under the [GNU Affero General Public License v3.0](LICENSE). The editor engine packages (`@tasfer/editor`, `@tasfer/react`) are MIT-licensed. See [Licensing](LICENSING.md).
