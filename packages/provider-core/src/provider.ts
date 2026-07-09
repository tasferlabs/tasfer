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
 * Assumes a COMPLETE mesh: every peer is connected to every other, so an edit
 * reaches everyone in one hop and remote ops are not re-gossiped. A shared
 * BroadcastChannel bus satisfies this by construction, and so does a relay that
 * forwards to every room member.
 *
 * WebRTC does not, always. `@cypherkit/provider-webrtc` drops a peer whose ICE
 * negotiation fails, which is routine between two symmetric NATs with no TURN.
 * If A–B and B–C connect but A–C does not, B never forwards A's ops to C, and
 * the only catch-up — the `hello` handshake — runs once, at join. A and C then
 * stay divergent for as long as the session lasts, silently.
 *
 * Closing that hole needs either op re-gossip or periodic anti-entropy (re-send
 * `hello` on a timer). Until then a transport MUST deliver a complete mesh, or
 * accept that partitions do not heal.
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
          sendTo(peer, { t: "pres", state: localPresence });
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
        // Attributed to the peer it arrived on, never to a self-declared id:
        // that is the only identity the transport authenticates, and it is the
        // key `detachPeer`/`onPeerLeave` clean up under. Trusting the wire
        // would let a peer overwrite another's cursor and would strand the
        // entry forever once that peer left.
        if (msg.state === null) remotePresence.delete(peer.id);
        else remotePresence.set(peer.id, msg.state);
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

  // A transport that cannot reach its server rejects here. Nothing awaits this,
  // so an unhandled rejection would take down a Node/worker host; report it and
  // let the caller observe connectivity through the `sync` event instead.
  void Promise.resolve(transport.connect()).catch((err: unknown) => {
    console.error("[provider] transport failed to connect:", err);
  });

  // ── Public surface ──────────────────────────────────────────────────────--
  const presence: Presence = {
    set(state) {
      localPresence = state;
      broadcast({ t: "pres", state });
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
