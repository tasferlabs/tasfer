import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";

import { deriveIdentitySharedSignalingKey } from "./peer-shared-key";

const PKCS8_PREFIX = "302e020100300506032b657004220420";
const hex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

describe("identity-derived signaling keys", () => {
  it("derives the same isolated key at both ends of a replica-set edge", async () => {
    const aliceSeed = new Uint8Array(32).fill(1);
    const bobSeed = new Uint8Array(32).fill(2);
    const carolSeed = new Uint8Array(32).fill(3);
    const alicePublic = hex(ed25519.getPublicKey(aliceSeed));
    const bobPublic = hex(ed25519.getPublicKey(bobSeed));
    const carolPublic = hex(ed25519.getPublicKey(carolSeed));

    const aliceBob = await deriveIdentitySharedSignalingKey(
      PKCS8_PREFIX + hex(aliceSeed),
      alicePublic,
      bobPublic,
    );
    const bobAlice = await deriveIdentitySharedSignalingKey(
      hex(bobSeed),
      bobPublic,
      alicePublic,
    );
    const aliceCarol = await deriveIdentitySharedSignalingKey(
      PKCS8_PREFIX + hex(aliceSeed),
      alicePublic,
      carolPublic,
    );

    expect(aliceBob).toBe(bobAlice);
    expect(aliceBob).toMatch(/^[a-f0-9]{64}$/);
    expect(aliceCarol).not.toBe(aliceBob);
  });

  it("rejects a private key belonging to another identity", async () => {
    const aliceSeed = new Uint8Array(32).fill(1);
    const bobSeed = new Uint8Array(32).fill(2);

    await expect(
      deriveIdentitySharedSignalingKey(
        hex(aliceSeed),
        hex(ed25519.getPublicKey(bobSeed)),
        hex(ed25519.getPublicKey(aliceSeed)),
      ),
    ).rejects.toThrow("does not match");
  });
});
