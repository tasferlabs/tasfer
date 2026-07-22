/**
 * WebRTC Network Driver — E2E Encrypted Signaling via Cloudflare
 *
 * Shared across all platforms (Electron, Web, Capacitor).
 * WebRTC is available everywhere — Electron is Chromium, mobile WebViews
 * support DataChannels. One transport, one network, all peers can talk.
 *
 * Architecture:
 *   - Each topic gets its own WebSocket to the Cloudflare Worker
 *   - All signaling payloads (SDP, ICE) are AES-GCM encrypted before
 *     leaving the device — Cloudflare only sees opaque blobs. A topic cannot
 *     be joined without its key, so this holds unconditionally: there is no
 *     cleartext fallback (`join()` throws rather than downgrade).
 *   - After signaling, data flows directly peer-to-peer over DataChannels
 *   - If ICE fails, falls back to relay through CF (also encrypted)
 *
 * Signaling protocol (per-topic WebSocket, JSON):
 *
 *   → { type: "signal", target, data }   (encrypted SDP offer/answer/ICE)
 *   → { type: "relay",  target, data }   (encrypted binary — fallback)
 *   → { type: "turn-request" }           (mint TURN credentials for this room)
 *   ← { type: "peers",     peerIds }     (current peers on connect)
 *   ← { type: "peer-join", peerId }
 *   ← { type: "peer-left", peerId }
 *   ← { type: "signal",    from, data }
 *   ← { type: "relay",     from, data }
 *   ← { type: "turn-response", iceServers } / { type: "turn-response", error }
 *
 * TURN credentials are requested over the signaling socket rather than HTTP:
 * the server mints them only for connected room members, which is what rate
 * limits minting without punishing users who share an IP (CGNAT).
 */

import { invariant } from "@shared/invariant";
import type { NetworkDriver, NetworkTopic, NetworkPeer } from "../driver";

// =============================================================================
// Config
// =============================================================================

const STUN_ONLY_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

/**
 * How long before we re-request TURN credentials. The server mints them with
 * a 1h TTL and may serve a room-cached mint up to 20 minutes old, so a peer
 * connection created at any moment gets credentials that are still valid.
 */
const TURN_CREDENTIAL_REFRESH_MS = 30 * 60 * 1000; // 30m

/** Cool-off after a failed credential request, so a down server isn't hammered. */
const TURN_CREDENTIAL_RETRY_MS = 60 * 1000; // 1m

/**
 * Bound on waiting for a turn-response. Covers the server's 5s upstream mint
 * budget plus transit; past it, connections proceed with whatever ICE config
 * is already held.
 */
const TURN_RESPONSE_TIMEOUT_MS = 6000;

/** Direct WebRTC gets a bounded chance before the encrypted relay takes over. */
const INITIAL_CONNECTION_TIMEOUT_MS = 12_000;
const DISCONNECTED_GRACE_MS = 5_000;
const ICE_RESTART_TIMEOUT_MS = 10_000;

// =============================================================================
// E2E Encryption — AES-256-GCM with HKDF-derived keys
// =============================================================================

const te = new TextEncoder();
const td = new TextDecoder();

/**
 * Import a raw 256-bit key and derive an AES-GCM CryptoKey via HKDF.
 * The info string makes keys domain-separated even if the raw material
 * is reused across contexts.
 */
async function deriveAesKey(rawKey: Uint8Array, info: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", rawKey.buffer as ArrayBuffer, "HKDF", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32), // fixed salt — uniqueness comes from info
      info: te.encode(info),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a string → base64(iv + ciphertext). */
async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    te.encode(plaintext),
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return uint8ToBase64(out);
}

