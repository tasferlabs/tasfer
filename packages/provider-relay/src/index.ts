/**
 * @tasfer/provider-relay — document sync through a WebSocket relay.
 *
 * Attach to any `@tasfer/editor` Doc to sync it with peers in the same room
 * through a relay server that blindly forwards frames between them. The
 * network-relay sibling of the WebRTC provider — the fit when direct P2P is
 * blocked but a relay is reachable.
 *
 *   const provider = createRelayProvider({ doc: editor.doc, room, relay });
 *
 * ⚠ This transport does NOT encrypt. Frames reach the relay as base64-encoded
 * plaintext, so the relay operator can read and modify every document. Unlike
 * `@tasfer/provider-webrtc` — whose DataChannels are DTLS-encrypted end to
 * end — a relay is a party to your data. Run one you control, or put a
 * transport-level encryption layer in front of this.
 *
 * The low-level {@link RelayTransport} is exported too, for hosts that want to
 * drive `createProvider` from `@tasfer/provider-core` themselves.
 */

export {
  createRelayProvider,
  type CreateRelayProviderOptions,
} from "./provider";
export { RelayTransport, type RelayTransportOptions } from "./transport";
