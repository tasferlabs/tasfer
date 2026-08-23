/**
 * Portable signaling relay.
 *
 * The same service as `apps/live`, without Cloudflare: one process, rooms in
 * memory instead of Durable Objects, coturn instead of Cloudflare Calls. The
 * wire protocol is identical, so an app build pointed at this server behaves
 * exactly as it does against the hosted one — that is the contract, and the
 * Worker in `apps/live` is its reference implementation.
 *
 * Protocol (JSON over WebSocket), per `/topic/{topicHex}?peerId={peerId}`:
 *
 *   Client → server:
 *     { type: "signal", target, data }   — forward encrypted SDP/ICE
 *     { type: "relay",  target, data }   — forward encrypted relay data
 *     { type: "turn-request" }           — request TURN credentials
 *     { type: "ping" }                   — keepalive
 *
 *   Server → client:
 *     { type: "peers",     peerIds }     — existing peers (on connect)
 *     { type: "peer-join", peerId }      — a new peer joined
 *     { type: "peer-left", peerId }      — a peer left
 *     { type: "signal",    from, data }  — forwarded encrypted SDP/ICE
 *     { type: "relay",     from, data }  — forwarded encrypted relay data
 *     { type: "pong" }                   — keepalive reply
 *     { type: "turn-response", iceServers } / { type: "turn-response", error }
 *
 * Zero-trust, like the Worker: every payload arrives encrypted under a key
 * derived from the topic's secret, which never reaches this process. It
 * forwards opaque strings and keeps nothing — no message history, no peer
 * directory, no accounts. Restarting it loses a room list and nothing else.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { t } from "../cli/messages";
import { mintCredentials, turnSource, type TurnConfig } from "./turn";

/** Every topic is 32 bytes of hex, derived client-side from secret material. */
const TOPIC_ROUTE = /^\/topic\/([a-f0-9]{64})$/i;

/** Keepalive frames, byte-identical to what the client sends. */
const PING_FRAME = '{"type":"ping"}';
const PONG_FRAME = '{"type":"pong"}';

/**
 * How long one mint is served to a whole room. Under the credential TTL minus
 * the client's 30-minute refresh interval, so a served credential always
 * outlives its holder's next refresh.
 */
const CREDENTIAL_CACHE_MS = 20 * 60 * 1000;

/** Per-peer turn-request ceiling. A sane client sends ~2/min while flapping. */
const TURN_REQUESTS_PER_MINUTE = 5;

/** Beyond this a frame is not signaling; it is someone using us as storage. */
const MAX_FRAME_BYTES = 1024 * 1024;

export interface RelayOptions {
  port: number;
  host: string;
  turnUrl?: string;
  turnSecret?: string;
  turnTtlSeconds: number;
  cloudflareKeyId?: string;
  cloudflareApiToken?: string;
}

interface Member {
  peerId: string;
  socket: WebSocket;
  /** Replaced by a newer socket for the same peerId: it must announce nothing. */
  superseded: boolean;
  turnWindowStart: number;
  turnCount: number;
}

interface Room {
  members: Map<string, Member>;
  credentials: { iceServers: unknown; mintedAt: number } | null;
  /** Coalesces concurrent cache misses into one mint. */
  minting: Promise<unknown | null> | null;
}

export async function runRelay(options: RelayOptions): Promise<number> {
  const turn: TurnConfig = {
    url: options.turnUrl,
    secret: options.turnSecret,
    ttlSeconds: options.turnTtlSeconds,
    cloudflareKeyId: options.cloudflareKeyId,
    cloudflareApiToken: options.cloudflareApiToken,
  };
  const rooms = new Map<string, Room>();

  const http = createServer(handleHttp(rooms));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  http.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = url.pathname.match(TOPIC_ROUTE);
    const peerId = url.searchParams.get("peerId");

    if (!match || !peerId) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const topicHex = match[1].toLowerCase();
    wss.handleUpgrade(request, socket, head, (ws) => {
      admit(rooms, topicHex, peerId, ws, turn);
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, options.host, resolve);
  });

  const shown = displayHost(options.host);
  console.log(t("relay.listening", { url: `ws://${shown}:${options.port}` }));
  console.log(t("relay.pointApps", { url: `ws://${shown}:${options.port}` }));
  switch (turnSource(turn)) {
    case "coturn":
      console.log(t("relay.turnCoturn", { url: options.turnUrl ?? "" }));
      break;
    case "cloudflare":
      console.log(t("relay.turnCloudflare"));
      break;
    case "none":
      console.log(t("relay.turnNone"));
      break;
  }

  await waitForShutdown();
  console.log(t("relay.stopping"));
  for (const room of rooms.values()) {
    for (const member of room.members.values()) member.socket.close(1001, "server stopping");
  }
  wss.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  console.log(t("relay.stopped"));
  return 0;
}