/** Decrypt base64(iv + ciphertext) → string. Returns null on failure. */
async function decrypt(key: CryptoKey, encoded: string): Promise<string | null> {
  try {
    const bytes = base64ToUint8(encoded);
    const iv = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return td.decode(pt);
  } catch {
    return null;
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// =============================================================================
// Message chunking — split large messages so they fit within DataChannel limits
// =============================================================================

/**
 * WebRTC DataChannels have a browser-dependent max message size (16KB–256KB).
 * We use 15KB payload per chunk to stay safely under all implementations.
 *
 * Wire format:
 *   Single message (fits in one chunk):
 *     [0x00] [payload...]
 *
 *   Chunked message:
 *     [0x01] [msgId: uint32] [chunkIndex: uint16] [totalChunks: uint16] [payload...]
 *
 * Overhead: 1 byte for small messages, 9 bytes per chunk for large messages.
 */

const MAX_CHUNK_PAYLOAD = 15 * 1024; // 15 KB — safe for all browsers
const FLAG_SINGLE = 0x00;
const FLAG_CHUNKED = 0x01;
const CHUNK_HEADER_SIZE = 9; // 1 flag + 4 msgId + 2 chunkIndex + 2 totalChunks

/**
 * Split `data` into DataChannel-sized frames. `msgId` scopes the chunks of one
 * message; each peer owns its own counter (a module-level counter would be
 * shared mutable state across every topic and editor on the page).
 */
function chunkMessage(data: Uint8Array, msgId: number): Uint8Array[] {
  if (data.byteLength <= MAX_CHUNK_PAYLOAD) {
    // Fits in a single frame — prepend flag byte
    const frame = new Uint8Array(1 + data.byteLength);
    frame[0] = FLAG_SINGLE;
    frame.set(data, 1);
    return [frame];
  }

  const totalChunks = Math.ceil(data.byteLength / MAX_CHUNK_PAYLOAD);
  const chunks: Uint8Array[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const start = i * MAX_CHUNK_PAYLOAD;
    const end = Math.min(start + MAX_CHUNK_PAYLOAD, data.byteLength);
    const payload = data.subarray(start, end);

    const frame = new Uint8Array(CHUNK_HEADER_SIZE + payload.byteLength);
    const view = new DataView(frame.buffer);
    frame[0] = FLAG_CHUNKED;
    view.setUint32(1, msgId >>> 0);
    view.setUint16(5, i);
    view.setUint16(7, totalChunks);
    frame.set(payload, CHUNK_HEADER_SIZE);
    chunks.push(frame);
  }

  return chunks;
}

/**
 * Ceiling on one reassembled message. Far above any real ops batch, but keeps
 * a misbehaving peer from ballooning memory through the reassembly buffer.
 */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/**
 * How many partially-received messages one peer may have in flight.
 *
 * The DataChannel is ordered, so in practice only one message is ever being
 * reassembled. The relay path is not so simple: frames there are individually
 * encrypted and decrypted, and a `pending.clear()` on every new msgId would let
 * two interleaved messages silently evict each other. Holding a few and
 * evicting the oldest is bounded and loses nothing that was going to complete.
 */
const MAX_PENDING_MESSAGES = 4;

/** Reassembly buffer for incoming chunked messages from a single peer. */
class ChunkAssembler {
  private pending = new Map<number, { chunks: (Uint8Array | null)[]; received: number; totalSize: number }>();

  /**
   * Process an incoming frame. Returns the complete message once all chunks
   * arrive, or null if still waiting for more chunks. Malformed or
   * protocol-violating frames are dropped, never thrown on: the peer is
   * remote input.
   */
  process(frame: Uint8Array): Uint8Array | null {
    if (frame.byteLength === 0) return null;
    if (frame[0] === FLAG_SINGLE) {
      return frame.subarray(1);
    }
    if (frame[0] !== FLAG_CHUNKED || frame.byteLength < CHUNK_HEADER_SIZE) return null;

    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const msgId = view.getUint32(1);
    const chunkIndex = view.getUint16(5);
    const totalChunks = view.getUint16(7);
    const payload = frame.subarray(CHUNK_HEADER_SIZE);
    if (totalChunks === 0 || chunkIndex >= totalChunks) return null;

    let entry = this.pending.get(msgId);
    if (entry && entry.chunks.length !== totalChunks) {
      // Contradictory totals for one msgId — discard the poisoned message.
      this.pending.delete(msgId);
      return null;
    }
    if (!entry) {
      // Evict the oldest in-flight message once too many are open, rather than
      // assuming a new msgId means every other one is abandoned. Map iteration
      // is insertion-ordered, so the first key is the oldest.
      while (this.pending.size >= MAX_PENDING_MESSAGES) {
        const oldest = this.pending.keys().next().value;
        if (oldest === undefined) break;
        this.pending.delete(oldest);
      }
      entry = { chunks: new Array(totalChunks).fill(null), received: 0, totalSize: 0 };
      this.pending.set(msgId, entry);
    }

    if (entry.chunks[chunkIndex] === null) {
      entry.chunks[chunkIndex] = payload;
      entry.received++;
      entry.totalSize += payload.byteLength;
      if (entry.totalSize > MAX_MESSAGE_BYTES) {
        this.pending.delete(msgId);
        return null;
      }
    }

    if (entry.received < entry.chunks.length) return null;

    // All chunks received — reassemble
    this.pending.delete(msgId);
    const assembled = new Uint8Array(entry.totalSize);
    let offset = 0;
    for (const chunk of entry.chunks) {
      assembled.set(chunk!, offset);
      offset += chunk!.byteLength;
    }
    return assembled;
  }

  clear() {
    this.pending.clear();
  }
}

// =============================================================================
// Peer — wraps one RTCPeerConnection + DataChannel
// =============================================================================

class WebRtcPeer implements NetworkPeer {
  readonly remotePublicKey: string;
  readonly pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private messageListeners = new Set<(data: Uint8Array) => void>();
  private closeListeners = new Set<() => void>();
  private dcReady: Promise<void>;
  private resolveDcReady!: () => void;
  private assembler = new ChunkAssembler();
  private nextMsgId = 0;
  private opened = false;

  constructor(remotePublicKey: string, pc: RTCPeerConnection) {
    this.remotePublicKey = remotePublicKey;
    this.pc = pc;
    this.dcReady = new Promise((r) => { this.resolveDcReady = r; });
  }

  /** Called by the topic when a data channel is established */
  _setDataChannel(dc: RTCDataChannel, onOpen?: () => void) {
    this.dc = dc;
    dc.binaryType = "arraybuffer";
    const rShort = this.remotePublicKey.slice(0, 8);

    dc.onmessage = (e) => {
      const frame = new Uint8Array(e.data as ArrayBuffer);
      const message = this.assembler.process(frame);
      if (message) {
        for (const cb of this.messageListeners) cb(message);
      }
    };

    dc.onclose = () => this._fireClose();

    dc.onerror = (e) => {
      console.error(`[WebRTC] datachannel error remote=${rShort}`, e);
    };

    const handleOpen = () => {
      if (this.opened) return;
      this.opened = true;
      this.resolveDcReady();
      onOpen?.();
    };

    if (dc.readyState === "open") {
      handleOpen();
    } else {
      dc.onopen = handleOpen;
    }
  }

  hasOpened(): boolean {
    return this.opened;
  }

  isReady(): boolean {
    return this.dc?.readyState === "open";
  }

  _fireClose() {
    this.assembler.clear();
    for (const cb of this.closeListeners) cb();
    this.messageListeners.clear();
    this.closeListeners.clear();
  }

  private _sendRaw(data: Uint8Array): void {
    this.dc!.send(data as ArrayBufferView<ArrayBuffer>);
  }

  send(data: Uint8Array): void {
    const chunks = chunkMessage(data, this.nextMsgId++);
    if (this.dc?.readyState === "open") {
      for (const chunk of chunks) this._sendRaw(chunk);
    } else {
      this.dcReady.then(() => {
        if (this.dc?.readyState === "open") {
          for (const chunk of chunks) this._sendRaw(chunk);
        }
      });
    }
  }

  onMessage(cb: (data: Uint8Array) => void): () => void {
    this.messageListeners.add(cb);
    return () => { this.messageListeners.delete(cb); };
  }

  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => { this.closeListeners.delete(cb); };
  }

  /** Bytes still queued in the datachannel's send buffer (0 when drained). */
  bufferedAmount(): number {
    return this.dc?.bufferedAmount ?? 0;
  }

  close(): void {
    this.dc?.close();
    this.pc.close();
    this._fireClose();
  }
}

// =============================================================================
// RelayPeer — fallback when ICE fails, routes data through CF (encrypted)
// =============================================================================

class RelayPeer implements NetworkPeer {
  readonly remotePublicKey: string;
  private relaySend: (target: string, data: string) => Promise<void>;
  private messageListeners = new Set<(data: Uint8Array) => void>();
  private closeListeners = new Set<() => void>();
  private closed = false;
  private assembler = new ChunkAssembler();
  private nextMsgId = 0;
  /** Serializes sends: each chunk is separately encrypted, and `crypto.subtle`
   *  does not resolve in call order. Without this the relay would emit the
   *  chunks of two messages interleaved. */
  private sendQueue: Promise<void> = Promise.resolve();
  /** Bytes chunked but not yet handed to the socket. Read by `flush()`. */
  private pendingBytes = 0;

  constructor(
    remotePublicKey: string,
    relaySend: (target: string, data: string) => Promise<void>,
  ) {
    this.remotePublicKey = remotePublicKey;
    this.relaySend = relaySend;
  }

  send(data: Uint8Array): void {
    if (this.closed) return;
    const chunks = chunkMessage(data, this.nextMsgId++);
    const batchBytes = chunks.reduce((n, c) => n + c.byteLength, 0);
    this.pendingBytes += batchBytes;

    this.sendQueue = this.sendQueue.then(async () => {
      let unsent = batchBytes;
      try {
        for (const chunk of chunks) {
          if (this.closed) break;
          await this.relaySend(this.remotePublicKey, uint8ToBase64(chunk));
          unsent -= chunk.byteLength;
          this.pendingBytes -= chunk.byteLength;
        }
      } catch (e) {
        console.error(
          `[WebRTC] relay send failed remote=${this.remotePublicKey.slice(0, 8)}`,
          e,
        );
      } finally {
        // Whatever never went out must not stay counted, or flush() spins.
        this.pendingBytes -= unsent;
      }
    });
  }

  /** Called by the topic when a relay message arrives for this peer */
  _receiveRelay(data: Uint8Array): void {
    const message = this.assembler.process(data);
    if (message) {
      for (const cb of this.messageListeners) cb(message);
    }
  }

  onMessage(cb: (data: Uint8Array) => void): () => void {
    this.messageListeners.add(cb);
    return () => { this.messageListeners.delete(cb); };
  }

  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => { this.closeListeners.delete(cb); };
  }

  /**
   * Bytes chunked but not yet written to the CF WebSocket. Non-zero while the
   * send queue drains its per-chunk encryption, which is what `flush()` needs
   * to wait for before `pause()` tears the socket down.
   */
  bufferedAmount(): number {
    return this.pendingBytes;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.assembler.clear();
    for (const cb of this.closeListeners) cb();
    this.messageListeners.clear();
    this.closeListeners.clear();
  }
}

