/**
 * A {@link Transport} over the browser's BroadcastChannel — zero infrastructure
 * sync between same-origin contexts (tabs, iframes, or two panes on one page).
 *
 * It exists for two reasons: it makes examples and tests runnable with no
 * server, and it is the smallest possible proof that the protocol is
 * transport-agnostic — `createProvider` cannot tell this apart from WebRTC.
 *
 * BroadcastChannel is a shared bus (a sender never receives its own posts), so
 * peers find each other with a two-step handshake: a broadcast `join`, answered
 * by a direct `announce`. Frames are addressed by peer id; structured clone
 * carries the `Uint8Array` payloads as-is.
 */

import type { Transport, TransportPeer } from "./types";

type Envelope =
  | { kind: "join"; from: string }
  | { kind: "announce"; from: string; to: string }
  | { kind: "data"; from: string; to: string; data: Uint8Array }
  | { kind: "leave"; from: string };

class BcPeer implements TransportPeer {
  readonly id: string;
  private readonly post: (data: Uint8Array) => void;
  private readonly messageListeners = new Set<(b: Uint8Array) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(id: string, post: (data: Uint8Array) => void) {
    this.id = id;
    this.post = post;
  }

  send(bytes: Uint8Array): void {
    this.post(bytes);
  }

  onMessage(cb: (b: Uint8Array) => void): () => void {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  _receive(bytes: Uint8Array): void {
    for (const cb of this.messageListeners) cb(bytes);
  }

  _close(): void {
    for (const cb of this.closeListeners) cb();
    this.messageListeners.clear();
    this.closeListeners.clear();
  }
}

class BroadcastChannelTransport implements Transport {
  private readonly name: string;
  private readonly localId: string;
  private channel: BroadcastChannel | null = null;
  private readonly peers = new Map<string, BcPeer>();
  private readonly joinListeners = new Set<(p: TransportPeer) => void>();
  private readonly leaveListeners = new Set<(id: string) => void>();

  constructor(name: string, localId: string) {
    this.name = name;
    this.localId = localId;
  }

  connect(): void {
    if (this.channel) return;
    const channel = new BroadcastChannel(this.name);
    this.channel = channel;
    channel.onmessage = (e: MessageEvent<Envelope>) => this.onEnvelope(e.data);
    channel.postMessage({ kind: "join", from: this.localId } as Envelope);
  }

  private register(remoteId: string): void {
    if (remoteId === this.localId || this.peers.has(remoteId)) return;
    const peer = new BcPeer(remoteId, (data) => {
      this.channel?.postMessage({
        kind: "data",
        from: this.localId,
        to: remoteId,
        data,
      } as Envelope);
    });
    this.peers.set(remoteId, peer);
    for (const cb of this.joinListeners) cb(peer);
  }

  private onEnvelope(env: Envelope): void {
    switch (env.kind) {
      case "join":
        // A newcomer announced itself — register it, then tell it we exist.
        this.register(env.from);
        this.channel?.postMessage({
          kind: "announce",
          from: this.localId,
          to: env.from,
        } as Envelope);
        break;
      case "announce":
        if (env.to === this.localId) this.register(env.from);
        break;
      case "data":
        if (env.to === this.localId) {
          // Self-register the sender if we haven't seen it yet: a `data` frame
          // can outrun the `announce` that would register it, and dropping it
          // would lose a catch-up `hello`. register() is idempotent.
          this.register(env.from);
          this.peers.get(env.from)?._receive(env.data);
        }
        break;
      case "leave":
        this.drop(env.from);
        break;
    }
  }

  private drop(remoteId: string): void {
    const peer = this.peers.get(remoteId);
    if (!peer) return;
    this.peers.delete(remoteId);
    peer._close();
    for (const cb of this.leaveListeners) cb(remoteId);
  }

  onPeerJoin(cb: (p: TransportPeer) => void): () => void {
    this.joinListeners.add(cb);
    return () => this.joinListeners.delete(cb);
  }

  onPeerLeave(cb: (id: string) => void): () => void {
    this.leaveListeners.add(cb);
    return () => this.leaveListeners.delete(cb);
  }

  getPeers(): TransportPeer[] {
    return Array.from(this.peers.values());
  }

  destroy(): void {
    this.channel?.postMessage({ kind: "leave", from: this.localId } as Envelope);
    for (const id of Array.from(this.peers.keys())) this.drop(id);
    this.channel?.close();
    this.channel = null;
    this.joinListeners.clear();
    this.leaveListeners.clear();
  }
}

/**
 * Create a BroadcastChannel transport. All replicas using the same `room`
 * string on the same origin converge.
 *
 * @param room     channel name — same string ⇒ same room.
 * @param localId  this replica's stable id (pass `doc.peerId`).
 */
export function createBroadcastChannelTransport(
  room: string,
  localId: string,
): Transport {
  return new BroadcastChannelTransport(`tasfer-provider:${room}`, localId);
}
