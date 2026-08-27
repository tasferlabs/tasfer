/**
 * Ed25519 driver — node:crypto.
 *
 * Key encoding is the one every other platform uses: the public key is the raw
 * 32 bytes as hex, the private key is its PKCS#8 DER as hex. An identity is
 * therefore portable — a data directory copied from a desktop install keeps
 * working here, and the certificates this host signs verify in the app.
 */

import crypto from "node:crypto";
import type { CryptoDriver } from "@/platform/driver";

/** DER prefix of an Ed25519 SPKI: 12 bytes of header, then the raw key. */
const SPKI_HEADER = Buffer.from("302a300506032b6570032100", "hex");

export class NodeCryptoDriver implements CryptoDriver {
  async generateKeypair(): Promise<{ publicKey: string; privateKey: string }> {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    return {
      publicKey: publicKey.subarray(SPKI_HEADER.length).toString("hex"),
      privateKey: privateKey.toString("hex"),
    };
  }

  async sign(privateKeyHex: string, message: Uint8Array): Promise<string> {
    const key = crypto.createPrivateKey({
      key: Buffer.from(privateKeyHex, "hex"),
      format: "der",
      type: "pkcs8",
    });
    return crypto.sign(null, message, key).toString("hex");
  }

  async verify(
    publicKeyHex: string,
    signatureHex: string,
    message: Uint8Array,
  ): Promise<boolean> {
    try {
      const key = crypto.createPublicKey({
        key: Buffer.concat([SPKI_HEADER, Buffer.from(publicKeyHex, "hex")]),
        format: "der",
        type: "spki",
      });
      return crypto.verify(
        null,
        message,
        key,
        Buffer.from(signatureHex, "hex"),
      );
    } catch {
      // A malformed key or signature is a failed verification, not a crash:
      // both arrive from remote peers.
      return false;
    }
  }
}
