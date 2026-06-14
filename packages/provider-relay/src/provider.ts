/**
 * createRelayProvider — the one call a host makes.
 *
 *   import { createRelayProvider } from "@cypherkit/provider-relay";
 *
 *   const provider = createRelayProvider({
 *     doc: editor.doc,
 *     room: "team-notes",
 *     relay: "wss://relay.cypher.md",
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

import type { Doc } from "@cypherkit/editor";
import { createProvider, type Provider } from "@cypherkit/provider-core";

import { RelayTransport } from "./transport";

export interface CreateRelayProviderOptions {
  /** The document to sync. Use `editor.doc`, or a standalone `createDoc(...)`. */
  doc: Doc;
  /** Logical room — replicas sharing a room (and relay server) converge. */
  room: string;
  /** Relay base URL, e.g. "wss://relay.cypher.md". */
  relay: string;
  /** This replica's stable id. Defaults to `doc.peerId`. */
  peerId?: string;
}

export function createRelayProvider(
  options: CreateRelayProviderOptions,
): Provider {
  const transport = new RelayTransport({
    room: options.room,
    relay: options.relay,
    peerId: options.peerId ?? options.doc.peerId,
  });
  return createProvider({ doc: options.doc, transport });
}
