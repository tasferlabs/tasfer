/**
 * @cypherkit/provider-core — the transport-agnostic sync protocol.
 *
 * Build a provider by pairing a `Doc` with a {@link Transport}:
 *
 *   import { createProvider } from "@cypherkit/provider-core";
 *   const provider = createProvider({ doc: editor.doc, transport });
 *
 * Transport packages (`@cypherkit/provider-webrtc`, …) wrap this so callers
 * never touch it directly — they call `createWebrtcProvider({ doc, room, … })`.
 * Implement {@link Transport} to sync over anything: a relay, a file watcher,
 * your own backend.
 */

export { createBroadcastChannelTransport } from "./broadcast-channel";
export { createProvider, type CreateProviderOptions } from "./provider";
export type {
  Presence,
  PresenceState,
  Provider,
  RemotePresence,
  SyncState,
  Transport,
  TransportPeer,
} from "./types";
export { decodeMessage, encodeMessage, type WireMessage } from "./wire";
