# @tasfer/provider-core

The **transport-agnostic sync protocol** behind every
[`@tasfer/editor`](https://www.npmjs.com/package/@tasfer/editor) provider.
Pair a CRDT `Doc` with a pipe and the two replicas converge: version vectors are
exchanged, missing operations are sent, and new ones stream in real time after
catch-up.

Most apps never import this directly — they install a transport package
(`@tasfer/provider-webrtc`, `@tasfer/provider-relay`) that wraps it. Reach for
it when you want to sync over something of your own.

## Install

```bash
npm install @tasfer/editor @tasfer/provider-core
```

## Usage

```ts
import { createProvider } from "@tasfer/provider-core";

const provider = createProvider({ doc: editor.doc, transport });

provider.on("sync", ({ connected, peers }) => {
  status.textContent = connected ? `${peers} peer(s)` : "offline";
});
```

## Bring your own transport

A transport only has to discover peers and move opaque bytes between them.
Implement `Transport` and you can sync over a relay, a `BroadcastChannel`, a
file watcher, or your own backend:

```ts
interface Transport {
  connect(): Promise<void> | void;
  onPeerJoin(cb: (peer: TransportPeer) => void): () => void;
  onPeerLeave(cb: (peerId: string) => void): () => void;
  getPeers(): TransportPeer[];
  destroy(): void;
}
```

Each `TransportPeer` exposes `send(bytes)`, `onMessage(cb)`, and `onClose(cb)`.
Framing is the transport's problem; ordering and losslessness are its contract.

`createBroadcastChannelTransport` ships in the box — same-origin tab-to-tab sync,
and a working reference implementation to read.

## Presence

Presence is ephemeral state that travels alongside the document but is never
persisted. The protocol routes whatever object you publish:

```ts
provider.presence.set({ name: "Ada", color: "#1db984" });

provider.presence.on("change", (peers) => {
  avatars.render(peers.map((p) => p.state.name));
});
```

To turn presence into remote carets and selections, bind it to the editor with
the helper from the `/cursors` subpath — kept out of the base entry so a
non-editor consumer of the protocol pays no editor coupling:

```ts
import { bindPresenceCursors } from "@tasfer/provider-core/cursors";

const stop = bindPresenceCursors(editor, provider, {
  user: { peerId, name: "Ada", color: "#1db984" },
});
```

## Documentation

[tasfer.app/docs/editor/collaboration](https://www.tasfer.app/docs/editor/collaboration)

## License

MIT