// =============================================================================
// Topic — manages peer connections + its own WebSocket to CF
// =============================================================================

/** Driver-side TURN credential state, shared by every topic. */
interface TurnCredentialManager {
  /** A topic's socket (re)opened — refresh credentials through it if stale. */
  socketOpened(topic: WebRtcTopic): void;
  /** A turn-response frame arrived (routed outside the ordered inbound chain). */
  handleTurnResponse(msg: unknown): void;
  /**
   * Resolves once no credential request is in flight. Resolves immediately
   * while TURN credentials are held — a background rotation must not delay
   * new connections.
   */
  credentialsSettled(): Promise<void>;
}

class WebRtcTopic implements NetworkTopic {
  private localPeerId: string;
  private topicHex: string;
  private signalUrl: string;
  /** Never null: a topic without a key would signal in cleartext. See `join()`. */
  private encKey: CryptoKey;
  /** Read per connection, not captured: TURN credentials expire and are refreshed. */
  private getRtcConfig: () => RTCConfiguration;
  private turn: TurnCredentialManager;
  private ws: WebSocket | null = null;
  private wsReady: Promise<void> = Promise.resolve();
  /** Serializes inbound frame handling — see {@link enqueueWsMessage}. */
  private inbound: Promise<void> = Promise.resolve();
  private destroyed = false;
  private suspended = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionDeadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private restartAttempted = new Set<string>();
  private pendingIce = new Map<string, (RTCIceCandidateInit | null)[]>();
  private signalQueues = new Map<string, Promise<void>>();

  private peers = new Map<string, WebRtcPeer | RelayPeer>();
  private joinListeners = new Set<(peer: NetworkPeer) => void>();
  private leaveListeners = new Set<(publicKey: string) => void>();

  constructor(
    localPeerId: string,
    topicHex: string,
    signalUrl: string,
    encKey: CryptoKey,
    getRtcConfig: () => RTCConfiguration,
    turn: TurnCredentialManager,
  ) {
    this.localPeerId = localPeerId;
    this.topicHex = topicHex;
    this.signalUrl = signalUrl;
    this.encKey = encKey;
    this.getRtcConfig = getRtcConfig;
    this.turn = turn;
  }

  /** Connect to the CF Worker and start receiving signals. */
  async connect(): Promise<void> {
    await this.ensureWs();
  }

  // ---------------------------------------------------------------------------
  // WebSocket management (per-topic)
  // ---------------------------------------------------------------------------

  private ensureWs(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.ws?.readyState === WebSocket.CONNECTING) return this.wsReady;

    // A CLOSING socket falls through the guards above. Drop the reference now,
    // which is what makes `isCurrent()` false for its handlers: they may still
    // settle their own `wsReady` (so nothing awaiting it hangs), but they must
    // not touch state that now belongs to the socket we are about to install.
    this.ws = null;

    // Captured per call rather than stored on the instance: a superseded
    // socket's handlers would otherwise settle the *next* socket's promise.
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    this.wsReady = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // The reconnect timer calls ensureWs() and ignores the result, so nothing
    // may be awaiting this. Mark it handled; `connect()` still sees the throw.
    this.wsReady.catch(() => {});

