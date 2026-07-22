/**
 * Cloudflare Calls TURN credential minting.
 *
 * TURN relays whatever traffic the credential holder sends and is billed to
 * this account, so minting is gated by the caller (signal-room.ts): only
 * connected room members can request credentials, mints are cached per room,
 * and a global daily budget (turn-budget.ts) bounds the worst case.
 */

import type { Env } from "./env";

/**
 * Credential lifetime. Sized so a credential outlives its holders' refresh
 * cycle: the room cache serves a mint for up to 20 minutes and clients
 * refresh every 30, keeping ~10 minutes of margin at worst.
 */
export const TURN_TTL_SECONDS = 3600;

/** Upstream call budget for the Cloudflare Calls API. */
const TURN_FETCH_TIMEOUT_MS = 5000;

/**
 * Mint short-lived TURN credentials. The API token never leaves the server —
 * callers only ever see the derived credentials. Returns the `iceServers`
 * entry, or null when the upstream call fails.
 */
export async function mintTurnCredentials(env: Env): Promise<unknown | null> {
  let res: Response;
  try {
    res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.TURN_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
        signal: AbortSignal.timeout(TURN_FETCH_TIMEOUT_MS),
      },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;

  try {
    const body = await res.json() as { iceServers?: unknown };
    return body.iceServers ?? null;
  } catch {
    return null;
  }
}
