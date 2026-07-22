/**
 * SignalRoom — Cloudflare Durable Object
 *
 * One instance per discovery topic. Manages WebSocket connections for peers
 * in the same topic and forwards encrypted signaling/relay blobs between them.
 *
 * Uses the WebSocket Hibernation API so the DO sleeps when idle and wakes
 * on incoming messages — near-zero cost when no one is signaling.
 *
 * This server is zero-trust: all signaling payloads (SDP offers, ICE
 * candidates, relay data) arrive pre-encrypted by the client. The DO
 * sees only opaque strings and forwards them without inspection.
 *
 * Protocol (JSON over WebSocket):
 *
 *   Client → DO:
 *     { type: "signal", target, data }   — forward encrypted SDP/ICE
 *     { type: "relay",  target, data }   — forward encrypted relay data
 *     { type: "turn-request" }           — request TURN credentials
 *
 *   DO → Client:
 *     { type: "peers",     peerIds }     — existing peers (on connect)
 *     { type: "peer-join", peerId }      — a new peer joined
 *     { type: "peer-left", peerId }      — a peer left
 *     { type: "signal",    from, data }  — forwarded encrypted SDP/ICE
 *     { type: "relay",     from, data }  — forwarded encrypted relay data
 *     { type: "turn-response", iceServers } / { type: "turn-response", error }
 *
 * TURN credentials are minted only over an accepted socket, so room
 * membership — not a client address — is the unit of rate limiting: one
 * cached mint serves the whole room for CREDENTIAL_CACHE_MS, a per-peer
 * throttle absorbs misbehaving clients, and a global daily budget
 * (turn-budget.ts) bounds the account's worst-case TURN bill.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { mintTurnCredentials } from "./turn";

/**
 * How long one minted credential is served to the whole room. Must stay under
 * TURN_TTL_SECONDS minus the client refresh interval (30 min), so a served
 * credential is always alive until its holder's next refresh.
 */
const CREDENTIAL_CACHE_MS = 20 * 60 * 1000;

/**
 * Per-peer turn-request ceiling. A sane client sends at most ~2/min while
 * flapping (join + failure cooldown). In-memory: hibernation resets it,
 * which only loosens the throttle.
 */
const TURN_REQUESTS_PER_MINUTE = 5;

interface CachedCredentials {
  iceServers: unknown;
  mintedAt: number;
}

