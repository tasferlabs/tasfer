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

import crypto from "crypto";
import { readFileSync } from "fs";
import Redis from "ioredis";
import { join } from "path";
import { WebSocket, WebSocketServer } from "ws";
import { getAppDir } from "./lib/paths";

// Unique instance ID for multi-instance coordination
const INSTANCE_ID = crypto.randomUUID();

// Auth key for basic protection (clients must pass this in query string)
const AUTH_KEY = process.env.LIVE_AUTH_KEY || "zADL7WxuMcUM8uVbPwBJOqxH9haeU3K4X2vWdohIo5E";


// =============================================================================
// Version Loading
// =============================================================================

interface VersionConfig {
  version: number;
  minVersion: number;
}

function loadVersionConfig(): VersionConfig {
  try {
    const versionPath = join(getAppDir(), "version.json");
    const content = readFileSync(versionPath, "utf-8");
    const config = JSON.parse(content);
    console.log(`[Sync Server] Loaded version config: v${config.version} (min: v${config.minVersion})`);
    return config;
  } catch (error) {
    console.warn("[Sync Server] Failed to load version.json, using defaults");
    return { version: 1, minVersion: 1 };
  }
}

const versionConfig = loadVersionConfig();

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
  | { type: "hello"; clientVersion: number }
  | { type: "join"; roomId: string; peerId: string; user?: AwarenessUser; clientVersion?: number }
  | { type: "leave"; roomId: string; peerId: string }
  | { type: "sync-request"; versionVector: Record<string, number>; requesterId?: string }
  | { type: "sync-response"; operations: any[]; versionVector: Record<string, number>; targetPeerId?: string }
  | { type: "operations"; operations: any[] }
  | { type: "peer-joined"; peerId: string; user?: AwarenessUser }
  | { type: "peer-left"; peerId: string }
  | { type: "room-peers"; peers: string[]; awarenessStates?: Record<string, AwarenessState> }
  | { type: "awareness"; peerId: string; state: AwarenessState }
  | { type: "error"; message: string }
  | { type: "update-available"; serverVersion: number; clientVersion: number; forceUpdate: boolean }
  | { type: "server-shutdown"; reason: string }
  | PageEvent;

/** Connected client info */
interface Client {
  ws: WebSocket;
  peerId: string | null;
  roomId: string | null;
  awarenessState: AwarenessState | null;
  clientVersion: number | null;
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
  verifyClient: (info, callback) => {
    const url = new URL(info.req.url || "", `http://${info.req.headers.host}`);
    const key = url.searchParams.get("key");

    if (key !== AUTH_KEY) {
      console.log(`[Sync Server] Rejected connection: invalid auth key`);
      callback(false, 401, "Unauthorized");
      return;
    }

    callback(true);
  },
});

console.log(`[Sync Server] Starting on port ${PORT}`);

