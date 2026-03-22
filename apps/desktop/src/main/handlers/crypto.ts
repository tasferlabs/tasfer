/**
 * Crypto handlers — Ed25519 keypair generation via Node's crypto module.
 */

import { ipcMain } from "electron";
import crypto from "crypto";

export function registerCryptoHandlers() {
  ipcMain.handle("crypto:generateKeypair", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });

    // Extract raw 32-byte public key from DER-encoded SPKI
    // Ed25519 SPKI is 44 bytes: 12-byte header + 32-byte key
    const publicKeyHex = publicKey.subarray(12).toString("hex");
    const privateKeyHex = privateKey.toString("hex");

    return { publicKey: publicKeyHex, privateKey: privateKeyHex };
  });

  ipcMain.handle("crypto:sign", (_event, privateKeyHex: string, messageBuffer: ArrayBuffer) => {
    const privateKeyDer = Buffer.from(privateKeyHex, "hex");
    const key = crypto.createPrivateKey({
      key: privateKeyDer,
      format: "der",
      type: "pkcs8",
    });
    const signature = crypto.sign(null, Buffer.from(messageBuffer), key);
    return signature.toString("hex");
  });

  ipcMain.handle(
    "crypto:verify",
    (_event, publicKeyHex: string, signatureHex: string, messageBuffer: ArrayBuffer) => {
      // Reconstruct SPKI DER from raw 32-byte public key
      const rawKey = Buffer.from(publicKeyHex, "hex");
      const spkiHeader = Buffer.from("302a300506032b6570032100", "hex");
      const spkiDer = Buffer.concat([spkiHeader, rawKey]);
      const key = crypto.createPublicKey({
        key: spkiDer,
        format: "der",
        type: "spki",
      });
      return crypto.verify(null, Buffer.from(messageBuffer), key, Buffer.from(signatureHex, "hex"));
    },
  );
}
