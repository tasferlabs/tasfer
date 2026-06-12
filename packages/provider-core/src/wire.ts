/**
 * The on-the-wire protocol between two replicas.
 *
 * Three message kinds, JSON-encoded as UTF-8 bytes. The encoding is
 * deliberately trivial — ops go over verbatim. A future optimization can slot
 * a codec in here (apps/web ships an op-shortcode + char-run compressor in
 * `platform/wire-codec.ts`) without touching the protocol or any transport.
 *
 *   hello — "here is my version vector"; sent to every peer on connect. The
 *           receiver replies with exactly the ops the sender is missing.
 *   ops   — a batch of operations (a catch-up reply, or a live local edit).
 *   pres  — ephemeral presence for one peer (cursor/name/…), never persisted.
 */

import type { Operation } from "@cypherkit/editor";

import type { PresenceState } from "./types";

export type WireMessage =
  | { t: "hello"; vv: Record<string, number> }
  | { t: "ops"; ops: Operation[] }
  | { t: "pres"; id: string; state: PresenceState | null };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeMessage(msg: WireMessage): Uint8Array {
  return encoder.encode(JSON.stringify(msg));
}

/** Decode a frame, or null if it is not a well-formed protocol message. */
export function decodeMessage(bytes: Uint8Array): WireMessage | null {
  try {
    const msg = JSON.parse(decoder.decode(bytes)) as WireMessage;
    if (msg && (msg.t === "hello" || msg.t === "ops" || msg.t === "pres")) {
      return msg;
    }
  } catch {
    /* malformed frame — ignore */
  }
  return null;
}
