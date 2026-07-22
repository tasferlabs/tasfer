/**
 * A {@link Transport} over a WebSocket relay.
 *
 * The network-relay sibling of the WebRTC transport. Where WebRTC upgrades each
 * pair to a direct DataChannel, this keeps a single WebSocket to a relay server
 * that blindly forwards byte frames between the clients sharing a room — the
 * natural fit when direct P2P is blocked (symmetric NATs, no TURN) but a relay
 * is reachable.
 *
 * ── Trust ────────────────────────────────────────────────────────────────────
 * This transport applies NO cryptography. Frames are base64-encoded, not
 * encrypted, so a relay operator (or anyone who can observe the WebSocket) can
 * read and tamper with every document that passes through. The `from` field on
 * each envelope is self-asserted and unauthenticated, so a peer in the room can
 * also forge frames attributed to another peer.
 *
 * Treat the relay as a trusted party: run one you control, or wrap this
 * transport in one that encrypts and authenticates. The WebRTC transport is the
 * one that keeps the server out of the data path — its DataChannels are
 * DTLS-encrypted and, once ICE completes, bytes never touch the server.
 *
 * The relay is treated as a dumb broadcast bus (a sender never receives its own
 * posts), so peers find each other with the same handshake as the
 * BroadcastChannel transport: a broadcast `join`, answered by a direct
 * `announce`. Frames are addressed by peer id and carried as JSON text, with
 * `Uint8Array` payloads base64-encoded — the relay never has to parse them.
 *
 * ── Relay-server contract ────────────────────────────────────────────────────
 * A host-provided relay is generic and content-blind. To make this transport
 * work it must satisfy exactly three rules:
 *
 *   1. Group sockets by the `room` query param (`/?room=…&peerId=…`).
 *   2. Forward every received frame, verbatim, to all OTHER clients in that
 *      same room.
 *   3. Never echo a frame back to the sender that produced it.
 *
 * That is the whole contract — no payload parsing, no storage, no auth. (For
 * robustness this transport also ignores any envelope whose `from === localId`,
 * so a relay that does echo to the sender is merely wasteful, not broken.)
 */

import type { Transport, TransportPeer } from "@tasfer/provider-core";

/** Discovery + data envelopes exchanged over the relay, as JSON text frames. */
type Envelope =
  | { kind: "join"; from: string }
  | { kind: "announce"; from: string; to: string }
  | { kind: "data"; from: string; to: string; data: string }
  | { kind: "leave"; from: string };

/** Whether a decoded JSON frame is an {@link Envelope}. Frames are remote input. */
function isEnvelope(v: unknown): v is Envelope {
  if (typeof v !== "object" || v === null) return false;
  const env = v as Record<string, unknown>;
  if (typeof env.from !== "string") return false;
  switch (env.kind) {
    case "join":
    case "leave":
      return true;
    case "announce":
      return typeof env.to === "string";
    case "data":
      return typeof env.to === "string" && typeof env.data === "string";
    default:
      return false;
  }
}

/** Encode bytes for a JSON `data` envelope. */
function toB64(bytes: Uint8Array): string {
  // Convert in slices: spreading the whole array into String.fromCharCode
  // overflows the engine's argument limit on large frames (an initial CRDT
  // catch-up easily exceeds it).
  let binary = "";
  const SLICE = 0x8000;
  for (let i = 0; i < bytes.length; i += SLICE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + SLICE));
  }
  return btoa(binary);
}

/**
 * Decode the base64 payload of a `data` envelope back to bytes, or null if it
 * is not base64. `atob` throws on malformed input, and the payload comes
 * straight off the wire from an unauthenticated peer.
 */
function fromB64(b64: unknown): Uint8Array | null {
  if (typeof b64 !== "string") return null;
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

class RelayPeer implements TransportPeer {
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

export interface RelayTransportOptions {
  /** Logical room — replicas sharing a room (and relay server) converge. */
  room: string;
  /** Relay base URL, e.g. "wss://relay.tasfer.app". Trailing slash optional. */
  relay: string;
  /** This replica's stable id. Pass `doc.peerId`. */
  peerId: string;
}

export class RelayTransport implements Transport {
  private readonly room: string;
  private readonly relay: string;
  private readonly localId: string;

  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private destroyed = false;
  private readonly peers = new Map<string, RelayPeer>();
  private readonly joinListeners = new Set<(p: TransportPeer) => void>();
  private readonly leaveListeners = new Set<(id: string) => void>();

  constructor(options: RelayTransportOptions) {
    this.room = options.room;
    this.relay = options.relay.replace(/\/$/, "");
    this.localId = options.peerId;
  }

  connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      // Room + identity live in the query string so a generic, content-blind
      // relay can group sockets by room without parsing any payload.
      const url = `${this.relay}/?room=${encodeURIComponent(this.room)}&peerId=${encodeURIComponent(this.localId)}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        // Announce ourselves to whoever is already in the room.
        this.post({ kind: "join", from: this.localId });
        resolve();
      };
      ws.onerror = () =>
        reject(new Error(`[provider-relay] relay connection failed: ${url}`));
      ws.onmessage = (e) => this.onMessage(e.data as string);
      ws.onclose = () => {
        // The relay is the only path to peers, so a closed socket means they
        // are all gone. (Auto-reconnect is a clean follow-up.)
        for (const id of Array.from(this.peers.keys())) this.drop(id);
      };
    });
    return this.connecting;
  }

  /** Send one envelope as a JSON text frame, if the socket is open. */
  private post(env: Envelope): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(env));
    }
  }

  private onMessage(raw: string): void {
    if (this.destroyed) return;
    let env: unknown;
    try {
      env = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!isEnvelope(env)) return;
    // Guard against a relay that echoes to the sender: never treat our own
    // frames as a remote peer.
    if (env.from === this.localId) return;
    this.onEnvelope(env);
  }

  private register(remoteId: string): void {
    if (remoteId === this.localId || this.peers.has(remoteId)) return;
    const peer = new RelayPeer(remoteId, (data) => {
      this.post({
        kind: "data",
        from: this.localId,
        to: remoteId,
        data: toB64(data),
      });
    });
    this.peers.set(remoteId, peer);
    for (const cb of this.joinListeners) cb(peer);
  }

  private onEnvelope(env: Envelope): void {
    switch (env.kind) {
      case "join":
        // A newcomer announced itself — register it, then tell it we exist.
        this.register(env.from);
        this.post({ kind: "announce", from: this.localId, to: env.from });
        break;
      case "announce":
        if (env.to === this.localId) this.register(env.from);
        break;
      case "data": {
        if (env.to !== this.localId) break;
        const bytes = fromB64(env.data);
        if (!bytes) break;
        // Self-register the sender if we haven't seen it yet: a `data` frame
        // can outrun the `announce` that would register it, and dropping it
        // would lose a catch-up `hello`. register() is idempotent.
        this.register(env.from);
        this.peers.get(env.from)?._receive(bytes);
        break;
      }
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
    this.destroyed = true;
    this.post({ kind: "leave", from: this.localId });
    for (const id of Array.from(this.peers.keys())) this.drop(id);
    this.ws?.close();
    this.ws = null;
    this.joinListeners.clear();
    this.leaveListeners.clear();
  }
}
