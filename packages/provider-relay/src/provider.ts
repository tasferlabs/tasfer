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

export interface CreateRelayProviderOptions {
  /** The document to sync. Use `editor.doc`, or a standalone `createDoc(...)`. */
  doc: Doc;
  /** Logical room — replicas sharing a room (and relay server) converge. */
  room: string;
  /** Relay base URL, e.g. "wss://relay.tasfer.app". */
  relay: string;
  /** This replica's stable id. Defaults to `doc.peerId`. */
  peerId?: string;
  /**
   * Shared room secret — a passphrase or raw key bytes, distributed to peers
   * out of band (an invite link, your own auth). Document frames are sealed
   * with AES-256-GCM under a key derived from it, so the relay forwards bytes
   * it cannot read.
   *
   * `null` opts out and sends plaintext, which hands the relay operator every
   * document in the room. Only reasonable when you run the relay yourself, or
   * already encrypt above this provider.
   */
  secret: string | Uint8Array | null;
}

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
