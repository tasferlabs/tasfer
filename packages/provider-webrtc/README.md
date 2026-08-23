# @tasfer/provider-webrtc

**Direct peer-to-peer sync** for [`@tasfer/editor`](https://www.npmjs.com/package/@tasfer/editor).
Peers exchange document operations over WebRTC DataChannels — a small signaling
step introduces them, and after that the data flows browser to browser with no
server in the path.

The lowest-latency transport, and the one that keeps your document off every
machine but the peers'.

## Install

```bash
npm install @tasfer/editor @tasfer/provider-core @tasfer/provider-webrtc
```

## Usage

```ts
import { createWebrtcProvider } from "@tasfer/provider-webrtc";

const provider = createWebrtcProvider({
  doc: editor.doc,
  room: "team-notes",
  signaling: "wss://relay.tasfer.app",
});

provider.on("sync", ({ connected, peers }) => {
  status.textContent = connected ? `${peers} peer(s)` : "connecting…";
});
```

Replicas sharing a room converge. The room name is hashed before it reaches the
signaling server, which sees only connection metadata — once ICE completes,
bytes flow peer-to-peer over DTLS.

| Option       |                                                                        |
| ------------ | ---------------------------------------------------------------------- |
| `doc`        | The document to sync — `editor.doc`, or a standalone `createDoc(...)`. |
| `room`       | Logical room. Replicas sharing one converge.                           |
| `signaling`  | Signaling base URL, e.g. `wss://relay.example.com`.                    |
| `peerId`     | This replica's stable id. Defaults to `doc.peerId`.                    |
| `iceServers` | Custom STUN/TURN servers.                                              |

## Presence

Cursors, names, and colors ride alongside the document without being persisted:

```ts
provider.presence.set({ name: "Ada", color: "#1db984" });
```

Bind them to on-canvas remote carets with `bindPresenceCursors` from
[`@tasfer/provider-core/cursors`](https://www.npmjs.com/package/@tasfer/provider-core).

The low-level `WebrtcTransport` is exported too, for hosts that want to drive
`createProvider` from `@tasfer/provider-core` themselves.

## Documentation

[tasfer.app/docs/editor/collaboration](https://www.tasfer.app/docs/editor/collaboration)

## License

MIT
