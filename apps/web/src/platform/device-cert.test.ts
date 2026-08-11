import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";

import type { CryptoDriver } from "./driver";
import {
  deviceCertMessage,
  issueDeviceCert,
  verifyDeviceCert,
} from "./device-cert";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const hexToBytes = (value: string) => {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < value.length; i += 2) {
    bytes[i / 2] = Number.parseInt(value.slice(i, i + 2), 16);
  }
  return bytes;
};

/** Ed25519 over raw hex seeds — the same contract WebCryptoDriver implements. */
const crypto: CryptoDriver = {
  async generateKeypair() {
    const seed = ed25519.utils.randomSecretKey();
    return { publicKey: hex(ed25519.getPublicKey(seed)), privateKey: hex(seed) };
  },
  async sign(privateKey, message) {
    return hex(ed25519.sign(message, hexToBytes(privateKey)));
  },
  async verify(publicKey, signature, message) {
    return ed25519.verify(hexToBytes(signature), message, hexToBytes(publicKey));
  },
};

const seed = (fill: number) => {
  const bytes = new Uint8Array(32).fill(fill);
  return { priv: hex(bytes), pub: hex(ed25519.getPublicKey(bytes)) };
};

const ROOT = seed(1);
const OTHER_ROOT = seed(2);
const DEVICE = seed(3);
const OTHER_DEVICE = seed(4);
const ISSUED_AT = 1_760_000_000_000;

describe("device certificates", () => {
  it("verifies a certificate the root actually issued", async () => {
    const cert = await issueDeviceCert(
      crypto,
      ROOT.priv,
      ROOT.pub,
      DEVICE.pub,
      ISSUED_AT,
    );

    expect(cert.rootKey).toBe(ROOT.pub);
    expect(cert.deviceKey).toBe(DEVICE.pub);
    await expect(verifyDeviceCert(crypto, cert)).resolves.toBe(true);
  });

  it("is deterministic, so re-issuing produces identical bytes", async () => {
    const first = await issueDeviceCert(
      crypto,
      ROOT.priv,
      ROOT.pub,
      DEVICE.pub,
      ISSUED_AT,
    );
    const second = await issueDeviceCert(
      crypto,
      ROOT.priv,
      ROOT.pub,
      DEVICE.pub,
      ISSUED_AT,
    );

    expect(second.cert).toBe(first.cert);
  });

  it("rejects a certificate re-pointed at another device", async () => {
    const cert = await issueDeviceCert(
      crypto,
      ROOT.priv,
      ROOT.pub,
      DEVICE.pub,
      ISSUED_AT,
    );

    // The attack this guards: claim someone else's device is yours by reusing
    // a signature you legitimately hold.
    await expect(
      verifyDeviceCert(crypto, { ...cert, deviceKey: OTHER_DEVICE.pub }),
    ).resolves.toBe(false);
  });

  it("rejects a certificate re-pointed at another root", async () => {
    const cert = await issueDeviceCert(
      crypto,
      ROOT.priv,
      ROOT.pub,
      DEVICE.pub,
      ISSUED_AT,
    );

    await expect(
      verifyDeviceCert(crypto, { ...cert, rootKey: OTHER_ROOT.pub }),
    ).resolves.toBe(false);
  });

  it("rejects a certificate whose issuedAt was altered", async () => {
    const cert = await issueDeviceCert(
      crypto,
      ROOT.priv,
      ROOT.pub,
      DEVICE.pub,
      ISSUED_AT,
    );

    await expect(
      verifyDeviceCert(crypto, { ...cert, issuedAt: ISSUED_AT + 1 }),
    ).resolves.toBe(false);
  });

  it("returns false rather than throwing on malformed input", async () => {
    const cases = [
      { rootKey: "nothex", deviceKey: DEVICE.pub, cert: "00", issuedAt: 1 },
      { rootKey: ROOT.pub, deviceKey: "short", cert: "00", issuedAt: 1 },
      { rootKey: ROOT.pub, deviceKey: DEVICE.pub, cert: "zz", issuedAt: 1 },
      { rootKey: ROOT.pub, deviceKey: DEVICE.pub, cert: "00", issuedAt: 0 },
    ];

    for (const candidate of cases) {
      await expect(verifyDeviceCert(crypto, candidate)).resolves.toBe(false);
    }
  });

  it("normalises key case so a differently-encoded peer still verifies", async () => {
    const cert = await issueDeviceCert(
      crypto,
      ROOT.priv,
      ROOT.pub,
      DEVICE.pub,
      ISSUED_AT,
    );

    await expect(
      verifyDeviceCert(crypto, {
        ...cert,
        deviceKey: DEVICE.pub.toUpperCase(),
      }),
    ).resolves.toBe(true);
  });

  it("binds no display name, so renaming a device keeps its certificate", () => {
    const message = deviceCertMessage(ROOT.pub, DEVICE.pub, ISSUED_AT);
    expect(new TextDecoder().decode(message)).toBe(
      `tasfer-device-cert:v1|${ROOT.pub}|${DEVICE.pub}|${ISSUED_AT}`,
    );
  });
});
