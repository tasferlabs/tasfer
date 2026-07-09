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
 *
 *   DO → Client:
 *     { type: "peers",     peerIds }     — existing peers (on connect)
 *     { type: "peer-join", peerId }      — a new peer joined
 *     { type: "peer-left", peerId }      — a peer left
 *     { type: "signal",    from, data }  — forwarded encrypted SDP/ICE
 *     { type: "relay",     from, data }  — forwarded encrypted relay data
 */

import { DurableObject } from "cloudflare:workers";

export class SignalRoom extends DurableObject {
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
}
