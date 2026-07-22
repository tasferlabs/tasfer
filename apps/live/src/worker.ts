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
 *
 * A topic is the only capability in this system: it is either 32 random bytes
 * (an invite) or a SHA-256 digest, and knowing it is what grants a client
 * access to a room. TURN credentials are minted inside the room's DO for
 * connected members only (signal-room.ts) — never over anonymous HTTP —
 * because TURN relays whatever traffic the credential holder sends and is
 * billed to this account. A global daily mint budget (turn-budget.ts) bounds
 * the worst case.
 */

import type { Env } from "./env";

export { SignalRoom } from "./signal-room";
export { TurnBudget } from "./turn-budget";

/** Every topic is 32 bytes of hex — a random invite topic or a SHA-256 digest. */
const TOPIC_ROUTE = /^\/topic\/([a-f0-9]{64})$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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
