/**
 * Cloudflare Worker — Entry Point
 *
 * Routes incoming WebSocket upgrade requests to the appropriate
 * SignalRoom Durable Object based on the topic hex in the URL.
 *
 * URL format: /topic/{topicHex}?peerId={peerId}
 *             /topic/{topicHex}/turn-credentials
 *
 * Each unique topicHex maps to one Durable Object instance.
 * The Worker is stateless — all state lives in the DOs.
 *
 * A topic is the only capability in this system: it is either 32 random bytes
 * (an invite) or a SHA-256 digest, and knowing it is what grants a client
 * access to a room. TURN credentials are therefore minted only for a caller
 * that can name a topic, rate-limited per IP, and short-lived — an endpoint
 * that hands them to any anonymous caller is a bandwidth bill waiting to
 * happen, since TURN relays whatever traffic the credential holder sends.
 */

export { SignalRoom } from "./signal-room";

/** Cloudflare Workers rate-limiting binding (see `[[ratelimits]]` in wrangler.toml). */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  SIGNAL_ROOM: DurableObjectNamespace;
  /** Cloudflare Calls TURN key ID — set via: wrangler secret put TURN_KEY_ID */
  TURN_KEY_ID: string;
  /** Cloudflare Calls TURN API token — set via: wrangler secret put TURN_API_TOKEN */
  TURN_API_TOKEN: string;
  /** Optional: without it, TURN minting is not rate-limited. */
  TURN_RATE_LIMITER?: RateLimiter;
}

/** Every topic is 32 bytes of hex — a random invite topic or a SHA-256 digest. */
const TOPIC_PATTERN = "[a-f0-9]{64}";
const TOPIC_ROUTE = new RegExp(`^/topic/(${TOPIC_PATTERN})$`, "i");
const TURN_ROUTE = new RegExp(`^/topic/(${TOPIC_PATTERN})/turn-credentials$`, "i");

/**
 * TURN credential lifetime. Kept short: the endpoint mints credentials for
 * anyone who knows a topic, so this is the window an leaked credential is
 * usable for. The client refreshes well inside it.
 */
const TURN_TTL_SECONDS = 3600;

/** Upstream call budget for the Cloudflare Calls API. */
const TURN_FETCH_TIMEOUT_MS = 5000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Upgrade, Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Protocol",
};

/**
 * Mint short-lived Cloudflare Calls TURN credentials. The API token never
 * leaves the Worker — the caller only ever sees the derived credentials.
 */
async function mintTurnCredentials(request: Request, env: Env): Promise<Response> {
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) {
    return new Response("TURN not configured", { status: 503, headers: CORS_HEADERS });
  }

  if (env.TURN_RATE_LIMITER) {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await env.TURN_RATE_LIMITER.limit({ key: ip });
    if (!success) {
      return new Response("Too many requests", { status: 429, headers: CORS_HEADERS });
    }
  }

  let cfRes: Response;
  try {
    cfRes = await fetch(
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
    return new Response("TURN provider unreachable", { status: 504, headers: CORS_HEADERS });
  }

  if (!cfRes.ok) {
    return new Response("Failed to fetch TURN credentials", { status: 502, headers: CORS_HEADERS });
  }

  return new Response(await cfRes.text(), {
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Route: GET /topic/{topicHex}/turn-credentials
    // Naming a topic is the capability check — see the module docstring.
    if (TURN_ROUTE.test(url.pathname)) {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
      }
      return mintTurnCredentials(request, env);
    }

    // Route: /topic/{topicHex}
    const match = url.pathname.match(TOPIC_ROUTE);
    if (!match) {
      return new Response("Not found. Use /topic/{topicHex}?peerId={peerId}", { status: 404 });
    }

    const topicHex = match[1].toLowerCase();

    // Derive a deterministic DO id from the topic
    const id = env.SIGNAL_ROOM.idFromName(topicHex);
    const stub = env.SIGNAL_ROOM.get(id);

    // Forward the request (including WebSocket upgrade) to the DO
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
