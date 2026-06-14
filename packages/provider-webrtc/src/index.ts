/**
 * @cypherkit/provider-webrtc — direct peer-to-peer document sync.
 *
 * Attach to any `@cypherkit/editor` Doc to sync it with peers over WebRTC
 * DataChannels (a small signaling step introduces them; data is P2P after that).
 *
 *   const provider = createWebrtcProvider({ doc: editor.doc, room, signaling });
 *
 * The low-level {@link WebrtcTransport} is exported too, for hosts that want to
 * drive `createProvider` from `@cypherkit/provider-core` themselves.
 */

export {
  createWebrtcProvider,
  type CreateWebrtcProviderOptions,
} from "./provider";
export { WebrtcTransport, type WebrtcTransportOptions } from "./transport";
