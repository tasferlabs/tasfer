/**
 * Cloudflare Worker — Entry Point
 *
 * Routes incoming WebSocket upgrade requests to the appropriate
 * SignalRoom Durable Object based on the topic hex in the URL.
 *
 * URL format: /topic/{topicHex}?peerId={peerId}
 *
 * Each unique topicHex maps to one Durable Object instance.
 * The Worker is stateless — all state lives in the DOs.
 */

export { SignalRoom } from "./signal-room";

interface Env {
  SIGNAL_ROOM: DurableObjectNamespace;
  /** Cloudflare Calls TURN key ID — set in wrangler.toml [vars] */
  TURN_KEY_ID: string;
  /** Cloudflare Calls TURN API token — set via: wrangler secret put TURN_API_TOKEN */
  TURN_API_TOKEN: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Upgrade, Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Protocol",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Route: GET /turn-credentials
    // Returns short-lived Cloudflare Calls TURN credentials (TTL: 24h).
    // The API token never leaves the Worker — clients only see the credentials.
    if (url.pathname === "/turn-credentials" && request.method === "GET") {
      if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) {
        return new Response("TURN not configured", { status: 503 });
      }
      const cfRes = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.TURN_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl: 86400 }),
        },
      );
      if (!cfRes.ok) {
        return new Response("Failed to fetch TURN credentials", { status: 502 });
      }
      const body = await cfRes.text();
      return new Response(body, {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Route: /topic/{topicHex}
    const match = url.pathname.match(/^\/topic\/([a-f0-9]+)$/i);
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