/** 0.0.0.0 is a bind address, not somewhere anyone can point a client. */
function displayHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "localhost" : host;
}

/**
 * Everything that is not a topic upgrade. `/health` exists so a process
 * supervisor or reverse proxy has something to probe.
 */
function handleHttp(rooms: Map<string, Room>) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    if (request.url === "/health") {
      let peers = 0;
      for (const room of rooms.values()) peers += room.members.size;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, rooms: rooms.size, peers }));
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not found. Use /topic/{topicHex}?peerId={peerId}\n");
  };
}

function admit(
  rooms: Map<string, Room>,
  topicHex: string,
  peerId: string,
  socket: WebSocket,
  turn: TurnConfig,
): void {
  let room = rooms.get(topicHex);
  if (!room) {
    room = { members: new Map(), credentials: null, minting: null };
    rooms.set(topicHex, room);
  }

  // A reconnect takes over its own identity. Without evicting the old socket
  // it would shadow the new one in routing, and its eventual close would
  // broadcast a peer-left that tears the reconnected peer down everywhere.
  const stale = room.members.get(peerId);
  if (stale) {
    stale.superseded = true;
    try {
      stale.socket.close(4000, "replaced by a newer connection");
    } catch {
      /* already gone */
    }
  }

  const member: Member = {
    peerId,
    socket,
    superseded: false,
    turnWindowStart: 0,
    turnCount: 0,
  };
  room.members.set(peerId, member);

  send(socket, {
    type: "peers",
    peerIds: [...room.members.keys()].filter((id) => id !== peerId),
  });
  broadcast(room, peerId, { type: "peer-join", peerId });

  socket.on("message", (data, isBinary) => {
    const text = isBinary
      ? Buffer.from(data as Buffer).toString("utf8")
      : String(data);
    void handleFrame(room!, member, text, turn);
  });

  const depart = () => {
    if (member.superseded) return;
    // Only if this socket is still the one holding the identity: an eviction
    // fires close after the replacement is already in the map.
    if (room!.members.get(peerId) !== member) return;
    room!.members.delete(peerId);
    broadcast(room!, peerId, { type: "peer-left", peerId });
    if (room!.members.size === 0) rooms.delete(topicHex);
  };
  socket.on("close", depart);
  socket.on("error", depart);
}

async function handleFrame(
  room: Room,
  member: Member,
  text: string,
  turn: TurnConfig,
): Promise<void> {
  if (text === PING_FRAME) {
    member.socket.send(PONG_FRAME);
    return;
  }

  let msg: { type?: unknown; target?: unknown; data?: unknown };
  try {
    msg = JSON.parse(text);
  } catch {
    return; // Ignore malformed frames
  }

  if (msg.type === "ping") {
    member.socket.send(PONG_FRAME);
    return;
  }

  if (msg.type === "turn-request") {
    await handleTurnRequest(room, member, turn);
    return;
  }

  if (msg.type === "signal" || msg.type === "relay") {
    if (typeof msg.target !== "string") return;
    const target = room.members.get(msg.target);
    if (!target || target.superseded) return;
    send(target.socket, { type: msg.type, from: member.peerId, data: msg.data });
  }
}

async function handleTurnRequest(
  room: Room,
  member: Member,
  turn: TurnConfig,
): Promise<void> {
  if (!allowTurnRequest(member)) {
    send(member.socket, { type: "turn-response", error: "rate-limited" });
    return;
  }

  if (
    room.credentials &&
    Date.now() - room.credentials.mintedAt < CREDENTIAL_CACHE_MS
  ) {
    send(member.socket, {
      type: "turn-response",
      iceServers: room.credentials.iceServers,
    });
    return;
  }

  if (turnSource(turn) === "none") {
    send(member.socket, { type: "turn-response", error: "unavailable" });
    return;
  }

  room.minting ??= mintCredentials(turn)
    .then((iceServers) => {
      if (iceServers) room.credentials = { iceServers, mintedAt: Date.now() };
      return iceServers;
    })
    .catch(() => null)
    .finally(() => {
      room.minting = null;
    });

  const iceServers = await room.minting;
  send(
    member.socket,
    iceServers
      ? { type: "turn-response", iceServers }
      : { type: "turn-response", error: "unavailable" },
  );
}

function allowTurnRequest(member: Member): boolean {
  const now = Date.now();
  if (now - member.turnWindowStart >= 60_000) {
    member.turnWindowStart = now;
    member.turnCount = 1;
    return true;
  }
  member.turnCount++;
  return member.turnCount <= TURN_REQUESTS_PER_MINUTE;
}

function broadcast(room: Room, exceptPeerId: string, msg: unknown): void {
  for (const member of room.members.values()) {
    if (member.peerId === exceptPeerId || member.superseded) continue;
    send(member.socket, msg);
  }
}

function send(socket: WebSocket, msg: unknown): void {
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    /* stale socket; its close handler will clean it up */
  }
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
