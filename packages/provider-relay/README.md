# @tasfer/provider-relay

**Sync through a WebSocket relay** for [`@tasfer/editor`](https://www.npmjs.com/package/@tasfer/editor).
Peers in the same room exchange document operations through a server that
blindly forwards frames between them — the network-relay sibling of
[`@tasfer/provider-webrtc`](https://www.npmjs.com/package/@tasfer/provider-webrtc),
and the fit when direct peer-to-peer is blocked but a relay is reachable.

## Install

```bash
npm install @tasfer/editor @tasfer/provider-core @tasfer/provider-relay
```

## Usage

```ts
import { createRelayProvider } from "@tasfer/provider-relay";

const provider = createRelayProvider({
  doc: editor.doc,
  room: "team-notes",
  relay: "wss://relay.tasfer.app",
  secret: roomSecret, // shared with peers out of band, never with the relay
});

provider.on("sync", ({ connected, peers }) => {
  status.textContent = connected ? `${peers} peer(s)` : "connecting…";
});
```

| Option   |                                                                             |
| -------- | --------------------------------------------------------------------------- |
| `doc`    | The document to sync — `editor.doc`, or a standalone `createDoc(...)`.      |
| `room`   | Logical room. Replicas sharing a room and relay converge.                   |
| `relay`  | Relay base URL, e.g. `wss://relay.tasfer.app`.                              |
| `secret` | Shared room secret — a passphrase or raw key bytes. `null` sends plaintext. |
| `peerId` | This replica's stable id. Defaults to `doc.peerId`.                         |

## What the relay can and cannot see

Document frames are sealed with **AES-256-GCM** under a key derived from
`secret`, so a relay operator forwards bytes they can neither read nor alter
undetected. Distribute the secret out of band — an invite link, your own auth —
and keep it away from the relay.

Three limits worth stating plainly:

- The relay still learns the **room name, peer ids, and the size and timing** of
  every frame.
- Every peer in a room shares one key, so the `from` field is unforgeable to the
  relay but **not to another peer** holding that key.
- `secret: null` disables all of it and hands the relay operator every document
  in the room. Only reasonable when you run the relay yourself, or already
  encrypt above this provider.

If you need the server out of the data path entirely, use
`@tasfer/provider-webrtc`.

## Presence

```ts
provider.presence.set({ name: "Ada", color: "#1db984" });
```

Bind presence to on-canvas remote carets with `bindPresenceCursors` from
[`@tasfer/provider-core/cursors`](https://www.npmjs.com/package/@tasfer/provider-core).

The low-level `RelayTransport` is exported too, for hosts that want to drive
`createProvider` from `@tasfer/provider-core` themselves.

## Documentation

[tasfer.app/docs/editor/collaboration](https://www.tasfer.app/docs/editor/collaboration)

## License

MIT
