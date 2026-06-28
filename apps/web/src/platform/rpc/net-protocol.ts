/**
 * Network RPC protocol (Phase 3) — wire contract between the worker's
 * {@link NetworkProxy} and the elected transport-host tab's {@link serveNetwork}.
 *
 * WebRTC (`RTCPeerConnection`) can't run in a SharedWorker, so the worker's
 * `Replicator` drives a `NetworkDriver` proxy that forwards over this channel to
 * the one tab holding the `cypher-net` Web Lock, which runs the real WebRTC
 * driver and acts as a dumb modem. Peers and topics are referenced by id;
 * payloads are raw `Uint8Array`s. A peer is identified by `(topicId, peerId)`
 * where `peerId` is the remote public key.
 */

/** worker → host: drive the real NetworkDriver. */
export type NetCommand =
  | { t: "setLocalId"; id: string }
  | { t: "registerKey"; topicHex: string; key: Uint8Array }
  | { t: "unregisterKey"; topicHex: string }
  | { t: "join"; topicId: number; topic: Uint8Array }
  | { t: "topicDestroy"; topicId: number }
  | { t: "peerSend"; topicId: number; peerId: string; data: Uint8Array }
  | { t: "peerClose"; topicId: number; peerId: string }
  | { t: "destroy" };

/** host → worker: report peer lifecycle and inbound data. */
export type NetEvent =
  | { t: "peerJoin"; topicId: number; peerId: string }
  | { t: "peerLeave"; topicId: number; peerId: string }
  | { t: "peerMsg"; topicId: number; peerId: string; data: Uint8Array }
  | { t: "peerClose"; topicId: number; peerId: string };
