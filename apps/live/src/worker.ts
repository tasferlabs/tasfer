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
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Upgrade, Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Protocol",
        },
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
