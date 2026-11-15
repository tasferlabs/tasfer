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
 * It hashes the room name into the wire topic the server routes on — the room
 * name is the capability here, so only its digest ever leaves the client —
 * then builds a {@link WebrtcTransport} and hands it to the transport-agnostic
 * `createProvider`. Swapping transports (relay, BroadcastChannel, your own) is a
 * different factory over the same protocol — nothing else changes.
 */

import type { Doc } from "@tasfer/editor";
import { createProvider, type Provider } from "@tasfer/provider-core";

import { WebrtcTransport } from "./transport";

/**
 * Options for {@link createWebrtcProvider}: the document, the room, the
 * signaling server and, if you need them, your own ICE servers.
 */
export interface CreateWebrtcProviderOptions {
  /** The document to sync. Use `editor.doc`, or a standalone `createDoc(...)`. */
  doc: Doc;
  /**
   * The room name. Everyone in the same room on the same signaling server edits
   * the same document. The server sees only a hash of it. Anyone who knows the
   * name can join, so make it hard to guess.
   */
  room: string;
  /** Signaling base URL, e.g. "wss://relay.example.com". */
  signaling: string;
  /** This replica's stable id. Defaults to `doc.peerId`. */
  peerId?: string;
  /**
   * ICE servers that help peers find a direct route to each other. Defaults to
   * Google's public STUN server, `stun:stun.l.google.com:19302`.
   */
  iceServers?: RTCIceServer[];
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Sync a document with everyone in the same room over direct WebRTC
 * connections. The signaling server only introduces peers to each other. It
 * sees a hash of the room name, and the document does not pass through it.
 * Anyone who knows the room name can join, so use one that is hard to guess.
 * Two peers whose direct connection fails do not sync with each other.
 *
 * ```ts
 * const provider = createWebrtcProvider({
 *   doc: editor.doc,
 *   room: "team-notes-7f3k2q",
 *   signaling: "wss://signal.example.com",
 * });
 * provider.on("sync", (s) => console.log(s.connected, s.peers));
 * ```
 */
export function createWebrtcProvider(
  options: CreateWebrtcProviderOptions,
): Provider {
  const transport = new WebrtcTransport({
    topic: sha256Hex(options.room),
    signaling: options.signaling,
    peerId: options.peerId ?? options.doc.peerId,
    iceServers: options.iceServers,
  });
  return createProvider({ doc: options.doc, transport });
}
