/**
 * WebRTC Signaling Server
 *
 * A simple WebSocket server that helps peers discover each other
 * and exchange WebRTC signaling messages (offers, answers, ICE candidates).
 *
 * Room-based architecture:
 * - Peers join rooms (one room per document/page)
 * - Messages are relayed only between peers in the same room
 * - No message content is stored - just relayed in real-time
 */

import { WebSocketServer, WebSocket } from "ws";

// =============================================================================
// Types
// =============================================================================

/** Signaling message types */
type SignalingMessage =
  | { type: "join"; roomId: string; peerId: string }
  | { type: "leave"; roomId: string; peerId: string }
  | { type: "offer"; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { type: "ice-candidate"; from: string; to: string; candidate: RTCIceCandidateInit }
  | { type: "peer-joined"; peerId: string }
  | { type: "peer-left"; peerId: string }
  | { type: "room-peers"; peers: string[] }
  | { type: "error"; message: string };

/** Connected client info */
interface Client {
  ws: WebSocket;
  peerId: string | null;
  roomId: string | null;
}

// =============================================================================
// Server State
// =============================================================================

/** Map of room ID -> Set of peer IDs */
const rooms = new Map<string, Set<string>>();

/** Map of peer ID -> Client */
const clients = new Map<string, Client>();

/** Map of WebSocket -> Client */
const wsToClient = new WeakMap<WebSocket, Client>();

// =============================================================================
// Server Setup
// =============================================================================

const PORT = parseInt(process.env.PORT || "8080", 10);

const wss = new WebSocketServer({
  port: PORT,
  perMessageDeflate: false, // Disable compression for lower latency
});

console.log(`[Signaling] Server starting on port ${PORT}`);

wss.on("connection", (ws) => {
  const client: Client = {
    ws,
    peerId: null,
    roomId: null,
  };
  wsToClient.set(ws, client);

  console.log("[Signaling] Client connected");

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString()) as SignalingMessage;
      handleMessage(client, message);
    } catch (error) {
      console.error("[Signaling] Invalid message:", error);
      send(ws, { type: "error", message: "Invalid message format" });
    }
  });

  ws.on("close", () => {
    handleDisconnect(client);
  });

  ws.on("error", (error) => {
    console.error("[Signaling] WebSocket error:", error);
  });
});

wss.on("listening", () => {
  console.log(`[Signaling] Server listening on ws://localhost:${PORT}`);
});

// =============================================================================
// Message Handlers
// =============================================================================

function handleMessage(client: Client, message: SignalingMessage): void {
  switch (message.type) {
    case "join":
      handleJoin(client, message.roomId, message.peerId);
      break;

    case "leave":
      handleLeave(client);
      break;

    case "offer":
    case "answer":
    case "ice-candidate":
      relayMessage(message);
      break;

    default:
      console.warn("[Signaling] Unknown message type:", (message as any).type);
  }
}

function handleJoin(client: Client, roomId: string, peerId: string): void {
  // Leave current room if in one
  if (client.roomId) {
    handleLeave(client);
  }

  // Update client info
  client.peerId = peerId;
  client.roomId = roomId;
  clients.set(peerId, client);

  // Get or create room
  let room = rooms.get(roomId);
  if (!room) {
    room = new Set();
    rooms.set(roomId, room);
  }

  // Get existing peers before adding new one
  const existingPeers = Array.from(room);

  // Add to room
  room.add(peerId);

  console.log(`[Signaling] Peer ${peerId} joined room ${roomId} (${room.size} peers)`);

  // Send list of existing peers to the new peer
  send(client.ws, {
    type: "room-peers",
    peers: existingPeers,
  });

  // Notify existing peers about new peer
  for (const existingPeerId of existingPeers) {
    const existingClient = clients.get(existingPeerId);
    if (existingClient) {
      send(existingClient.ws, {
        type: "peer-joined",
        peerId,
      });
    }
  }
}

function handleLeave(client: Client): void {
  if (!client.roomId || !client.peerId) return;

  const room = rooms.get(client.roomId);
  if (room) {
    room.delete(client.peerId);

    // Notify other peers
    for (const peerId of room) {
      const otherClient = clients.get(peerId);
      if (otherClient) {
        send(otherClient.ws, {
          type: "peer-left",
          peerId: client.peerId,
        });
      }
    }

    // Clean up empty room
    if (room.size === 0) {
      rooms.delete(client.roomId);
    }

    console.log(`[Signaling] Peer ${client.peerId} left room ${client.roomId}`);
  }

  // Clean up client
  clients.delete(client.peerId);
  client.roomId = null;
  client.peerId = null;
}

function handleDisconnect(client: Client): void {
  console.log(`[Signaling] Client disconnected${client.peerId ? ` (${client.peerId})` : ""}`);
  handleLeave(client);
}

function relayMessage(message: SignalingMessage & { to: string }): void {
  const targetClient = clients.get(message.to);
  if (targetClient) {
    send(targetClient.ws, message);
  } else {
    console.warn(`[Signaling] Target peer not found: ${message.to}`);
  }
}

// =============================================================================
// Utilities
// =============================================================================

function send(ws: WebSocket, message: SignalingMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// =============================================================================
// Graceful Shutdown
// =============================================================================

process.on("SIGINT", () => {
  console.log("\n[Signaling] Shutting down...");

  // Close all connections
  wss.clients.forEach((ws) => {
    ws.close(1000, "Server shutting down");
  });

  wss.close(() => {
    console.log("[Signaling] Server closed");
    process.exit(0);
  });
});

// Log stats periodically
setInterval(() => {
  const totalPeers = clients.size;
  const totalRooms = rooms.size;
  if (totalPeers > 0) {
    console.log(`[Signaling] Stats: ${totalPeers} peers in ${totalRooms} rooms`);
  }
}, 60000);
