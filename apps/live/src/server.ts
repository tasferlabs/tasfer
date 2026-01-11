/**
 * WebSocket Sync Server
 *
 * A WebSocket server that relays CRDT operations between clients.
 *
 * Room-based architecture:
 * - Peers join rooms (one room per document/page)
 * - Operations are relayed to all peers in the same room
 * - Sync requests are handled by relaying version vectors
 * - No operation content is stored - just relayed in real-time
 */

import { WebSocketServer, WebSocket } from "ws";

// =============================================================================
// Types
// =============================================================================

/** Server message types */
type ServerMessage =
  | { type: "join"; roomId: string; peerId: string }
  | { type: "leave"; roomId: string; peerId: string }
  | { type: "sync-request"; versionVector: Record<string, number> }
  | { type: "sync-response"; operations: any[]; versionVector: Record<string, number> }
  | { type: "operations"; operations: any[] }
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

console.log(`[Sync Server] Starting on port ${PORT}`);

wss.on("connection", (ws) => {
  const client: Client = {
    ws,
    peerId: null,
    roomId: null,
  };
  wsToClient.set(ws, client);

  console.log("[Sync Server] Client connected");

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString()) as ServerMessage;
      handleMessage(client, message);
    } catch (error) {
      console.error("[Sync Server] Invalid message:", error);
      send(ws, { type: "error", message: "Invalid message format" });
    }
  });

  ws.on("close", () => {
    handleDisconnect(client);
  });

  ws.on("error", (error) => {
    console.error("[Sync Server] WebSocket error:", error);
  });
});

wss.on("listening", () => {
  console.log(`[Sync Server] Listening on ws://localhost:${PORT}`);
});

// =============================================================================
// Message Handlers
// =============================================================================

function handleMessage(client: Client, message: ServerMessage): void {
  switch (message.type) {
    case "join":
      handleJoin(client, message.roomId, message.peerId);
      break;

    case "leave":
      handleLeave(client);
      break;

    case "sync-request":
      handleSyncRequest(client, message.versionVector);
      break;

    case "operations":
      handleOperations(client, message.operations);
      break;

    default:
      console.warn("[Sync Server] Unknown message type:", (message as any).type);
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

  console.log(`[Sync Server] Peer ${peerId} joined room ${roomId} (${room.size} peers)`);

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

    console.log(`[Sync Server] Peer ${client.peerId} left room ${client.roomId}`);
  }

  // Clean up client
  clients.delete(client.peerId);
  client.roomId = null;
  client.peerId = null;
}

function handleDisconnect(client: Client): void {
  console.log(`[Sync Server] Client disconnected${client.peerId ? ` (${client.peerId})` : ""}`);
  handleLeave(client);
}

function handleSyncRequest(client: Client, versionVector: Record<string, number>): void {
  if (!client.roomId || !client.peerId) {
    console.warn("[Sync Server] Sync request from client not in a room");
    return;
  }

  console.log(`[Sync Server] Sync request from ${client.peerId} in room ${client.roomId}`);

  // Relay sync request to all other peers in the room
  // Each peer will respond with their operations
  const room = rooms.get(client.roomId);
  if (!room) return;

  for (const peerId of room) {
    if (peerId === client.peerId) continue; // Don't send to self

    const otherClient = clients.get(peerId);
    if (otherClient) {
      // Ask this peer to send their operations
      send(otherClient.ws, {
        type: "sync-request",
        versionVector,
      });
    }
  }
}

function handleOperations(client: Client, operations: any[]): void {
  if (!client.roomId || !client.peerId) {
    console.warn("[Sync Server] Operations from client not in a room");
    return;
  }

  console.log(`[Sync Server] Broadcasting ${operations.length} operations from ${client.peerId} in room ${client.roomId}`);

  // Broadcast operations to all other peers in the room
  const room = rooms.get(client.roomId);
  if (!room) return;

  for (const peerId of room) {
    if (peerId === client.peerId) continue; // Don't send to self

    const otherClient = clients.get(peerId);
    if (otherClient) {
      send(otherClient.ws, {
        type: "operations",
        operations,
      });
    }
  }
}

// =============================================================================
// Utilities
// =============================================================================

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// =============================================================================
// Graceful Shutdown
// =============================================================================

process.on("SIGINT", () => {
  console.log("\n[Sync Server] Shutting down...");

  // Close all connections
  wss.clients.forEach((ws) => {
    ws.close(1000, "Server shutting down");
  });

  wss.close(() => {
    console.log("[Sync Server] Server closed");
    process.exit(0);
  });
});

// Log stats periodically
setInterval(() => {
  const totalPeers = clients.size;
  const totalRooms = rooms.size;
  if (totalPeers > 0) {
    console.log(`[Sync Server] Stats: ${totalPeers} peers in ${totalRooms} rooms`);
  }
}, 60000);
