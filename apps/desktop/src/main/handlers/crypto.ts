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
}
