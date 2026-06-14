/**
 * @cypherkit/provider-relay — document sync through a WebSocket relay.
 *
 * Attach to any `@cypherkit/editor` Doc to sync it with peers in the same room
 * through a relay server that blindly forwards opaque, end-to-end-encrypted
 * frames it cannot read. The network-relay sibling of the WebRTC provider — the
 * fit when direct P2P is blocked but a relay is reachable.
 *
 *   const provider = createRelayProvider({ doc: editor.doc, room, relay });
 *
 * The low-level {@link RelayTransport} is exported too, for hosts that want to
 * drive `createProvider` from `@cypherkit/provider-core` themselves.
 */

export {
  createRelayProvider,
  type CreateRelayProviderOptions,
} from "./provider";
export { RelayTransport, type RelayTransportOptions } from "./transport";
