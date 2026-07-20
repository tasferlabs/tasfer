/**
 * WebCrypto driver (Ed25519).
 *
 * `crypto.subtle` is available in both window and worker contexts (in a secure
 * context), so this is shared by the tab adapter (`web.ts`), the SharedWorker
 * engine host, and the Capacitor adapter.
 *
 * Ed25519 landed in WebCrypto only recently (Chromium 137, Safari 17). Older
 * Android System WebViews expose `crypto.subtle` but not the Ed25519 curve, so
 * each operation falls back to a JS implementation (`@noble/curves`) when the
 * native path throws. The fallback is lazy-loaded via dynamic `import()`, so it
 * is fetched only on those devices and never enters the primary bundle. Every
 * other WebCrypto primitive this app uses (SHA-256, HKDF, AES-GCM) has shipped
 * in every WebView for a decade and is assumed present.
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

// Lazy, cached loader for the JS Ed25519 fallback. Only resolves on WebViews
// that lack native Ed25519 — modern engines never import it.
let ed25519Promise: Promise<
  typeof import("@noble/curves/ed25519.js").ed25519
> | null = null;
function loadEd25519() {
  if (!ed25519Promise) {
    ed25519Promise = import("@noble/curves/ed25519.js").then((m) => m.ed25519);
  }
  return ed25519Promise;
}

// RFC 8410 PKCS#8 prefix for a raw 32-byte Ed25519 private key. Storing the
// fallback key in PKCS#8 form (identical to crypto.subtle's `exportKey("pkcs8")`
// output) keeps identities portable: a key generated on an old WebView still
// imports natively after an OS/WebView update adds Ed25519.
const ED25519_PKCS8_PREFIX = "302e020100300506032b657004220420";

function ed25519SeedFromPrivateKey(privateKey: string): Uint8Array {
  if (privateKey.length === 64) return hexToBytes(privateKey);
  if (
    privateKey.length === ED25519_PKCS8_PREFIX.length + 64 &&
    privateKey.startsWith(ED25519_PKCS8_PREFIX)
  ) {
    return hexToBytes(privateKey.slice(ED25519_PKCS8_PREFIX.length));
  }
  throw new Error("Unsupported Ed25519 private key format");
}

export class WebCryptoDriver implements CryptoDriver {
  async generateKeypair(): Promise<{ publicKey: string; privateKey: string }> {
    try {
      const keyPair = await crypto.subtle.generateKey(
        { name: "Ed25519" } as any,
        true,
        ["sign", "verify"],
      );
      const publicKeyRaw = await crypto.subtle.exportKey(
        "raw",
        keyPair.publicKey,
      );
      const privateKeyRaw = await crypto.subtle.exportKey(
        "pkcs8",
        keyPair.privateKey,
      );
      return {
        publicKey: bytesToHex(new Uint8Array(publicKeyRaw)),
        privateKey: bytesToHex(new Uint8Array(privateKeyRaw)),
      };
    } catch {
      // Ed25519 is still missing in some Android System WebView versions.
      const ed25519 = await loadEd25519();
      const seed = ed25519.utils.randomSecretKey();
      return {
        publicKey: bytesToHex(ed25519.getPublicKey(seed)),
        privateKey: ED25519_PKCS8_PREFIX + bytesToHex(seed),
      };
    }
  }

  async sign(privateKey: string, message: Uint8Array): Promise<string> {
    try {
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
    } catch {
      const ed25519 = await loadEd25519();
      return bytesToHex(
        ed25519.sign(message, ed25519SeedFromPrivateKey(privateKey)),
      );
    }
  }

  async verify(
    publicKey: string,
    signature: string,
    message: Uint8Array,
  ): Promise<boolean> {
    try {
      const keyData = hexToBytes(publicKey);
      const key = await crypto.subtle.importKey(
        "raw",
        keyData.buffer as ArrayBuffer,
        { name: "Ed25519" } as any,
        false,
        ["verify"],
      );
      const sig = hexToBytes(signature);
      return await crypto.subtle.verify(
        "Ed25519" as any,
        key,
        sig.buffer as ArrayBuffer,
        message.buffer as ArrayBuffer,
      );
    } catch {
      const ed25519 = await loadEd25519();
      return ed25519.verify(
        hexToBytes(signature),
        message,
        hexToBytes(publicKey),
      );
    }
  }
}
