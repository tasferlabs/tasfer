/**
 * TURN credentials for the portable relay.
 *
 * Two sources, in the order a self-hoster is likely to have them:
 *
 *   1. **coturn** — a shared secret and a URL. Credentials are derived here,
 *      never stored: `username` is an expiry timestamp, `credential` is its
 *      HMAC under the secret, which is exactly what coturn's
 *      `use-auth-secret` mode verifies. Nothing is called upstream, so this
 *      costs a hash per mint.
 *   2. **Cloudflare Calls** — the same two secrets the Worker deployment uses
 *      (`TURN_KEY_ID`, `TURN_API_TOKEN`), for anyone who already has a key.
 *      That one is billed per byte relayed, so it keeps the Worker's daily
 *      mint ceiling.
 *
 * With neither configured the relay says so and peers run STUN-only, falling
 * back to relaying their (encrypted) traffic through this server.
 */

import crypto from "node:crypto";

/** Upstream call budget for the Cloudflare Calls API, as in apps/live. */
const CLOUDFLARE_FETCH_TIMEOUT_MS = 5000;

/**
 * Daily ceiling on Cloudflare mints — the billing backstop the Worker keeps in
 * a Durable Object. One relay process is one counter; a fleet behind a load
 * balancer gets one per process, which is a looser bound but still a bound.
 */
const CLOUDFLARE_DAILY_MINT_BUDGET = 5000;

export interface TurnConfig {
  /** coturn URL(s), comma-separated: `turn:turn.example.org:3478`. */
  url?: string;
  /** coturn `static-auth-secret`. */
  secret?: string;
  ttlSeconds: number;
  cloudflareKeyId?: string;
  cloudflareApiToken?: string;
}

export type TurnSource = "coturn" | "cloudflare" | "none";

export function turnSource(config: TurnConfig): TurnSource {
  if (config.url && config.secret) return "coturn";
  if (config.cloudflareKeyId && config.cloudflareApiToken) return "cloudflare";
  return "none";
}

/** An `iceServers` payload, or null when none can be produced. */
export async function mintCredentials(
  config: TurnConfig,
): Promise<unknown | null> {
  switch (turnSource(config)) {
    case "coturn":
      return mintCoturn(config);
    case "cloudflare":
      return mintCloudflare(config);
    case "none":
      return null;
  }
}

/**
 * coturn's REST-API credential: `username` is the expiry (optionally
 * `expiry:user`), `credential` is base64(HMAC-SHA1(secret, username)).
 */
function mintCoturn(config: TurnConfig): unknown {
  const urls = splitUrls(config.url!);
  const username = `${Math.floor(Date.now() / 1000) + config.ttlSeconds}`;
  const credential = crypto
    .createHmac("sha1", config.secret!)
    .update(username)
    .digest("base64");

  const servers: unknown[] = [];
  // A STUN entry from the same host, so a self-hoster's peers never fall back
  // to someone else's STUN server to learn their reflexive address.
  const stunUrls = urls.map(toStunUrl).filter((url): url is string => !!url);
  if (stunUrls.length > 0) servers.push({ urls: stunUrls });
  servers.push({ urls, username, credential });
  return servers;
}

function splitUrls(value: string): string[] {
  return value
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

/** `turn:host:3478?transport=tcp` → `stun:host:3478`. Null if unrecognised. */
function toStunUrl(turnUrl: string): string | null {
  const match = turnUrl.match(/^turns?:([^?]+)/);
  if (!match) return null;
  return `stun:${match[1]}`;
}

let cloudflareBudget = { day: "", count: 0 };

async function mintCloudflare(config: TurnConfig): Promise<unknown | null> {
  const today = new Date().toISOString().slice(0, 10);
  if (cloudflareBudget.day !== today) cloudflareBudget = { day: today, count: 0 };
  if (cloudflareBudget.count >= CLOUDFLARE_DAILY_MINT_BUDGET) return null;
  cloudflareBudget.count++;

  let res: Response;
  try {
    res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${config.cloudflareKeyId}/credentials/generate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.cloudflareApiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: config.ttlSeconds }),
        signal: AbortSignal.timeout(CLOUDFLARE_FETCH_TIMEOUT_MS),
      },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;

  try {
    const body = (await res.json()) as { iceServers?: unknown };
    return body.iceServers ?? null;
  } catch {
    return null;
  }
}
