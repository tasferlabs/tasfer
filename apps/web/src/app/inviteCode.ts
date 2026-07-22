/**
 * Invite code wire format: secret (32B) + expiresAt (8B, big-endian unix ms)
 * + spaceId (≤16B, zero-padded), base64-encoded. The signaling topic is not
 * carried — it is derived from the secret (see `deriveInviteTopic` in
 * platform/sync.ts).
 */

import type { SpaceInvite } from "@/platform/types";

const SECRET_BYTES = 32;
const EXPIRY_BYTES = 8;
const SPACE_ID_BYTES = 16;
const CODE_BYTES = SECRET_BYTES + EXPIRY_BYTES + SPACE_ID_BYTES;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function encodeInvite(invite: SpaceInvite): string {
  const bytes = new Uint8Array(CODE_BYTES);
  bytes.set(hexToBytes(invite.secret), 0);
  new DataView(bytes.buffer).setBigUint64(
    SECRET_BYTES,
    BigInt(invite.expiresAt),
  );
  bytes.set(
    new TextEncoder().encode(invite.spaceId).subarray(0, SPACE_ID_BYTES),
    SECRET_BYTES + EXPIRY_BYTES,
  );
  return btoa(String.fromCharCode(...bytes));
}

export function decodeInvite(code: string): SpaceInvite | null {
  try {
    const str = atob(code.trim());
    if (str.length !== CODE_BYTES) return null;
    const bytes = new Uint8Array(CODE_BYTES);
    for (let i = 0; i < CODE_BYTES; i++) bytes[i] = str.charCodeAt(i);
    const secret = bytesToHex(bytes.subarray(0, SECRET_BYTES));
    const expiresAt = Number(
      new DataView(bytes.buffer).getBigUint64(SECRET_BYTES),
    );
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
    const raw = bytes.subarray(SECRET_BYTES + EXPIRY_BYTES, CODE_BYTES);
    const end = raw.indexOf(0);
    const spaceId = new TextDecoder().decode(
      raw.subarray(0, end >= 0 ? end : SPACE_ID_BYTES),
    );
    return { secret, spaceId, expiresAt };
  } catch {
    return null;
  }
}

/** True once the invite's expiry has passed. */
export function isInviteExpired(invite: SpaceInvite): boolean {
  return invite.expiresAt <= Date.now();
}

/**
 * Mint a client-side invite that is never persisted — used for the QR tab,
 * where the invite must die with the dialog. The TTL is only a backstop; the
 * dialog cancels the pairing session on close.
 */
export function mintEphemeralInvite(
  spaceId: string,
  ttlMs: number,
): SpaceInvite {
  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return { secret: bytesToHex(bytes), spaceId, expiresAt: Date.now() + ttlMs };
}
