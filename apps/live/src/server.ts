/**
 * Signaling Relay Server
 *
 * Lightweight WebSocket server that brokers WebRTC peer connections.
 * It knows nothing about CRDT ops, pages, or documents — it just helps
 * peers find each other and exchange SDP offers/answers/ICE candidates.
 *
 * Once a WebRTC DataChannel is established between two peers,
 * all data flows directly peer-to-peer. This server is only involved
 * in the initial handshake.
 *
 * Protocol (JSON over WebSocket):
 *
 *   Client → Server:
 *     { type: "join",   topic, peerId }        — join a discovery topic
 *     { type: "leave",  topic }                — leave a topic
 *     { type: "signal", topic, target, data }  — forward SDP/ICE to a peer
 *
 *   Server → Client:
 *     { type: "peers",     topic, peerIds }    — current peers (on join)
 *     { type: "peer-join", topic, peerId }     — a new peer joined
 *     { type: "peer-left", topic, peerId }     — a peer left
 *     { type: "signal",    topic, from, data } — forwarded SDP/ICE
 */

import { WebSocket, WebSocketServer } from "ws";

// =============================================================================
// Types
// =============================================================================

interface PeerInfo {
  ws: WebSocket;
  peerId: string;
  /** Topics this peer has joined — maps topic hex → peerId used for that topic */
  topics: Map<string, string>;
}

/** topic hex → Map<peerId, PeerInfo> */
type TopicMap = Map<string, Map<string, PeerInfo>>;

// =============================================================================
// Server
// =============================================================================

const PORT = parseInt(process.env.PORT || "8080", 10);

const wss = new WebSocketServer({ port: PORT });
const topics: TopicMap = new Map();
const clients = new WeakMap<WebSocket, PeerInfo>();

wss.on("connection", (ws) => {
  const info: PeerInfo = { ws, peerId: "", topics: new Map() };
  clients.set(ws, info);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      handleMessage(info, msg);
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on("close", () => {
    handleDisconnect(info);
    clients.delete(ws);
  });

  ws.on("error", () => {
    handleDisconnect(info);
  });
});

// =============================================================================
// Message Handling
// =============================================================================

function handleMessage(info: PeerInfo, msg: any) {
  switch (msg.type) {
    case "join":
      handleJoin(info, msg.topic, msg.peerId);
      break;
    case "leave":
      handleLeave(info, msg.topic);
      break;
    case "signal":
      handleSignal(info, msg.topic, msg.target, msg.data);
      break;
    case "relay":
      handleRelay(info, msg.topic, msg.target, msg.data);
      break;
  }
}

function handleJoin(info: PeerInfo, topic: string, peerId: string) {
  if (!topic || !peerId) return;

  // Set peerId on first join
  if (!info.peerId) info.peerId = peerId;

  // Already in this topic
  if (info.topics.has(topic)) return;

  // Get or create topic room
  let room = topics.get(topic);
  if (!room) {
    room = new Map();
    topics.set(topic, room);
  }

  // Collect existing peer IDs before adding the new one
  const existingPeerIds: string[] = [];
  for (const [pid] of room) {
    existingPeerIds.push(pid);
  }

  // Add peer to room
  room.set(peerId, info);
  info.topics.set(topic, peerId);

  // Send existing peers to the new peer
  send(info.ws, { type: "peers", topic, peerIds: existingPeerIds });

  // Notify existing peers about the new peer
  for (const [pid, peer] of room) {
    if (pid !== peerId) {
      send(peer.ws, { type: "peer-join", topic, peerId });
    }
  }
}

function handleLeave(info: PeerInfo, topic: string) {
  if (!topic) return;

  const peerId = info.topics.get(topic);
  if (!peerId) return;

  removePeerFromTopic(info, topic, peerId);
}

function handleSignal(info: PeerInfo, topic: string, target: string, data: unknown) {
  if (!topic || !target || !data) return;

  const room = topics.get(topic);
  if (!room) return;

  const targetPeer = room.get(target);
  if (!targetPeer) return;

  // Forward the signal with the sender's peerId
  const peerId = info.topics.get(topic);
  if (!peerId) return;

  send(targetPeer.ws, { type: "signal", topic, from: peerId, data });
}

function handleRelay(info: PeerInfo, topic: string, target: string, data: unknown) {
  if (!topic || !target || data == null) return;

  const room = topics.get(topic);
  if (!room) return;

  const targetPeer = room.get(target);
  if (!targetPeer) return;

  const peerId = info.topics.get(topic);
  if (!peerId) return;

  send(targetPeer.ws, { type: "relay", topic, from: peerId, data });
}

// =============================================================================
// Cleanup
// =============================================================================

function handleDisconnect(info: PeerInfo) {
  for (const [topic, peerId] of info.topics) {
    removePeerFromTopic(info, topic, peerId);
  }
}

function removePeerFromTopic(info: PeerInfo, topic: string, peerId: string) {
  info.topics.delete(topic);

  const room = topics.get(topic);
  if (!room) return;

  room.delete(peerId);

  // Notify remaining peers
  for (const [, peer] of room) {
    send(peer.ws, { type: "peer-left", topic, peerId });
  }

  // Clean up empty rooms
  if (room.size === 0) {
    topics.delete(topic);
  }
}

// =============================================================================
// Utilities
// =============================================================================

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// =============================================================================
// Lifecycle
// =============================================================================

console.log(`[Signal] Signaling relay listening on port ${PORT}`);

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function shutdown() {
  console.log("[Signal] Shutting down...");
  for (const client of wss.clients) {
    client.close(1001, "server shutdown");
  }
  wss.close(() => {
    console.log("[Signal] Closed.");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000);
}