    const url = `${this.signalUrl}/topic/${this.topicHex}?peerId=${encodeURIComponent(this.localPeerId)}`;
    const topicShort = this.topicHex.slice(0, 8);

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(`[WS] failed to create WebSocket topic=${topicShort} url=${url}:`, err.message);
      rejectReady(err);
      return this.wsReady;
    }
    this.ws = socket;

    /** False once this socket has been superseded or torn down. */
    const isCurrent = () => this.ws === socket;
    let opened = false;

    socket.onopen = () => {
      if (!isCurrent()) return;
      opened = true;
      console.log(`[WS] connected topic=${topicShort} peer=${this.localPeerId.slice(0, 8)}`);
      this.reconnectAttempt = 0;
      resolveReady();
      this.turn.socketOpened(this);
    };

    socket.onmessage = (e) => {
      if (!isCurrent()) return;
      this.enqueueWsMessage(e.data);
    };

    socket.onclose = (ev) => {
      console.log(`[WS] closed topic=${topicShort} code=${ev.code} clean=${ev.wasClean} reason=${ev.reason || "(none)"}`);
      if (!ev.wasClean) {
        console.error(`[WS] unexpected close topic=${topicShort} code=${ev.code} reason=${ev.reason || "(none)"}`);
      }

      // If the socket closed before onopen fired, reject the pending promise
      // so callers don't hang forever.
      if (!opened) {
        rejectReady(new Error(`WebSocket closed before open (code=${ev.code})`));
      }

      // Superseded socket: a newer one owns the peers, the reconnect timer and
      // the `ws` reference. Touching any of them here would tear down a live
      // connection and start a second reconnect loop.
      if (!isCurrent()) return;

      // Tear down peer connections but keep listeners so reconnected peers
      // re-trigger handlePeerJoin in the Replicator.
      this._reset();
      this.ws = null;

      // Skip reconnect when destroyed (terminal) or suspended (backgrounded):
      // suspend() closed this socket on purpose and resume() will re-open it.
      if (this.destroyed || this.suspended) return;

      // Reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s)
      const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30000);
      this.reconnectAttempt++;
      console.log(`[WS] reconnecting topic=${topicShort} attempt=${this.reconnectAttempt} delay=${delay}ms`);

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.ensureWs().catch(() => { /* will retry on next onclose */ });
      }, delay);
    };

    socket.onerror = () => {
      console.error(`[WS] connection error topic=${topicShort} url=${url}`);
      // onerror is always followed by onclose, which handles reconnection
    };

    return this.wsReady;
  }

  /**
   * Hand an inbound frame to the serialized handler chain.
   *
   * Each frame decrypts asynchronously, and `crypto.subtle` does not resolve in
   * call order — processing them concurrently lets an `ice` frame overtake the
   * `offer` that creates its RTCPeerConnection (the candidate is then dropped),
   * and lets relay chunks reassemble out of order. One at a time, in arrival
   * order, is the only thing the signaling protocol will tolerate.
   *
   * turn-response is the one exception, delivered here outside the chain:
   * the chain's head may be a `peers` frame awaiting that very response
   * (see credentialsSettled), so routing it through would deadlock.
   */
  private enqueueWsMessage(raw: unknown): void {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch { return; }
    if (typeof msg !== "object" || msg === null) return;

    if ((msg as { type?: unknown }).type === "turn-response") {
      this.turn.handleTurnResponse(msg);
      return;
    }

    this.inbound = this.inbound
      .then(() => this.handleWsMessage(msg))
      .catch((e) => {
        console.error(`[WS] message handler failed topic=${this.topicHex.slice(0, 8)}`, e);
      });
  }

  private wsSend(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.error(`[WS] send dropped — socket not open (state=${this.ws?.readyState ?? "null"}) topic=${this.topicHex.slice(0, 8)}`);
    }
  }

  /**
   * Send a turn-request if the socket is open. The driver owns credential
   * state and timing; the topic only provides the transport.
   */
  trySendTurnRequest(): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: "turn-request" }));
    return true;
  }

  // ---------------------------------------------------------------------------
  // Encrypted signal/relay sending
  // ---------------------------------------------------------------------------

  private sendSignal(target: string, data: unknown): Promise<void> {
    // Encryption resolves out of order. Serialize per peer so offer/answer,
    // candidates and the end-of-candidates marker stay in signaling order.
    const previous = this.signalQueues.get(target) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const encrypted = await encrypt(this.encKey, JSON.stringify(data));
      this.wsSend({ type: "signal", target, data: encrypted });
    });
    this.signalQueues.set(target, pending);
    void pending.finally(() => {
      if (this.signalQueues.get(target) === pending) this.signalQueues.delete(target);
    }).catch(() => {});
    return pending;
  }

  private async sendRelay(target: string, data: string): Promise<void> {
    const encrypted = await encrypt(this.encKey, data);
    this.wsSend({ type: "relay", target, data: encrypted });
  }

  // ---------------------------------------------------------------------------
  // Incoming WebSocket messages
  // ---------------------------------------------------------------------------

  private async handleWsMessage(msg: any) {
    const topicShort = this.topicHex.slice(0, 8);
    // The signaling server is untrusted (it is the party this file encrypts
    // against), so its frames are validated before they are dereferenced.
    const isPeerId = (v: unknown): v is string => typeof v === "string" && v.length > 0;

    switch (msg.type) {
      case "peers": {
        if (!Array.isArray(msg.peerIds)) return;
        const peerIds: string[] = msg.peerIds.filter(isPeerId);
        console.log(`[WS] peers topic=${topicShort} count=${peerIds.length} ids=[${peerIds.map((id) => id.slice(0, 8)).join(", ")}]`);
        // Hold new connections briefly while a TURN mint is in flight, so the
        // first RTCPeerConnections are built relay-capable.
        await this.turn.credentialsSettled();
        for (const peerId of peerIds) {
          await this._handlePeerJoin(peerId);
        }
        break;
      }
      case "peer-join":
        if (!isPeerId(msg.peerId)) return;
        console.log(`[WS] peer-join topic=${topicShort} peer=${msg.peerId.slice(0, 8)}`);
        await this.turn.credentialsSettled();
        await this._handlePeerJoin(msg.peerId);
        break;
      case "peer-left":
        if (!isPeerId(msg.peerId)) return;
        console.log(`[WS] peer-left topic=${topicShort} peer=${msg.peerId.slice(0, 8)}`);
        this._handlePeerLeft(msg.peerId);
        break;
      case "signal": {
        if (!isPeerId(msg.from) || typeof msg.data !== "string") return;
        const decrypted = await decrypt(this.encKey, msg.data);
        if (decrypted === null) {
          console.error(`[WebRTC] signal decryption failed from=${msg.from.slice(0, 8)}`);
          return;
        }
        // The plaintext is peer-controlled: a room member can encrypt garbage.
        let data: unknown;
        try {
          data = JSON.parse(decrypted);
        } catch {
          console.error(`[WebRTC] signal payload is not JSON from=${msg.from.slice(0, 8)}`);
          return;
        }
        if (typeof data !== "object" || data === null) return;
        await this._handleSignal(msg.from, data);
        break;
      }
      case "relay": {
        if (!isPeerId(msg.from) || typeof msg.data !== "string") return;
        const decrypted = await decrypt(this.encKey, msg.data);
        if (decrypted === null) {
          console.error(`[WebRTC] relay decryption failed from=${msg.from.slice(0, 8)}`);
          return;
        }
        let bytes: Uint8Array;
        try {
          bytes = base64ToUint8(decrypted);
        } catch {
          console.error(`[WebRTC] relay payload is not base64 from=${msg.from.slice(0, 8)}`);
          return;
        }
        this._handleRelayMessage(msg.from, bytes);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Peer connection management (same logic as before)
  // ---------------------------------------------------------------------------

  private configurePeer(remotePeerId: string, peer: WebRtcPeer): void {
    const pc = peer.pc;
    const rShort = remotePeerId.slice(0, 8);

    pc.onicecandidate = (e) => {
      const candidate = e.candidate ? e.candidate.toJSON() : null;
      void this.sendSignal(remotePeerId, { type: "ice", candidate }).catch(
        (err) => console.error(`[WebRTC] failed to send ice remote=${rShort}`, err),
      );
    };

    pc.onicecandidateerror = (e) => {
      console.warn(
        `[WebRTC] ICE candidate error remote=${rShort} code=${e.errorCode} url=${e.url || "(unknown)"}`,
      );
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] connectionState=${pc.connectionState} remote=${rShort}`);
      if (pc.connectionState === "failed") {
        this._promoteToRelay(remotePeerId);
      } else if (pc.connectionState === "connected" && peer.isReady()) {
        this.markPeerConnected(remotePeerId, peer);
      } else if (pc.connectionState === "closed") {
        this._removePeer(remotePeerId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] iceConnectionState=${pc.iceConnectionState} remote=${rShort}`);
      if (pc.iceConnectionState === "failed") {
        this._promoteToRelay(remotePeerId);
      } else if (pc.iceConnectionState === "disconnected" && peer.hasOpened()) {
        this.scheduleIceRecovery(remotePeerId, peer);
      } else if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        this.clearDisconnectTimer(remotePeerId);
        if (peer.isReady()) this.markPeerConnected(remotePeerId, peer);
      }
    };
  }

  private markPeerConnected(remotePeerId: string, peer: WebRtcPeer): void {
    if (this.peers.get(remotePeerId) !== peer) return;
    this.clearConnectionDeadline(remotePeerId);
    this.clearDisconnectTimer(remotePeerId);
    this.restartAttempted.delete(remotePeerId);
  }

  private startConnectionDeadline(remotePeerId: string, peer: WebRtcPeer, timeoutMs: number): void {
    this.clearConnectionDeadline(remotePeerId);
    if (peer.pc.connectionState === "connected" && peer.isReady()) return;

    const timer = setTimeout(() => {
      this.connectionDeadlines.delete(remotePeerId);
      if (this.peers.get(remotePeerId) !== peer) return;
      if (peer.pc.connectionState === "connected" && peer.isReady()) return;
      console.warn(`[WebRTC] direct connection timed out remote=${remotePeerId.slice(0, 8)} after=${timeoutMs}ms`);
      this._promoteToRelay(remotePeerId);
    }, timeoutMs);
    this.connectionDeadlines.set(remotePeerId, timer);
  }

  private clearConnectionDeadline(remotePeerId: string): void {
    const timer = this.connectionDeadlines.get(remotePeerId);
    if (timer) clearTimeout(timer);
    this.connectionDeadlines.delete(remotePeerId);
  }

  private clearDisconnectTimer(remotePeerId: string): void {
    const timer = this.disconnectTimers.get(remotePeerId);
    if (timer) clearTimeout(timer);
    this.disconnectTimers.delete(remotePeerId);
  }

  private scheduleIceRecovery(remotePeerId: string, peer: WebRtcPeer): void {
    if (this.disconnectTimers.has(remotePeerId)) return;
    const timer = setTimeout(() => {
      this.disconnectTimers.delete(remotePeerId);
      if (this.peers.get(remotePeerId) !== peer || peer.pc.iceConnectionState !== "disconnected") return;

      // Only the deterministic offerer restarts ICE, preventing offer glare.
      if (this.localPeerId > remotePeerId && !this.restartAttempted.has(remotePeerId)) {
        this.restartAttempted.add(remotePeerId);
        void this.restartIce(remotePeerId, peer);
      } else {
        this.startConnectionDeadline(remotePeerId, peer, ICE_RESTART_TIMEOUT_MS);
      }
    }, DISCONNECTED_GRACE_MS);
    this.disconnectTimers.set(remotePeerId, timer);
  }

  private async restartIce(remotePeerId: string, peer: WebRtcPeer): Promise<void> {
    if (this.peers.get(remotePeerId) !== peer) return;
    try {
      peer.pc.restartIce();
      const offer = await peer.pc.createOffer({ iceRestart: true });
      await peer.pc.setLocalDescription(offer);
      await this.sendSignal(remotePeerId, { type: "offer", sdp: offer });
      console.log(`[WebRTC] ICE restart sent remote=${remotePeerId.slice(0, 8)}`);
      this.startConnectionDeadline(remotePeerId, peer, ICE_RESTART_TIMEOUT_MS);
    } catch (e) {
      console.error(`[WebRTC] ICE restart failed remote=${remotePeerId.slice(0, 8)}`, e);
      this._promoteToRelay(remotePeerId);
    }
  }

  private queueIce(remotePeerId: string, candidate: RTCIceCandidateInit | null): void {
    const queued = this.pendingIce.get(remotePeerId) ?? [];
    if (queued.length < 64) queued.push(candidate);
    this.pendingIce.set(remotePeerId, queued);
  }

  private async flushPendingIce(remotePeerId: string, peer: WebRtcPeer): Promise<void> {
    const queued = this.pendingIce.get(remotePeerId);
    if (!queued) return;
    this.pendingIce.delete(remotePeerId);
    for (const candidate of queued) {
      try {
        await peer.pc.addIceCandidate(candidate ? new RTCIceCandidate(candidate) : null);
      } catch (e) {
        console.warn(`[WebRTC] dropped stale ICE candidate from=${remotePeerId.slice(0, 8)}`, e);
      }
    }
  }

  async _handlePeerJoin(remotePeerId: string) {
    // The room can name us back: a reconnect under the same peerId leaves the
    // old socket briefly alive, and the server lists it as a peer. Connecting
    // to ourselves wedges a peer slot forever — `isInitiator` is false for
    // equal ids, so the responder branch would wait for a channel nobody opens.
    if (remotePeerId === this.localPeerId) return;
    if (this.peers.has(remotePeerId)) return;

    const rShort = remotePeerId.slice(0, 8);
    const topicShort = this.topicHex.slice(0, 8);

    const pc = new RTCPeerConnection(this.getRtcConfig());
    const peer = new WebRtcPeer(remotePeerId, pc);
    this.peers.set(remotePeerId, peer);
    this.configurePeer(remotePeerId, peer);

    // Deterministic: higher ID creates the offer (prevents duplicate connections)
    const isInitiator = this.localPeerId > remotePeerId;
    console.log(`[WebRTC] new peer remote=${rShort} topic=${topicShort} role=${isInitiator ? "initiator" : "responder"}`);

    if (isInitiator) {
      const dc = pc.createDataChannel("data", { ordered: true });
      peer._setDataChannel(dc, () => {
        console.log(`[WebRTC] datachannel opened remote=${rShort}`);
        this.markPeerConnected(remotePeerId, peer);
        for (const cb of this.joinListeners) cb(peer);
      });

      // A peer-left (or suspend) arriving while these await can close `pc`, and
      // both calls then reject. Drop the half-built peer rather than leave it
      // in the map with no offer ever sent.
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log(`[WebRTC] sent offer remote=${rShort}`);
        await this.sendSignal(remotePeerId, { type: "offer", sdp: offer });
        this.startConnectionDeadline(remotePeerId, peer, INITIAL_CONNECTION_TIMEOUT_MS);
      } catch (e) {
        console.error(`[WebRTC] offer failed remote=${rShort}`, e);
        this._removePeer(remotePeerId);
      }
    } else {
      pc.ondatachannel = (e) => {
        peer._setDataChannel(e.channel, () => {
          console.log(`[WebRTC] datachannel opened remote=${rShort}`);
          this.markPeerConnected(remotePeerId, peer);
          for (const cb of this.joinListeners) cb(peer);
        });
      };
    }
  }

  /** Called when we receive signaling data from a remote peer */
  async _handleSignal(from: string, data: any) {
    const fShort = from.slice(0, 8);
    console.log(`[WebRTC] signal recv type=${data.type} from=${fShort}`);

    let peer = this.peers.get(from);

    // Ignore signaling for peers that already fell back to relay
    if (peer instanceof RelayPeer) return;

    if (data.type === "offer") {
      // Ignore renegotiation offers on an already-connected peer — these are
      // spurious retries caused by duplicate peer-join events on the initiator side.
      // Exception: if ICE is unhealthy, accept the offer as a restart on the
      // existing connection so its DataChannel can recover in place.
      if (peer instanceof WebRtcPeer && peer.pc.connectionState === "connected") {
        const iceHealthy =
          peer.pc.iceConnectionState === "connected" ||
          peer.pc.iceConnectionState === "completed";
        if (iceHealthy) {
          console.warn(`[WebRTC] ignoring renegotiation offer from ${fShort} (already connected)`);
          return;
        }
        console.log(`[WebRTC] stale connection to ${fShort} (ice=${peer.pc.iceConnectionState}) — accepting reconnect offer`);
      }

      if (!peer) {
        const pc = new RTCPeerConnection(this.getRtcConfig());
        peer = new WebRtcPeer(from, pc);
        this.peers.set(from, peer);
        this.configurePeer(from, peer);

        pc.ondatachannel = (e) => {
          (peer as WebRtcPeer)._setDataChannel(e.channel, () => {
            this.markPeerConnected(from, peer as WebRtcPeer);
            for (const cb of this.joinListeners) cb(peer!);
          });
        };
      }

      // Everything below is driven by a remote peer's SDP. Malformed or
      // out-of-state descriptions reject; without a catch the rejection escapes
      // the message queue and the half-built peer is stranded in the map.
      try {
        const rtcPeer = peer as WebRtcPeer;
        await rtcPeer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        await this.flushPendingIce(from, rtcPeer);
        const answer = await rtcPeer.pc.createAnswer();
        await rtcPeer.pc.setLocalDescription(answer);
        await this.sendSignal(from, { type: "answer", sdp: answer });
        this.startConnectionDeadline(
          from,
          rtcPeer,
          rtcPeer.hasOpened() ? ICE_RESTART_TIMEOUT_MS : INITIAL_CONNECTION_TIMEOUT_MS,
        );
      } catch (e) {
        console.error(`[WebRTC] failed to answer offer from=${fShort}`, e);
        this._removePeer(from);
      }
    } else if (data.type === "answer") {
      if (!peer) return;
      try {
        const rtcPeer = peer as WebRtcPeer;
        await rtcPeer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        await this.flushPendingIce(from, rtcPeer);
      } catch (e) {
        console.error(`[WebRTC] failed to apply answer from=${fShort}`, e);
      }
    } else if (data.type === "ice") {
      if (data.candidate !== null && (typeof data.candidate !== "object" || !data.candidate)) return;
      const candidate = data.candidate as RTCIceCandidateInit | null;
      if (!peer || !(peer as WebRtcPeer).pc.remoteDescription) {
        this.queueIce(from, candidate);
        return;
      }
      try {
        await (peer as WebRtcPeer).pc.addIceCandidate(candidate ? new RTCIceCandidate(candidate) : null);
      } catch (e) {
        // A restart candidate can overtake its offer; keep it for the next
        // remote description instead of discarding a potentially viable path.
        this.queueIce(from, candidate);
        console.warn(`[WebRTC] deferred ICE candidate from=${fShort}`, e);
      }
    } else if (data.type === "relay-start") {
      this._promoteToRelay(from, false);
    }
  }

  _handlePeerLeft(remotePeerId: string) {
    this._removePeer(remotePeerId);
  }

  /** ICE failed — swap to relay transport, transparent to the Replicator */
  private _promoteToRelay(remotePeerId: string, notifyRemote = true) {
    const existing = this.peers.get(remotePeerId);
    if (existing instanceof RelayPeer) return;

    this.clearConnectionDeadline(remotePeerId);
    this.clearDisconnectTimer(remotePeerId);
    this.restartAttempted.delete(remotePeerId);
    this.pendingIce.delete(remotePeerId);
    this.signalQueues.delete(remotePeerId);

    if (notifyRemote) {
      void this.sendSignal(remotePeerId, { type: "relay-start" }).catch((e) => {
        console.error(`[WebRTC] failed to signal relay fallback remote=${remotePeerId.slice(0, 8)}`, e);
      });
    }

    // Remove from map BEFORE closing to prevent the "closed" connectionState
    // handler from firing _removePeer (which would emit leave events)
    this.peers.delete(remotePeerId);
    existing?.close();

    // Create a relay peer that sends through the CF WebSocket (encrypted)
    const relayPeer = new RelayPeer(remotePeerId, (target, data) =>
      this.sendRelay(target, data),
    );
    this.peers.set(remotePeerId, relayPeer);

    console.log(`[WebRTC] direct transport unavailable for ${remotePeerId.slice(0, 8)}… — falling back to relay`);

    // Fire join listeners so the Replicator sees a new (relay) peer
    for (const cb of this.joinListeners) cb(relayPeer);
  }

  /** Route an incoming relay message to the right RelayPeer */
  _handleRelayMessage(from: string, data: Uint8Array) {
    let peer = this.peers.get(from);

    // The remote side detected ICE failure before us and started relaying —
    // promote our side too so the message isn't dropped
    if (peer && !(peer instanceof RelayPeer)) {
      this._promoteToRelay(from, false);
      peer = this.peers.get(from);
    }

    if (peer instanceof RelayPeer) {
      peer._receiveRelay(data);
    }
  }

  private _removePeer(remotePeerId: string) {
    this.clearConnectionDeadline(remotePeerId);
    this.clearDisconnectTimer(remotePeerId);
    this.restartAttempted.delete(remotePeerId);
    this.pendingIce.delete(remotePeerId);
    this.signalQueues.delete(remotePeerId);
    const peer = this.peers.get(remotePeerId);
    if (!peer) return;
    this.peers.delete(remotePeerId);
    peer.close();
    for (const cb of this.leaveListeners) cb(remotePeerId);
  }

  // ---------------------------------------------------------------------------
  // NetworkTopic interface
  // ---------------------------------------------------------------------------

  onPeerJoin(cb: (peer: NetworkPeer) => void): () => void {
    this.joinListeners.add(cb);
    return () => { this.joinListeners.delete(cb); };
  }

  onPeerLeave(cb: (publicKey: string) => void): () => void {
    this.leaveListeners.add(cb);
    return () => { this.leaveListeners.delete(cb); };
  }

  getPeers(): NetworkPeer[] {
    return Array.from(this.peers.values());
  }

  /** Total bytes still queued across this topic's peer send buffers. */
  bufferedAmount(): number {
    let total = 0;
    for (const peer of this.peers.values()) {
      total += peer.bufferedAmount();
    }
    return total;
  }

  /**
   * Suspend the topic for app backgrounding: close peers and the signaling
   * socket, halt the reconnect backoff, but keep listeners so resume() can
   * rebuild the connection. Unlike destroy(), this is reversible.
   */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._reset();
    this.ws?.close(1000);
    this.ws = null;
  }

  /** Re-open the signaling socket after a suspend(); peers rediscover via CF. */
  async resume(): Promise<void> {
    if (!this.suspended) return;
    this.suspended = false;
    this.reconnectAttempt = 0;
    await this.ensureWs();
  }

  /**
   * Tear down peer connections but keep listeners intact.
   * Used on WebSocket reconnect — peers will re-establish, listeners must survive.
   */
  _reset() {
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();
    for (const timer of this.connectionDeadlines.values()) clearTimeout(timer);
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
    this.connectionDeadlines.clear();
    this.disconnectTimers.clear();
    this.restartAttempted.clear();
    this.pendingIce.clear();
    this.signalQueues.clear();
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._reset();
    this.joinListeners.clear();
    this.leaveListeners.clear();
    this.ws?.close();
    this.ws = null;
  }
}

