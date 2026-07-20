/**
 * The contracts a provider is built from.
 *
 * A "provider" is two halves:
 *
 *   1. a {@link Transport} — the pipe. It knows how to reach other replicas
 *      (WebRTC, a WebSocket relay, BroadcastChannel, …) and surfaces them as a
 *      set of {@link TransportPeer}s that can send/receive opaque bytes. It
 *      knows NOTHING about CRDTs, ops, or version vectors.
 *
 *   2. the protocol — {@link createProvider}, which drives a `Doc` over a
 *      Transport: version-vector catch-up on connect, op streaming on edit,
 *      presence, and `sync` events. This is identical for every transport, so
 *      it lives here once and each transport package only implements the pipe.
 *
 * This split is why `@tasfer/provider-webrtc` is ~150 lines: it implements
 * `Transport` and hands it to `createProvider`. A relay or IndexedDB provider
 * is the same shape with a different pipe.
 */

/** One reachable replica, as seen by the protocol. Mirrors a data channel. */
export interface TransportPeer {
  /** Stable remote identity (its `doc.peerId`). Used to de-dupe connections. */
  readonly id: string;
  /** Send opaque bytes to this peer. Lossless and ordered; framing is the
   *  transport's problem (e.g. the WebRTC transport chunks large frames). */
  send(bytes: Uint8Array): void;
  /** Subscribe to bytes from this peer. Returns an unsubscribe fn. */
  onMessage(cb: (bytes: Uint8Array) => void): () => void;
  /** Fires once when this peer disconnects. Returns an unsubscribe fn. */
  onClose(cb: () => void): () => void;
}

/**
 * The pipe. Discovers peers in a room and exposes them as {@link TransportPeer}s.
 * Everything below `connect()` is event-driven — the protocol reacts to peers
 * joining/leaving and to bytes arriving on each peer.
 */
export interface Transport {
  /** Begin discovery / open the underlying socket. Idempotent. */
  connect(): Promise<void> | void;
  /** A peer became reachable (its channel opened). */
  onPeerJoin(cb: (peer: TransportPeer) => void): () => void;
  /** A peer became unreachable. */
  onPeerLeave(cb: (peerId: string) => void): () => void;
  /** Currently-connected peers. */
  getPeers(): TransportPeer[];
  /** Tear down all connections and listeners. */
  destroy(): void;
}

/** Snapshot delivered to `provider.on("sync")` whenever connectivity changes. */
export interface SyncState {
  /** True once at least one peer is connected. */
  connected: boolean;
  /** Number of currently-connected peers. */
  peers: number;
}

/**
 * Ephemeral per-peer presence (cursor color, display name, …). Travels
 * alongside the document but is never persisted into the CRDT. The shape is
 * entirely up to the host — the protocol only routes it.
 */
export type PresenceState = Record<string, unknown>;

/** A remote peer's most recent presence. */
export interface RemotePresence {
  peerId: string;
  state: PresenceState;
}

/** The presence sub-API hung off a {@link Provider}. */
export interface Presence {
  /** Publish this replica's presence to all peers (replaces any prior value). */
  set(state: PresenceState): void;
  /** This replica's current published presence, or null if unset. */
  getLocal(): PresenceState | null;
  /** Every connected peer's latest presence (this replica excluded). */
  getRemote(): RemotePresence[];
  /** Subscribe to remote-presence changes (peer set/updated/left). */
  on(event: "change", cb: (peers: RemotePresence[]) => void): () => void;
}

/** The handle returned by `createProvider` / a `create*Provider` factory. */
export interface Provider {
  /** Ephemeral presence channel — cursors, names, colors. */
  readonly presence: Presence;
  /** ids of currently-connected peers. */
  getPeerIds(): string[];
  /** Subscribe to connectivity changes. Returns an unsubscribe fn. */
  on(event: "sync", cb: (state: SyncState) => void): () => void;
  /** Detach from the Doc and tear down the transport. */
  destroy(): void;
}
