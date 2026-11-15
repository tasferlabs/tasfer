/**
 * createRelayProvider — the one call a host makes.
 *
 *   import { createRelayProvider } from "@tasfer/provider-relay";
 *
 *   const provider = createRelayProvider({
 *     doc: editor.doc,
 *     room: "team-notes",
 *     relay: "wss://relay.tasfer.app",
 *     secret: roomSecret,          // shared out of band; the relay never sees it
 *   });
 *
 *   provider.on("sync", (s) => {
 *     status.textContent = s.connected ? `live · ${s.peers} peer(s)` : "offline";
 *   });
 *
 * It just builds a {@link RelayTransport} and hands it to the transport-agnostic
 * `createProvider`. Swapping transports (WebRTC, BroadcastChannel, your own) is a
 * different factory over the same protocol — nothing else changes.
 */

import type { Doc } from "@tasfer/editor";
import { createProvider, type Provider } from "@tasfer/provider-core";

import { RelayTransport } from "./transport";

/**
 * Options for {@link createRelayProvider}: the document, the room, the relay
 * server and the room's shared secret.
 */
export interface CreateRelayProviderOptions {
  /** The document to sync. Use `editor.doc`, or a standalone `createDoc(...)`. */
  doc: Doc;
  /**
   * The room name. Everyone in the same room on the same relay server edits the
   * same document. The relay sees this name.
   */
  room: string;
  /** Relay base URL, e.g. "wss://relay.tasfer.app". */
  relay: string;
  /** This replica's stable id. Defaults to `doc.peerId`. */
  peerId?: string;
  /**
   * The room's shared secret: a passphrase or raw key bytes. Share it with the
   * other peers yourself, for example in an invite link. Document data is
   * encrypted with AES-256-GCM using a key made from it, so the relay cannot
   * read it.
   *
   * `null` turns encryption off. Whoever runs the relay can then read and
   * change every document in the room. Only do this when you run the relay
   * yourself, or you already encrypt the data before this provider.
   */
  secret: string | Uint8Array | null;
}

/**
 * Sync a document with everyone in the same room through a WebSocket relay
 * server. Use it when peers cannot connect to each other directly. Document
 * data is encrypted with `secret` before it is sent, unless you pass `secret:
 * null`.
 *
 * ```ts
 * const provider = createRelayProvider({
 *   doc: editor.doc,
 *   room: "team-notes",
 *   relay: "wss://relay.example.com",
 *   secret: roomSecret, // every peer in the room uses the same one
 * });
 * provider.on("sync", (s) => console.log(s.connected, s.peers));
 * ```
 */
export function createRelayProvider(
  options: CreateRelayProviderOptions,
): Provider {
  const transport = new RelayTransport({
    room: options.room,
    relay: options.relay,
    peerId: options.peerId ?? options.doc.peerId,
    secret: options.secret,
  });
  return createProvider({ doc: options.doc, transport });
}
