/**
 * Wire frames arrive from peers the transport does not authenticate, so
 * `decodeMessage` is the boundary that keeps malformed input away from the
 * CRDT. The protocol dereferences `vv`, `ops` and `state` immediately after
 * decoding — `doc.applyUpdate(undefined)` and `deserializeVV(undefined)` both
 * throw, and the throw escapes into the transport's message callback, faulting
 * the receiver's message pump.
 */

import { describe, expect, it } from "vitest";

import { decodeMessage, encodeMessage, type WireMessage } from "./wire";

const enc = new TextEncoder();
/** Frame a raw JSON string the way a hostile peer would. */
const frame = (json: string): Uint8Array => enc.encode(json);

describe("decodeMessage", () => {
  it("round-trips each message kind", () => {
    const messages: WireMessage[] = [
      { t: "hello", vv: { peerA: 3, peerB: 0 } },
      { t: "ops", ops: [{ id: "peerA:1" } as never] },
      { t: "pres", state: { name: "Ada" } },
      { t: "pres", state: null },
    ];
    for (const msg of messages) {
      expect(decodeMessage(encodeMessage(msg))).toEqual(msg);
    }
  });

  it("accepts an empty version vector and an empty op batch", () => {
    expect(decodeMessage(frame('{"t":"hello","vv":{}}'))).toEqual({ t: "hello", vv: {} });
    expect(decodeMessage(frame('{"t":"ops","ops":[]}'))).toEqual({ t: "ops", ops: [] });
  });

  it.each([
    ["not JSON", "}{"],
    ["not an object", '"hello"'],
    ["null", "null"],
    ["an array", "[]"],
    ["an unknown discriminant", '{"t":"evil"}'],
    ["no discriminant", "{}"],
  ])("rejects %s", (_label, json) => {
    expect(decodeMessage(frame(json))).toBeNull();
  });

  it.each([
    ["hello with no vv", '{"t":"hello"}'],
    ["hello with a null vv", '{"t":"hello","vv":null}'],
    ["hello with an array vv", '{"t":"hello","vv":[]}'],
    ["hello with a non-numeric counter", '{"t":"hello","vv":{"peerA":"9"}}'],
  ])("rejects %s (deserializeVV would throw)", (_label, json) => {
    expect(decodeMessage(frame(json))).toBeNull();
  });

  it.each([
    ["ops with no ops", '{"t":"ops"}'],
    ["ops with a null ops", '{"t":"ops","ops":null}'],
    ["ops with a non-array ops", '{"t":"ops","ops":{}}'],
    ["ops holding a primitive", '{"t":"ops","ops":[1]}'],
    ["ops holding null", '{"t":"ops","ops":[null]}'],
  ])("rejects %s (applyUpdate would throw)", (_label, json) => {
    expect(decodeMessage(frame(json))).toBeNull();
  });

  it.each([
    ["pres with no state", '{"t":"pres"}'],
    ["pres with a primitive state", '{"t":"pres","state":"x"}'],
    ["pres with an array state", '{"t":"pres","state":[]}'],
  ])("rejects %s", (_label, json) => {
    expect(decodeMessage(frame(json))).toBeNull();
  });

  it("ignores a self-declared peer id on a pres frame", () => {
    // Presence is attributed to the TransportPeer it arrived on. An `id` on the
    // wire is not part of the protocol and must not become the presence key.
    const decoded = decodeMessage(frame('{"t":"pres","id":"victim","state":{}}'));
    expect(decoded).toEqual({ t: "pres", id: "victim", state: {} });
    // The provider keys presence by `peer.id`; nothing reads `id` off the frame.
    expect(encodeMessage({ t: "pres", state: {} })).toEqual(
      enc.encode('{"t":"pres","state":{}}'),
    );
  });
});
