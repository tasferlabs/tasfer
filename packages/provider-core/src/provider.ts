/**
 * createProvider — the transport-agnostic sync protocol.
 *
 * Wires a {@link Doc} to a {@link Transport} so the doc converges with every
 * peer the transport reaches. The whole thing is four rules:
 *
 *   1. On peer join  → send that peer our version vector (`hello`).
 *   2. On `hello`     → reply with exactly the ops that peer is missing
 *                       (`doc.getOpsSince(theirVV)`).
 *   3. On `ops`       → `doc.applyUpdate(ops, PROVIDER)`. The version vector
 *                       drops anything we already have, so re-delivery is safe.
 *   4. On local edit  → broadcast the fresh ops to all peers.
 *
 * Echo control hinges on a single `origin` token. Every wire-applied batch is
 * tagged with `PROVIDER`; the `doc.on("update")` handler skips updates carrying
 * that origin, so ops we just received are never bounced back. Updates from any
 * OTHER origin — a local editor edit, or a second stacked provider such as
 * IndexedDB — ARE broadcast, which is exactly what you want.
 *
 * Assumes a (near-)complete mesh: every peer is connected to every other, so an
 * edit reaches everyone in one hop and remote ops are not re-gossiped. WebRTC
 * rooms and a shared BroadcastChannel bus both satisfy this.
 */

import type { Doc, Operation } from "@cypherkit/editor";
import { deserializeVV, serializeVV } from "@cypherkit/editor";

import type {
  Presence,
  PresenceState,
  Provider,
  RemotePresence,
  SyncState,
  Transport,
  TransportPeer,
} from "./types";
import { decodeMessage, encodeMessage, type WireMessage } from "./wire";

export interface CreateProviderOptions {
  /** The document to keep in sync. */
  doc: Doc;
  /** The pipe that reaches other replicas. */
  transport: Transport;
}

export function createProvider(options: CreateProviderOptions): Provider {
  const { doc, transport } = options;

  /** Origin stamped on every wire-applied batch — our echo guard. */
  const PROVIDER = Symbol("cypher-provider");

  /** Live peers, plus the unsubscribe fns to detach when they leave. */
  const peers = new Map<TransportPeer, () => void>();

  // ── Presence ──────────────────────────────────────────────────────────────
  let localPresence: PresenceState | null = null;
  const remotePresence = new Map<string, PresenceState>();
  const presenceListeners = new Set<(peers: RemotePresence[]) => void>();
  const syncListeners = new Set<(state: SyncState) => void>();

  const remotePresenceList = (): RemotePresence[] =>
    Array.from(remotePresence, ([peerId, state]) => ({ peerId, state }));

  const emitPresence = (): void => {
    const list = remotePresenceList();
    for (const cb of presenceListeners) cb(list);
  };

  const emitSync = (): void => {
    const state: SyncState = { connected: peers.size > 0, peers: peers.size };
    for (const cb of syncListeners) cb(state);
  };

  // ── Sending ─────────────────────────────────────────────────────────────--
  const sendTo = (peer: TransportPeer, msg: WireMessage): void => {
    peer.send(encodeMessage(msg));
  };

  const broadcast = (msg: WireMessage): void => {
    const bytes = encodeMessage(msg);
    for (const peer of peers.keys()) peer.send(bytes);
  };

  // ── Receiving ─────────────────────────────────────────────────────────────
  const handleMessage = (peer: TransportPeer, bytes: Uint8Array): void => {
    const msg = decodeMessage(bytes);
    if (!msg) return;

    switch (msg.t) {
      case "hello": {
        // The peer told us where it is — reply with what it lacks.
        const missing = doc.getOpsSince(deserializeVV(msg.vv));
        if (missing.length > 0) sendTo(peer, { t: "ops", ops: missing });
        // Catch a freshly-joined peer up on our presence too.
        if (localPresence) {
          sendTo(peer, { t: "pres", id: doc.peerId, state: localPresence });
        }
        break;
      }
      case "ops": {
        // applyUpdate de-dupes via the version vector; PROVIDER origin stops
        // the resulting doc update from being re-broadcast (rule 3 / echo guard).
        doc.applyUpdate(msg.ops as Operation[], PROVIDER);
        break;
      }
      case "pres": {
        if (msg.state === null) remotePresence.delete(msg.id);
        else remotePresence.set(msg.id, msg.state);
        emitPresence();
        break;
      }
    }
  };

  // ── Peer lifecycle ──────────────────────────────────────────────────────--
  const offJoin = transport.onPeerJoin((peer) => {
    if (peers.has(peer)) return;
    const offMessage = peer.onMessage((bytes) => handleMessage(peer, bytes));
    const offClose = peer.onClose(() => detachPeer(peer));
    peers.set(peer, () => {
      offMessage();
      offClose();
    });

    // Open the catch-up handshake: announce our version vector.
    sendTo(peer, { t: "hello", vv: serializeVV(doc.getVersionVector()) });
    emitSync();
  });

  const offLeave = transport.onPeerLeave((peerId) => {
    for (const peer of peers.keys()) {
      if (peer.id === peerId) detachPeer(peer);
    }
    if (remotePresence.delete(peerId)) emitPresence();
  });

  function detachPeer(peer: TransportPeer): void {
    const cleanup = peers.get(peer);
    if (!cleanup) return;
    cleanup();
    peers.delete(peer);
    if (remotePresence.delete(peer.id)) emitPresence();
    emitSync();
  }

  // ── Local edits → the wire ─────────────────────────────────────────────--
  // Anything that isn't our own wire-apply gets broadcast: local editor edits,
  // and ops a stacked provider (e.g. IndexedDB) loaded into the same doc.
  const offDoc = doc.on("update", (update) => {
    if (update.origin === PROVIDER) return;
    if (update.ops.length === 0) return;
    broadcast({ t: "ops", ops: update.ops });
  });

  void transport.connect();

  // ── Public surface ──────────────────────────────────────────────────────--
  const presence: Presence = {
    set(state) {
      localPresence = state;
      broadcast({ t: "pres", id: doc.peerId, state });
    },
    getLocal: () => localPresence,
    getRemote: remotePresenceList,
    on(_event, cb) {
      presenceListeners.add(cb);
      return () => presenceListeners.delete(cb);
    },
  };

  return {
    presence,
    getPeerIds: () => Array.from(peers.keys(), (p) => p.id),
    on(_event, cb) {
      syncListeners.add(cb);
      return () => syncListeners.delete(cb);
    },
    destroy() {
      offDoc();
      offJoin();
      offLeave();
      for (const cleanup of peers.values()) cleanup();
      peers.clear();
      remotePresence.clear();
      presenceListeners.clear();
      syncListeners.clear();
      transport.destroy();
    },
  };
}
