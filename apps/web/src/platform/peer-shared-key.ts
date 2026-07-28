/**
 * Derive a pairwise signaling key from the replicas' Ed25519 identities.
 *
 * Space membership distributes public keys already. Converting each replica's
 * own Ed25519 secret and the remote public key to X25519 gives both endpoints
 * the same secret without an inviter distributing another credential.
 */

const ED25519_PKCS8_PREFIX = "302e020100300506032b657004220420";
const HEX_32_BYTES = /^[a-f0-9]{64}$/i;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[a-f0-9]+$/i.test(hex)) {
    throw new Error("Invalid hexadecimal key");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function ed25519Seed(privateKey: string): Uint8Array {
  if (HEX_32_BYTES.test(privateKey)) return hexToBytes(privateKey);
  if (
    privateKey.length === ED25519_PKCS8_PREFIX.length + 64 &&
    privateKey.toLowerCase().startsWith(ED25519_PKCS8_PREFIX)
  ) {
    return hexToBytes(privateKey.slice(ED25519_PKCS8_PREFIX.length));
  }
  throw new Error("Unsupported Ed25519 private key format");
}

export async function deriveIdentitySharedSignalingKey(
  privateKey: string,
  localPublicKey: string,
  remotePublicKey: string,
): Promise<string> {
  if (!HEX_32_BYTES.test(localPublicKey) || !HEX_32_BYTES.test(remotePublicKey)) {
    throw new Error("Signaling identities must be 32-byte Ed25519 public keys");
  }

  const seed = ed25519Seed(privateKey);
  const { ed25519, x25519 } = await import("@noble/curves/ed25519.js");
  if (bytesToHex(ed25519.getPublicKey(seed)) !== localPublicKey.toLowerCase()) {
    throw new Error("Identity private key does not match its public key");
  }

  const localSecret = ed25519.utils.toMontgomerySecret(seed);
  const remotePublic = ed25519.utils.toMontgomery(hexToBytes(remotePublicKey));
  const sharedSecret = x25519.getSharedSecret(localSecret, remotePublic);
  const sorted =
    localPublicKey < remotePublicKey
      ? `${localPublicKey}:${remotePublicKey}`
      : `${remotePublicKey}:${localPublicKey}`;
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    sharedSecret,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode("tasfer-identity-signaling:" + sorted),
    },
    keyMaterial,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}
