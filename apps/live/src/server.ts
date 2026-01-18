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
 *
 * Page Events (via Redis):
 * - Subscribes to page lifecycle events from API server
 * - Broadcasts page events to all connected clients
 */

import { WebSocketServer, WebSocket } from "ws";
import Redis from "ioredis";

// =============================================================================
// Types
// =============================================================================

/** User awareness info */
interface AwarenessUser {
  peerId: string;
  name?: string;
  color: string;
}

/** Cursor position for awareness */
interface AwarenessCursor {
  blockId: string;
  textIndex: number;
}

/** Selection for awareness */
interface AwarenessSelection {
  anchor: AwarenessCursor;
  focus: AwarenessCursor;
  isForward: boolean;
}

/** Complete awareness state for a peer */
interface AwarenessState {
  user: AwarenessUser;
  cursor: AwarenessCursor | null;
  selection: AwarenessSelection | null;
  lastUpdate: number;
}

/** Page info for page events */
interface PageInfo {
  id: string;
  title: string | null;
  parentId: string | null;
  order: number;
}

/** Page lifecycle events (from Redis) */
type PageEvent =
  | { type: "page-created"; page: PageInfo }
  | { type: "page-deleted"; pageId: string }
  | { type: "page-moved"; pageId: string; oldParentId: string | null; newParentId: string | null }
  | { type: "page-reordered"; pageId: string; parentId: string | null; order: number }
  | { type: "page-title-updated"; pageId: string; title: string };

/** Server message types (room messages + page events) */
type ServerMessage =
  | { type: "join"; roomId: string; peerId: string; user?: AwarenessUser }
  | { type: "leave"; roomId: string; peerId: string }
  | { type: "sync-request"; versionVector: Record<string, number>; requesterId?: string }
  | { type: "sync-response"; operations: any[]; versionVector: Record<string, number>; targetPeerId?: string }
  | { type: "operations"; operations: any[] }
  | { type: "peer-joined"; peerId: string; user?: AwarenessUser }
  | { type: "peer-left"; peerId: string }
  | { type: "room-peers"; peers: string[]; awarenessStates?: Record<string, AwarenessState> }
  | { type: "awareness"; peerId: string; state: AwarenessState }
  | { type: "error"; message: string }
  | PageEvent;

/** Connected client info */
interface Client {
  ws: WebSocket;
  peerId: string | null;
  roomId: string | null;
  awarenessState: AwarenessState | null;
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
    awarenessState: null,
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
// Redis Subscriber (Page Events)
// =============================================================================

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const REDIS_CHANNEL = "cypher:page-events";

let redisSubscriber: Redis | null = null;

async function setupRedisSubscriber(): Promise<void> {
  try {
    redisSubscriber = new Redis(REDIS_URL);

    redisSubscriber.on("error", (error) => {
      console.error("[Sync Server] Redis error:", error);
    });

    redisSubscriber.on("connect", () => {
      console.log("[Sync Server] Connected to Redis");
    });

    // Subscribe to page events channel
    await redisSubscriber.subscribe(REDIS_CHANNEL);
    console.log(`[Sync Server] Subscribed to Redis channel: ${REDIS_CHANNEL}`);

    // Handle incoming messages
    redisSubscriber.on("message", (channel, message) => {
      if (channel !== REDIS_CHANNEL) return;

      try {
        const event = JSON.parse(message) as PageEvent;
        console.log(`[Sync Server] Received page event: ${event.type}`);
        broadcastPageEventToAll(event);
      } catch (error) {
        console.error("[Sync Server] Invalid Redis message:", error);
      }
    });
  } catch (error) {
    console.error("[Sync Server] Failed to connect to Redis:", error);
    console.log("[Sync Server] Page events will not be available");
  }
}

/**
 * Broadcast a page event to all connected clients.
 * Page events are sent to everyone, not just room members.
 */
function broadcastPageEventToAll(event: PageEvent): void {
  const message = JSON.stringify(event);
  let sentCount = 0;

  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
      sentCount++;
    }
  });

  console.log(`[Sync Server] Broadcast ${event.type} to ${sentCount} clients`);
}

// Initialize Redis subscriber
setupRedisSubscriber();

// =============================================================================
// Message Handlers
// =============================================================================

function handleMessage(client: Client, message: ServerMessage): void {
  switch (message.type) {
    case "join":
      handleJoin(client, message.roomId, message.peerId, message.user);
      break;

    case "leave":
      handleLeave(client);
      break;

    case "sync-request":
      handleSyncRequest(client, message.versionVector);
      break;

    case "sync-response":
      handleSyncResponse(client, message.operations, message.versionVector, message.targetPeerId);
      break;

    case "operations":
      handleOperations(client, message.operations);
      break;

    case "awareness":
      handleAwareness(client, message.state);
      break;

    default:
      console.warn("[Sync Server] Unknown message type:", (message as any).type);
  }
}

