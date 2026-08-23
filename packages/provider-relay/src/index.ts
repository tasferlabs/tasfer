/**
 * @tasfer/provider-relay — document sync through a WebSocket relay.
 *
 * Attach to any `@tasfer/editor` Doc to sync it with peers in the same room
 * through a relay server that blindly forwards frames between them. The
 * network-relay sibling of the WebRTC provider — the fit when direct P2P is
 * blocked but a relay is reachable.
 *
 *   const provider = createRelayProvider({ doc: editor.doc, room, relay, secret });
 *
 * Document frames are sealed with AES-256-GCM under a key derived from
 * `secret`, so the relay forwards ciphertext it cannot read or alter. Every
 * peer in the room needs the same secret; distribute it out of band and keep
 * it away from the relay. `secret: null` opts out and sends plaintext.
 *
 * The relay still learns the room name, peer ids, and traffic timing — and
 * peers sharing the key can forge each other's ids. `@tasfer/provider-webrtc`
 * is the transport that keeps the server out of the data path entirely.
 *
 * The low-level {@link RelayTransport} is exported too, for hosts that want to
 * drive `createProvider` from `@tasfer/provider-core` themselves.
 */

export {
  createRelayProvider,
  type CreateRelayProviderOptions,
} from "./provider";
export { RelayTransport, type RelayTransportOptions } from "./transport";
