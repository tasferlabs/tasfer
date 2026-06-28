/**
 * WebCrypto driver (Ed25519).
 *
 * `crypto.subtle` is available in both window and worker contexts, so this is
 * shared by the tab adapter (`web.ts`) and the SharedWorker engine host.
 */

import type { CryptoDriver } from "../driver";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export class WebCryptoDriver implements CryptoDriver {
  async generateKeypair(): Promise<{ publicKey: string; privateKey: string }> {
    const keyPair = await crypto.subtle.generateKey(
      { name: "Ed25519" } as any,
      true,
      ["sign", "verify"],
    );
    const publicKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    const privateKeyRaw = await crypto.subtle.exportKey(
      "pkcs8",
      keyPair.privateKey,
    );
    return {
      publicKey: bytesToHex(new Uint8Array(publicKeyRaw)),
      privateKey: bytesToHex(new Uint8Array(privateKeyRaw)),
    };
  }

  async sign(privateKey: string, message: Uint8Array): Promise<string> {
    const keyData = hexToBytes(privateKey);
    const key = await crypto.subtle.importKey(
      "pkcs8",
      keyData.buffer as ArrayBuffer,
      { name: "Ed25519" } as any,
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "Ed25519" as any,
      key,
      message.buffer as ArrayBuffer,
    );
    return bytesToHex(new Uint8Array(signature));
  }

  async verify(
    publicKey: string,
    signature: string,
    message: Uint8Array,
  ): Promise<boolean> {
    const keyData = hexToBytes(publicKey);
    const key = await crypto.subtle.importKey(
      "raw",
      keyData.buffer as ArrayBuffer,
      { name: "Ed25519" } as any,
      false,
      ["verify"],
    );
    const sig = hexToBytes(signature);
    return crypto.subtle.verify(
      "Ed25519" as any,
      key,
      sig.buffer as ArrayBuffer,
      message.buffer as ArrayBuffer,
    );
  }
}