export class SignalRoom extends DurableObject<Env> {
  private turnThrottle = new Map<string, { windowStart: number; count: number }>();
  /** Coalesces concurrent cache misses into one upstream mint. */
  private mintInFlight: Promise<{ iceServers: unknown } | { error: string }> | null = null;
  /**
   * Handle incoming HTTP request — upgrade to WebSocket.
   * The peerId is passed as a query parameter so we can tag the socket
   * for hibernation-safe peer lookup.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const peerId = url.searchParams.get("peerId");
    if (!peerId) {
      return new Response("Missing peerId", { status: 400 });
    }

    // Reject non-WebSocket requests
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Evict any previous socket for this peerId (a reconnect takes over its
    // identity). Otherwise the stale socket shadows the new one in signal
    // routing, and its eventual close would broadcast a spurious peer-left
    // that tears down the reconnected peer everywhere.
    for (const stale of this.ctx.getWebSockets(peerId)) {
      try { stale.close(4000, "replaced by a newer connection"); } catch { /* already gone */ }
    }

    // Accept with peerId as tag (survives hibernation)
    this.ctx.acceptWebSocket(server, [peerId]);

    // Collect existing peer IDs (excluding the new one)
    const existingPeerIds: string[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === server) continue;
      const tags = this.ctx.getTags(ws);
      if (tags.length > 0) existingPeerIds.push(tags[0]);
    }

    // Send peer list to the new connection
    server.send(JSON.stringify({ type: "peers", peerIds: existingPeerIds }));

    // Notify existing peers about the new arrival
    const joinMsg = JSON.stringify({ type: "peer-join", peerId });
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== server) {
        try { ws.send(joinMsg); } catch { /* stale socket, will be cleaned up */ }
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Handle incoming WebSocket message (hibernation-safe).
   * Only signal and relay messages are expected — both are forwarded as-is.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return; // Ignore malformed messages
    }

    const fromId = this.ctx.getTags(ws)[0];
    if (!fromId) return;

    if (msg.type === "turn-request") {
      await this.handleTurnRequest(ws, fromId);
      return;
    }

    if (msg.type === "signal" || msg.type === "relay") {
      // Guard the tag lookup: getWebSockets(undefined) would match every socket.
      if (typeof msg.target !== "string") return;
      const target = this.findPeer(msg.target);
      if (target) {
        try {
          target.send(JSON.stringify({
            type: msg.type,
            from: fromId,
            data: msg.data,
          }));
        } catch { /* stale socket */ }
      }
    }
  }

  /**
   * Handle WebSocket close (hibernation-safe).
   * Notify remaining peers that this peer left.
   */
  async webSocketClose(ws: WebSocket): Promise<void> {
    const peerId = this.ctx.getTags(ws)[0];
    if (!peerId) return;

    // A replacement socket with the same peerId may still be connected (this
    // close is an eviction, not a departure) — the peer is not gone.
    for (const peer of this.ctx.getWebSockets(peerId)) {
      if (peer !== ws) return;
    }

    this.turnThrottle.delete(peerId);

    const leaveMsg = JSON.stringify({ type: "peer-left", peerId });
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) {
        try { peer.send(leaveMsg); } catch { /* stale socket */ }
      }
    }
  }

  /**
   * Handle WebSocket error — treat same as close.
   */
  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /** Find a connected peer's WebSocket by peerId tag. */
  private findPeer(peerId: string): WebSocket | undefined {
    return this.ctx.getWebSockets(peerId)[0];
  }

  // ---------------------------------------------------------------------------
  // TURN credential minting (room members only — see module docstring)
  // ---------------------------------------------------------------------------

  private async handleTurnRequest(ws: WebSocket, peerId: string): Promise<void> {
    if (!this.allowTurnRequest(peerId)) {
      this.sendTurnResponse(ws, { error: "rate-limited" });
      return;
    }

    // Storage-backed so the cache survives hibernation.
    const cached = await this.ctx.storage.get<CachedCredentials>("turn-credentials");
    if (cached && Date.now() - cached.mintedAt < CREDENTIAL_CACHE_MS) {
      this.sendTurnResponse(ws, { iceServers: cached.iceServers });
      return;
    }

    if (!this.env.TURN_KEY_ID || !this.env.TURN_API_TOKEN) {
      this.sendTurnResponse(ws, { error: "unavailable" });
      return;
    }

    if (!this.mintInFlight) {
      this.mintInFlight = this.mintAndCache().finally(() => {
        this.mintInFlight = null;
      });
    }
    let result: { iceServers: unknown } | { error: string };
    try {
      result = await this.mintInFlight;
    } catch {
      result = { error: "unavailable" };
    }
    this.sendTurnResponse(ws, result);
  }

  private async mintAndCache(): Promise<{ iceServers: unknown } | { error: string }> {
    const budget = this.env.TURN_BUDGET.get(this.env.TURN_BUDGET.idFromName("global"));
    if (!(await budget.tryConsume())) return { error: "budget-exhausted" };

    const iceServers = await mintTurnCredentials(this.env);
    if (iceServers === null) return { error: "unavailable" };

    await this.ctx.storage.put<CachedCredentials>("turn-credentials", {
      iceServers,
      mintedAt: Date.now(),
    });
    return { iceServers };
  }

  private allowTurnRequest(peerId: string): boolean {
    const now = Date.now();
    const entry = this.turnThrottle.get(peerId);
    if (!entry || now - entry.windowStart >= 60_000) {
      this.turnThrottle.set(peerId, { windowStart: now, count: 1 });
      return true;
    }
    entry.count++;
    return entry.count <= TURN_REQUESTS_PER_MINUTE;
  }

  private sendTurnResponse(ws: WebSocket, body: { iceServers?: unknown; error?: string }): void {
    try {
      ws.send(JSON.stringify({ type: "turn-response", ...body }));
    } catch { /* stale socket */ }
  }
}