wss.on("connection", (ws) => {
  const client: Client = {
    ws,
    peerId: null,
    roomId: null,
    awarenessState: null,
    clientVersion: null,
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
const REDIS_SYSTEM_CHANNEL = "cypher:system";

/** System-wide messages between instances */
type SystemMessage =
  | { type: "version-announcement"; version: number; minVersion: number; sourceInstanceId: string };

let redisSubscriber: Redis | null = null;
let redisPublisher: Redis | null = null;

/** Track which room channels this instance is subscribed to */
const subscribedRooms = new Set<string>();

/** Get Redis channel name for a room */
function getRoomChannel(roomId: string): string {
  return `cypher:room:${roomId}`;
}

/** Messages relayed via Redis between instances */
type RedisRoomMessage =
  | { type: "operations"; roomId: string; peerId: string; operations: any[]; sourceInstanceId: string }
  | { type: "awareness"; roomId: string; peerId: string; state: AwarenessState; sourceInstanceId: string }
  | { type: "sync-request"; roomId: string; versionVector: Record<string, number>; requesterId: string; sourceInstanceId: string }
  | { type: "sync-response"; roomId: string; operations: any[]; versionVector: Record<string, number>; targetPeerId: string; sourceInstanceId: string }
  | { type: "peer-joined"; roomId: string; peerId: string; user?: AwarenessUser; sourceInstanceId: string }
  | { type: "peer-left"; roomId: string; peerId: string; sourceInstanceId: string };

/** Publish a message to a room's Redis channel */
function publishToRedis(roomId: string, message: RedisRoomMessage): void {
  if (!redisPublisher) return;

  const channel = getRoomChannel(roomId);
  redisPublisher.publish(channel, JSON.stringify(message)).catch((error) => {
    console.error(`[Sync Server] Failed to publish to Redis channel ${channel}:`, error);
  });
}

async function setupRedisSubscriber(): Promise<void> {
  try {
    redisSubscriber = new Redis(REDIS_URL);
    redisPublisher = new Redis(REDIS_URL);

    redisSubscriber.on("error", (error) => {
      console.error("[Sync Server] Redis subscriber error:", error);
    });

    redisPublisher.on("error", (error) => {
      console.error("[Sync Server] Redis publisher error:", error);
    });

    redisSubscriber.on("connect", () => {
      console.log(`[Sync Server] Connected to Redis (instance: ${INSTANCE_ID.slice(0, 8)})`);
    });

    // Subscribe to page events and system channels
    await redisSubscriber.subscribe(REDIS_CHANNEL, REDIS_SYSTEM_CHANNEL);
    console.log(`[Sync Server] Subscribed to Redis channels: ${REDIS_CHANNEL}, ${REDIS_SYSTEM_CHANNEL}`);

    // Handle incoming messages
    redisSubscriber.on("message", (channel, message) => {
      // Handle page events
      if (channel === REDIS_CHANNEL) {
        try {
          const event = JSON.parse(message) as PageEvent;
          console.log(`[Sync Server] Received page event: ${event.type}`);
          broadcastPageEventToAll(event);
        } catch (error) {
          console.error("[Sync Server] Invalid Redis page event:", error);
        }
        return;
      }

      // Handle system messages
      if (channel === REDIS_SYSTEM_CHANNEL) {
        try {
          const systemMessage = JSON.parse(message) as SystemMessage;

          // Skip messages from this instance
          if (systemMessage.sourceInstanceId === INSTANCE_ID) return;

          handleSystemMessage(systemMessage);
        } catch (error) {
          console.error("[Sync Server] Invalid Redis system message:", error);
        }
        return;
      }

      // Handle room messages
      if (channel.startsWith("cypher:room:")) {
        try {
          const roomMessage = JSON.parse(message) as RedisRoomMessage;

          // Skip messages from this instance
          if (roomMessage.sourceInstanceId === INSTANCE_ID) return;

          handleRedisRoomMessage(roomMessage);
        } catch (error) {
          console.error("[Sync Server] Invalid Redis room message:", error);
        }
      }
    });

    // Announce our version to other instances
    announceVersion();
  } catch (error) {
    console.error("[Sync Server] Failed to connect to Redis:", error);
    console.log("[Sync Server] Page events and multi-instance sync will not be available");
  }
}

/**
 * Handle a room message received from Redis (from another instance).
 * Broadcasts to local peers in the room.
 */
function handleRedisRoomMessage(message: RedisRoomMessage): void {
  const room = rooms.get(message.roomId);
  if (!room || room.size === 0) return;

  switch (message.type) {
    case "operations":
      // Broadcast operations to all local peers in the room
      for (const peerId of room) {
        const client = clients.get(peerId);
        if (client) {
          send(client.ws, {
            type: "operations",
            operations: message.operations,
          });
        }
      }
      break;

    case "awareness":
      // Broadcast awareness to all local peers in the room
      for (const peerId of room) {
        const client = clients.get(peerId);
        if (client) {
          send(client.ws, {
            type: "awareness",
            peerId: message.peerId,
            state: message.state,
          });
        }
      }
      break;

    case "sync-request":
      // Forward sync request to all local peers (they'll respond if they have data)
      for (const peerId of room) {
        const client = clients.get(peerId);
        if (client) {
          send(client.ws, {
            type: "sync-request",
            versionVector: message.versionVector,
            requesterId: message.requesterId,
          });
        }
      }
      break;

    case "sync-response":
      // Route sync response to target peer if they're local
      const targetClient = clients.get(message.targetPeerId);
      if (targetClient && targetClient.roomId === message.roomId) {
        send(targetClient.ws, {
          type: "sync-response",
          operations: message.operations,
          versionVector: message.versionVector,
        });
      }
      break;

    case "peer-joined":
      // Notify local peers about remote peer joining
      for (const peerId of room) {
        const client = clients.get(peerId);
        if (client) {
          send(client.ws, {
            type: "peer-joined",
            peerId: message.peerId,
            user: message.user,
          });
        }
      }
      break;

    case "peer-left":
      // Notify local peers about remote peer leaving
      for (const peerId of room) {
        const client = clients.get(peerId);
        if (client) {
          send(client.ws, {
            type: "peer-left",
            peerId: message.peerId,
          });
        }
      }
      break;
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

/**
 * Handle a system message received from Redis (from another instance).
 * Used for cross-instance coordination like version announcements.
 */
function handleSystemMessage(message: SystemMessage): void {
  switch (message.type) {
    case "version-announcement":
      console.log(`[Sync Server] Received version announcement from instance ${message.sourceInstanceId.slice(0, 8)}: v${message.version}`);

      // Notify all local clients who have an outdated version
      // Iterate over all connected WebSockets (not just room members)
      let notifiedCount = 0;
      for (const ws of wss.clients) {
        const client = wsToClient.get(ws);
        if (!client || client.clientVersion === null) continue;
        if (client.clientVersion < message.version) {
          const forceUpdate = client.clientVersion < message.minVersion;
          console.log(`[Sync Server] Notifying ${client.peerId || "unknown"} of update (v${client.clientVersion} < v${message.version})${forceUpdate ? " - FORCE UPDATE" : ""}`);
          send(ws, {
            type: "update-available",
            serverVersion: message.version,
            clientVersion: client.clientVersion,
            forceUpdate,
          });
          notifiedCount++;
        }
      }
      console.log(`[Sync Server] Notified ${notifiedCount} clients of update`);
      break;
  }
}

/**
 * Announce this instance's version to other instances via Redis.
 * Called when this instance starts up.
 */
function announceVersion(): void {
  if (!redisPublisher) return;

  const message: SystemMessage = {
    type: "version-announcement",
    version: versionConfig.version,
    minVersion: versionConfig.minVersion,
    sourceInstanceId: INSTANCE_ID,
  };

  redisPublisher.publish(REDIS_SYSTEM_CHANNEL, JSON.stringify(message)).then(() => {
    console.log(`[Sync Server] Announced version v${versionConfig.version} to other instances`);
  }).catch((error) => {
    console.error("[Sync Server] Failed to announce version:", error);
  });
}

// Initialize Redis subscriber
setupRedisSubscriber();

// =============================================================================
// Message Handlers
// =============================================================================

function handleMessage(client: Client, message: ServerMessage): void {
  switch (message.type) {
    case "hello":
      handleHello(client, message.clientVersion);
      break;

    case "join":
      handleJoin(client, message.roomId, message.peerId, message.user, message.clientVersion);
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

/**
 * Handle hello message - client registers its version on connect.
 * This allows the server to notify the client of updates even before they join a room.
 */
function handleHello(client: Client, clientVersion: number): void {
  client.clientVersion = clientVersion;
  console.log(`[Sync Server] Client registered version: v${clientVersion}`);

  // Check if client needs update
  if (clientVersion < versionConfig.version) {
    const forceUpdate = clientVersion < versionConfig.minVersion;
    console.log(`[Sync Server] Client has outdated version (v${clientVersion} < v${versionConfig.version})${forceUpdate ? " - FORCE UPDATE" : ""}`);
    send(client.ws, {
      type: "update-available",
      serverVersion: versionConfig.version,
      clientVersion,
      forceUpdate,
    });
  }
}

function handleJoin(client: Client, roomId: string, peerId: string, user?: AwarenessUser, clientVersion?: number): void {
  // Leave current room if in one
  if (client.roomId) {
    handleLeave(client);
  }

  // Update client info
  client.peerId = peerId;
  client.roomId = roomId;
  client.clientVersion = clientVersion ?? null;
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

  // Check client version and notify if update available
  if (clientVersion !== undefined && clientVersion < versionConfig.version) {
    const forceUpdate = clientVersion < versionConfig.minVersion;
    console.log(`[Sync Server] Client ${peerId} has outdated version (v${clientVersion} < v${versionConfig.version})${forceUpdate ? " - FORCE UPDATE" : ""}`);
    send(client.ws, {
      type: "update-available",
      serverVersion: versionConfig.version,
      clientVersion,
      forceUpdate,
    });
  }

  // Get or create room
  let room = rooms.get(roomId);
  const isFirstLocalPeer = !room || room.size === 0;
  if (!room) {
    room = new Set();
    rooms.set(roomId, room);
  }

  // Subscribe to room channel if this is the first local peer
  if (isFirstLocalPeer && redisSubscriber && !subscribedRooms.has(roomId)) {
    const channel = getRoomChannel(roomId);
    redisSubscriber.subscribe(channel).then(() => {
      subscribedRooms.add(roomId);
      console.log(`[Sync Server] Subscribed to room channel: ${channel}`);
    }).catch((error) => {
      console.error(`[Sync Server] Failed to subscribe to room channel ${channel}:`, error);
    });
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

  // Notify existing local peers about new peer (include user info if available)
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

  // Publish peer-joined to Redis for other instances
  publishToRedis(roomId, {
    type: "peer-joined",
    roomId,
    peerId,
    user: client.awarenessState?.user,
    sourceInstanceId: INSTANCE_ID,
  });
}

function handleLeave(client: Client): void {
  if (!client.roomId || !client.peerId) return;

  const roomId = client.roomId;
  const peerId = client.peerId;

  const room = rooms.get(roomId);
  if (room) {
    room.delete(peerId);

    // Notify other local peers
    for (const otherPeerId of room) {
      const otherClient = clients.get(otherPeerId);
      if (otherClient) {
        send(otherClient.ws, {
          type: "peer-left",
          peerId,
        });
      }
    }

    // Publish peer-left to Redis for other instances
    publishToRedis(roomId, {
      type: "peer-left",
      roomId,
      peerId,
      sourceInstanceId: INSTANCE_ID,
    });

    // Clean up empty room
    if (room.size === 0) {
      rooms.delete(roomId);

      // Unsubscribe from room channel when last local peer leaves
      if (redisSubscriber && subscribedRooms.has(roomId)) {
        const channel = getRoomChannel(roomId);
        redisSubscriber.unsubscribe(channel).then(() => {
          subscribedRooms.delete(roomId);
          console.log(`[Sync Server] Unsubscribed from room channel: ${channel}`);
        }).catch((error) => {
          console.error(`[Sync Server] Failed to unsubscribe from room channel ${channel}:`, error);
        });
      }
    }

    console.log(`[Sync Server] Peer ${peerId} left room ${roomId}`);
  }

  // Clean up client
  clients.delete(peerId);
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

  // Relay sync request to all other local peers in the room
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

  // Publish sync request to Redis for peers on other instances
  publishToRedis(client.roomId, {
    type: "sync-request",
    roomId: client.roomId,
    versionVector,
    requesterId: client.peerId,
    sourceInstanceId: INSTANCE_ID,
  });
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
      // Target peer is local, send directly
      console.log(`[Sync Server] Routing sync response (${operations.length} ops) from ${client.peerId} to ${targetPeerId}`);
      send(targetClient.ws, {
        type: "sync-response",
        operations,
        versionVector,
      });
    } else {
      // Target peer might be on another instance, publish to Redis
      console.log(`[Sync Server] Routing sync response (${operations.length} ops) from ${client.peerId} to ${targetPeerId} via Redis`);
      publishToRedis(client.roomId, {
        type: "sync-response",
        roomId: client.roomId,
        operations,
        versionVector,
        targetPeerId,
        sourceInstanceId: INSTANCE_ID,
      });
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

  // Broadcast operations to all other local peers in the room
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

  // Publish operations to Redis for peers on other instances
  publishToRedis(client.roomId, {
    type: "operations",
    roomId: client.roomId,
    peerId: client.peerId,
    operations,
    sourceInstanceId: INSTANCE_ID,
  });
}

function handleAwareness(client: Client, state: AwarenessState): void {
  if (!client.roomId || !client.peerId) {
    console.warn("[Sync Server] Awareness from client not in a room");
    return;
  }

  // Update stored awareness state
  client.awarenessState = state;

  // Broadcast awareness to all other local peers in the room
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

  // Publish awareness to Redis for peers on other instances
  publishToRedis(client.roomId, {
    type: "awareness",
    roomId: client.roomId,
    peerId: client.peerId,
    state,
    sourceInstanceId: INSTANCE_ID,
  });
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

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Sync Server] Received ${signal}, shutting down gracefully...`);

  // Set a hard timeout to force exit if graceful shutdown takes too long
  const forceExitTimeout = setTimeout(() => {
    console.error("[Sync Server] Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 10000); // 10 second timeout

  // Notify all clients that server is shutting down (so they can reconnect)
  const shutdownMessage = JSON.stringify({
    type: "server-shutdown",
    reason: "Server is restarting, please reconnect",
  });

  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(shutdownMessage);
    }
  });

  // Give clients a moment to receive the shutdown message
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Close Redis connections
  try {
    if (redisSubscriber) {
      // Unsubscribe from page events channel
      await redisSubscriber.unsubscribe(REDIS_CHANNEL);

      // Unsubscribe from all room channels
      for (const roomId of subscribedRooms) {
        await redisSubscriber.unsubscribe(getRoomChannel(roomId));
      }
      subscribedRooms.clear();

      await redisSubscriber.quit();
      console.log("[Sync Server] Redis subscriber closed");
    }

    if (redisPublisher) {
      await redisPublisher.quit();
      console.log("[Sync Server] Redis publisher closed");
    }
  } catch (error) {
    console.error("[Sync Server] Error closing Redis:", error);
  }

  // Close all WebSocket connections with clean close code
  wss.clients.forEach((ws) => {
    ws.close(1001, "Server shutting down"); // 1001 = Going Away
  });

  // Close the WebSocket server
  wss.close(() => {
    console.log("[Sync Server] Server closed");
    clearTimeout(forceExitTimeout);
    process.exit(0);
  });
}

// Handle termination signals (SIGTERM is used by deployment systems, SIGINT is Ctrl+C)
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Log stats periodically
setInterval(() => {
  const totalPeers = clients.size;
  const totalRooms = rooms.size;
  if (totalPeers > 0) {
    console.log(`[Sync Server] Stats: ${totalPeers} peers in ${totalRooms} rooms`);
  }
}, 60000);
