/**
 * Invite code wire format: secret (32B) + spaceId (≤16B, zero-padded),
 * base64-encoded. The signaling topic is not carried — it is derived from
 * the secret (see `deriveInviteTopic` in platform/sync.ts).
 */

import type { SpaceInvite } from "@/platform/types";

const SECRET_BYTES = 32;
const SPACE_ID_BYTES = 16;
const CODE_BYTES = SECRET_BYTES + SPACE_ID_BYTES;

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
  bytes.set(
    new TextEncoder().encode(invite.spaceId).subarray(0, SPACE_ID_BYTES),
    SECRET_BYTES,
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
    const raw = bytes.subarray(SECRET_BYTES, CODE_BYTES);
    const end = raw.indexOf(0);
    const spaceId = new TextDecoder().decode(
      raw.subarray(0, end >= 0 ? end : SPACE_ID_BYTES),
    );
    return { secret, spaceId };
  } catch {
    return null;
  }
}
