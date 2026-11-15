/**
 * @tasfer/provider-webrtc — direct peer-to-peer document sync.
 *
 * Attach to any `@tasfer/editor` Doc to sync it with peers over WebRTC
 * DataChannels (a small signaling step introduces them; data is P2P after that).
 *
 *   const provider = createWebrtcProvider({ doc: editor.doc, room, signaling });
 */

export {
  createWebrtcProvider,
  type CreateWebrtcProviderOptions,
} from "./provider";

// Old exports kept for one more release, each marked `@deprecated`.
export * from "./deprecated/root";