function handleJoin(client: Client, roomId: string, peerId: string, user?: AwarenessUser): void {
  // Leave current room if in one
  if (client.roomId) {
    handleLeave(client);
  }

  // Update client info
  client.peerId = peerId;
  client.roomId = roomId;
  clients.set(peerId, client);

  // Initialize awareness state if user info provided
  if (user) {
    client.awarenessState = {
      user,
      cursor: null,
      selection: null,
      lastUpdate: Date.now(),
    };
  }

  // Get or create room
  let room = rooms.get(roomId);
  if (!room) {
    room = new Set();
    rooms.set(roomId, room);
  }

  // Get existing peers before adding new one
  const existingPeers = Array.from(room);

  // Collect awareness states from existing peers
  const awarenessStates: Record<string, AwarenessState> = {};
  for (const existingPeerId of existingPeers) {
    const existingClient = clients.get(existingPeerId);
    if (existingClient?.awarenessState) {
      awarenessStates[existingPeerId] = existingClient.awarenessState;
    }
  }

  // Add to room
  room.add(peerId);

  console.log(`[Sync Server] Peer ${peerId} joined room ${roomId} (${room.size} peers)`);

  // Send list of existing peers and their awareness states to the new peer
  send(client.ws, {
    type: "room-peers",
    peers: existingPeers,
    awarenessStates: Object.keys(awarenessStates).length > 0 ? awarenessStates : undefined,
  });

  // Notify existing peers about new peer (include user info if available)
  for (const existingPeerId of existingPeers) {
    const existingClient = clients.get(existingPeerId);
    if (existingClient) {
      send(existingClient.ws, {
        type: "peer-joined",
        peerId,
        user: client.awarenessState?.user,
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
  client.awarenessState = null;
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
      // Ask this peer to send their operations, include requesterId for response routing
      send(otherClient.ws, {
        type: "sync-request",
        versionVector,
        requesterId: client.peerId,
      });
    }
  }
}

function handleSyncResponse(
  client: Client,
  operations: any[],
  versionVector: Record<string, number>,
  targetPeerId?: string
): void {
  if (!client.roomId || !client.peerId) {
    console.warn("[Sync Server] Sync response from client not in a room");
    return;
  }

  // If targetPeerId is specified, route only to that peer
  if (targetPeerId) {
    const targetClient = clients.get(targetPeerId);
    if (targetClient && targetClient.roomId === client.roomId) {
      console.log(`[Sync Server] Routing sync response (${operations.length} ops) from ${client.peerId} to ${targetPeerId}`);
      send(targetClient.ws, {
        type: "sync-response",
        operations,
        versionVector,
      });
    } else {
      console.warn(`[Sync Server] Target peer ${targetPeerId} not found or not in same room`);
    }
  } else {
    // Fallback: broadcast to all peers in room (shouldn't happen with proper routing)
    console.log(`[Sync Server] Broadcasting sync response from ${client.peerId} in room ${client.roomId}`);
    const room = rooms.get(client.roomId);
    if (!room) return;

    for (const peerId of room) {
      if (peerId === client.peerId) continue;

      const otherClient = clients.get(peerId);
      if (otherClient) {
        send(otherClient.ws, {
          type: "sync-response",
          operations,
          versionVector,
        });
      }
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

function handleAwareness(client: Client, state: AwarenessState): void {
  if (!client.roomId || !client.peerId) {
    console.warn("[Sync Server] Awareness from client not in a room");
    return;
  }

  // Update stored awareness state
  client.awarenessState = state;

  // Broadcast awareness to all other peers in the room
  const room = rooms.get(client.roomId);
  if (!room) return;

  for (const peerId of room) {
    if (peerId === client.peerId) continue; // Don't send to self

    const otherClient = clients.get(peerId);
    if (otherClient) {
      send(otherClient.ws, {
        type: "awareness",
        peerId: client.peerId,
        state,
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

process.on("SIGINT", async () => {
  console.log("\n[Sync Server] Shutting down...");

  // Close Redis subscriber
  if (redisSubscriber) {
    await redisSubscriber.unsubscribe(REDIS_CHANNEL);
    await redisSubscriber.quit();
    console.log("[Sync Server] Redis connection closed");
  }

  // Close all WebSocket connections
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