// =============================================================================
// Driver — manages topics, each with its own WebSocket to CF
// =============================================================================

class WebRtcNetworkDriver implements NetworkDriver, TurnCredentialManager {
  private signalUrl: string;
  private localPeerId: string = "";
  private topics = new Map<string, WebRtcTopic>();
  private topicKeys = new Map<string, Uint8Array>();
  private rtcConfig: RTCConfiguration = STUN_ONLY_CONFIG;
  private hasTurnCredentials = false;
  private credentialsFetchedAt = 0;
  private credentialsFailedAt = 0;
  private turnRequest: {
    settled: Promise<void>;
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(signalUrl: string) {
    this.signalUrl = signalUrl;
  }

  /**
   * The ICE configuration a new RTCPeerConnection should use. Topics call this
   * per connection rather than capturing the config, so a topic that outlives a
   * credential rotation still builds connections with valid TURN credentials.
   */
  private readonly currentRtcConfig = (): RTCConfiguration => this.rtcConfig;

  setLocalId(id: string): void {
    this.localPeerId = id;
  }

  registerTopicKey(topicHex: string, key: Uint8Array): void {
    this.topicKeys.set(topicHex, key);
  }

  unregisterTopicKey(topicHex: string): void {
    this.topicKeys.delete(topicHex);
  }

  /**
   * Request TURN credentials through `topic`'s signaling socket, unless they
   * are fresh, cooling down after a failure, or already being requested.
   * `force` bypasses the freshness check for the periodic rotation.
   * Returns true when a request went out; the matching turn-response (or the
   * timeout) settles it via handleTurnResponse / finishTurnRequest.
   */
  private startTurnRequest(topic: WebRtcTopic, force: boolean): boolean {
    if (this.turnRequest) return false;
    const now = Date.now();
    if (!force && now - this.credentialsFetchedAt < TURN_CREDENTIAL_REFRESH_MS) return false;
    if (now - this.credentialsFailedAt < TURN_CREDENTIAL_RETRY_MS) return false;
    if (!topic.trySendTurnRequest()) return false;

    let resolve!: () => void;
    const settled = new Promise<void>((r) => { resolve = r; });
    const timer = setTimeout(() => {
      // Keep whatever config is held — existing credentials may outlive a
      // failed rotation — and back off before the next attempt.
      this.credentialsFailedAt = Date.now();
      console.warn("[WebRTC] TURN credential request timed out");
      this.finishTurnRequest();
    }, TURN_RESPONSE_TIMEOUT_MS);
    this.turnRequest = { settled, resolve, timer };
    return true;
  }

  private finishTurnRequest(): void {
    const req = this.turnRequest;
    if (!req) return;
    this.turnRequest = null;
    clearTimeout(req.timer);
    req.resolve();
  }

  socketOpened(topic: WebRtcTopic): void {
    this.startTurnRequest(topic, false);
  }

  handleTurnResponse(msg: unknown): void {
    const frame = msg as { iceServers?: unknown; error?: unknown };
    // The signaling server is untrusted — validate before adopting.
    if (frame.iceServers && typeof frame.iceServers === "object") {
      this.rtcConfig = {
        iceServers: [
          { urls: "stun:stun.cloudflare.com:3478" },
          frame.iceServers as RTCIceServer,
        ],
      };
      this.hasTurnCredentials = true;
      this.credentialsFetchedAt = Date.now();
      this.credentialsFailedAt = 0;
      console.log("[WebRTC] TURN credentials fetched");
    } else {
      // Keep the current config: STUN-only if we never had credentials, the
      // previous (possibly still valid) credentials if a rotation failed.
      this.credentialsFailedAt = Date.now();
      console.warn("[WebRTC] TURN credentials unavailable, using STUN only:", frame.error);
    }
    this.finishTurnRequest();
  }

  credentialsSettled(): Promise<void> {
    if (!this.turnRequest || this.hasTurnCredentials) return Promise.resolve();
    return this.turnRequest.settled;
  }

  /**
   * Rotate TURN credentials for as long as any topic is open. Without this a
   * long-lived topic would keep building peer connections from credentials that
   * expired at their TTL.
   */
  private startCredentialRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      // Any topic with an open socket can carry the request. If none is open,
      // skip: the next socketOpened() refreshes by staleness.
      for (const topic of this.topics.values()) {
        if (this.startTurnRequest(topic, true)) break;
      }
    }, TURN_CREDENTIAL_REFRESH_MS);
  }

  async join(topic: Uint8Array): Promise<NetworkTopic> {
    const hex = Array.from(topic).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (this.topics.has(hex)) return this.topics.get(hex)!;

    invariant(this.localPeerId, "NetworkDriver: setLocalId() must be called before join()");

    // Fail closed. Signaling carries SDP, ICE candidates (which leak local
    // addresses), and — on relay fallback — document bytes. Joining without a
    // key would send all of it to the relay in cleartext, so refuse instead.
    const rawKey = this.topicKeys.get(hex);
    invariant(rawKey, `NetworkDriver: registerTopicKey() must be called before join(${hex.slice(0, 8)}…)`);
    const encKey = await deriveAesKey(rawKey, `tasfer-signal:${hex}`);

    // TURN credentials are requested once the topic's socket opens (see
    // socketOpened); `peers` handling gates on the response so first
    // connections are built relay-capable.
    this.startCredentialRefresh();

    const nt = new WebRtcTopic(this.localPeerId, hex, this.signalUrl, encKey, this.currentRtcConfig, this);
    this.topics.set(hex, nt);

    await nt.connect();
    return nt;
  }

  /**
   * Best-effort wait for every topic's peer send buffers to drain, bounded by
   * `timeoutMs`. Resolves immediately when nothing is queued. Called before
   * pause() on backgrounding so an in-flight sync round can finish sending.
   */
  async flush(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const buffered = () => {
      let total = 0;
      for (const topic of this.topics.values()) total += topic.bufferedAmount();
      return total;
    };
    while (buffered() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Suspend every topic's signaling socket + peers (reversible via resume()). */
  async pause(): Promise<void> {
    for (const topic of this.topics.values()) {
      topic.suspend();
    }
  }

  /** Re-open every topic suspended by pause(). */
  async resume(): Promise<void> {
    for (const topic of this.topics.values()) {
      try {
        await topic.resume();
      } catch (e) {
        console.error("[WebRTC] topic resume failed:", e);
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.finishTurnRequest();
    for (const [, topic] of this.topics) {
      await topic.destroy();
    }
    this.topics.clear();
    this.topicKeys.clear();
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createWebRtcNetworkDriver(signalUrl: string): NetworkDriver {
  return new WebRtcNetworkDriver(signalUrl);
}
