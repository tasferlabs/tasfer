/**
 * @tasfer/provider-core — the transport-agnostic sync protocol.
 *
 * Build a provider by pairing a `Doc` with a {@link Transport}:
 *
 *   import { createProvider } from "@tasfer/provider-core";
 *   const provider = createProvider({ doc: editor.doc, transport });
 *
 * Transport packages (`@tasfer/provider-webrtc`, …) wrap this so callers
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

// Remote cursors & selections as editor decorations live in the `/cursors`
// subpath (it depends on @tasfer/editor; kept out of the base entry so a
// non-editor consumer of the protocol pays no editor coupling):
//   import { bindPresenceCursors } from "@tasfer/provider-core/cursors";
