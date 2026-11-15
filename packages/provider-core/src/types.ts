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
  /**
   * Send bytes to this peer. They must arrive complete and in order. Splitting
   * large messages is up to the transport, as the WebRTC transport does.
   */
  send(bytes: Uint8Array): void;
  /** Subscribe to bytes from this peer. Returns an unsubscribe fn. */
  onMessage(cb: (bytes: Uint8Array) => void): () => void;
  /** Fires once when this peer disconnects. Returns an unsubscribe fn. */
  onClose(cb: () => void): () => void;
}

/**
 * The connection under a provider. It finds peers in a room and gives you each
 * one as a {@link TransportPeer}. After `connect()`, it reports peers joining
 * and leaving through events. Implement it to sync over your own backend.
 */
export interface Transport {
  /**
   * Start finding peers. Calling it more than once must be safe. If it returns
   * a promise that rejects, the provider logs the error.
   */
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
  /** `true` while at least one peer is connected. */
  connected: boolean;
  /** Number of currently-connected peers. */
  peers: number;
}

/**
 * Presence for one peer, like a cursor color or display name. It travels with
 * the document but is never saved in it. You choose its shape. The provider
 * only passes it along.
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
  /**
   * Call `cb` with every other peer's presence when one of them sets, changes
   * or clears it, or leaves. Returns a function that stops listening.
   */
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
  /** Stop syncing and close the transport. The document itself is kept. */
  destroy(): void;
}
