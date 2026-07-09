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
 *
 * A `pres` frame does not name the peer it describes. The receiver attributes
 * it to the {@link TransportPeer} it arrived on, which is the only identity the
 * transport actually authenticates — a self-declared id would let any peer
 * overwrite or delete another peer's presence.
 */

import type { Operation } from "@cypherkit/editor";

import type { PresenceState } from "./types";

export type WireMessage =
  | { t: "hello"; vv: Record<string, number> }
  | { t: "ops"; ops: Operation[] }
  | { t: "pres"; state: PresenceState | null };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeMessage(msg: WireMessage): Uint8Array {
  return encoder.encode(JSON.stringify(msg));
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Decode a frame, or null if it is not a well-formed protocol message.
 *
 * A frame is remote input from an unauthenticated peer, so every field the
 * protocol later dereferences is checked here. Checking only the `t`
 * discriminant would let `{"t":"ops"}` through, and `doc.applyUpdate(undefined)`
 * throws out of the transport's message callback — one malformed frame from any
 * peer would fault the receiver's message pump.
 */
export function decodeMessage(bytes: Uint8Array): WireMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(decoder.decode(bytes));
  } catch {
    return null; /* malformed frame — ignore */
  }
  if (!isObject(msg)) return null;

  switch (msg.t) {
    case "hello":
      // Values are per-peer op counters; `deserializeVV` does Object.entries.
      if (!isObject(msg.vv)) return null;
      if (!Object.values(msg.vv).every((n) => typeof n === "number")) return null;
      return msg as WireMessage;

    case "ops":
      // Op *shape* is the schema's business, but it must at least be a list of
      // objects — `applyUpdate` indexes into each one.
      if (!Array.isArray(msg.ops)) return null;
      if (!msg.ops.every(isObject)) return null;
      return msg as WireMessage;

    case "pres":
      if (msg.state !== null && !isObject(msg.state)) return null;
      return msg as WireMessage;

    default:
      return null;
  }
}
