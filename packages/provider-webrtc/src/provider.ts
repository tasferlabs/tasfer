/**
 * createWebrtcProvider — the one call a host makes.
 *
 *   import { createWebrtcProvider } from "@tasfer/provider-webrtc";
 *
 *   const provider = createWebrtcProvider({
 *     doc: editor.doc,
 *     room: "team-notes",
 *     signaling: "wss://relay.example.com",
 *   });
 *
 *   provider.on("sync", (s) => {
 *     status.textContent = s.connected ? `live · ${s.peers} peer(s)` : "offline";
 *   });
 *
 * It just builds a {@link WebrtcTransport} and hands it to the transport-agnostic
 * `createProvider`. Swapping transports (relay, BroadcastChannel, your own) is a
 * different factory over the same protocol — nothing else changes.
 */

import type { Doc } from "@tasfer/editor";
import { createProvider, type Provider } from "@tasfer/provider-core";

import { WebrtcTransport } from "./transport";

export interface CreateWebrtcProviderOptions {
  /** The document to sync. Use `editor.doc`, or a standalone `createDoc(...)`. */
  doc: Doc;
  /** Logical room — replicas sharing a room (and signaling server) converge. */
  room: string;
  /** Signaling base URL, e.g. "wss://relay.example.com". */
  signaling: string;
  /** This replica's stable id. Defaults to `doc.peerId`. */
  peerId?: string;
  /** ICE servers. Defaults to a public STUN server. */
  iceServers?: RTCIceServer[];
}

export function createWebrtcProvider(
  options: CreateWebrtcProviderOptions,
): Provider {
  const transport = new WebrtcTransport({
    room: options.room,
    signaling: options.signaling,
    peerId: options.peerId ?? options.doc.peerId,
    iceServers: options.iceServers,
  });
  return createProvider({ doc: options.doc, transport });
}
