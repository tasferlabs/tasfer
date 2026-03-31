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
 *     leaving the device — Cloudflare only sees opaque blobs
 *   - After signaling, data flows directly peer-to-peer over DataChannels
 *   - If ICE fails, falls back to relay through CF (also encrypted)
 *
 * Signaling protocol (per-topic WebSocket, JSON):
 *
 *   → { type: "signal", target, data }   (encrypted SDP offer/answer/ICE)
 *   → { type: "relay",  target, data }   (encrypted binary — fallback)
 *   ← { type: "peers",     peerIds }     (current peers on connect)
 *   ← { type: "peer-join", peerId }
 *   ← { type: "peer-left", peerId }
 *   ← { type: "signal",    from, data }
 *   ← { type: "relay",     from, data }
 */

import type { NetworkDriver, NetworkTopic, NetworkPeer } from "../driver";

// =============================================================================
// Config
// =============================================================================

const STUN_ONLY_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

/** How long before we re-fetch TURN credentials (refresh well before 24h TTL). */
const TURN_CREDENTIAL_REFRESH_MS = 12 * 60 * 60 * 1000; // 12h

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

let nextChunkMsgId = 0;

function chunkMessage(data: Uint8Array): Uint8Array[] {
  if (data.byteLength <= MAX_CHUNK_PAYLOAD) {
    // Fits in a single frame — prepend flag byte
    const frame = new Uint8Array(1 + data.byteLength);
    frame[0] = FLAG_SINGLE;
    frame.set(data, 1);
    return [frame];
  }

  const msgId = (nextChunkMsgId++) & 0xFFFFFFFF;
  const totalChunks = Math.ceil(data.byteLength / MAX_CHUNK_PAYLOAD);
  const chunks: Uint8Array[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const start = i * MAX_CHUNK_PAYLOAD;
    const end = Math.min(start + MAX_CHUNK_PAYLOAD, data.byteLength);
    const payload = data.subarray(start, end);

    const frame = new Uint8Array(CHUNK_HEADER_SIZE + payload.byteLength);
    const view = new DataView(frame.buffer);
    frame[0] = FLAG_CHUNKED;
    view.setUint32(1, msgId);
    view.setUint16(5, i);
    view.setUint16(7, totalChunks);
    frame.set(payload, CHUNK_HEADER_SIZE);
    chunks.push(frame);
  }

  return chunks;
}

/** Reassembly buffer for incoming chunked messages from a single peer. */
class ChunkAssembler {
  private pending = new Map<number, { chunks: (Uint8Array | null)[]; received: number; totalSize: number }>();

  /**
   * Process an incoming frame. Returns the complete message once all chunks
   * arrive, or null if still waiting for more chunks.
   */
  process(frame: Uint8Array): Uint8Array | null {
    if (frame[0] === FLAG_SINGLE) {
      return frame.subarray(1);
    }

    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const msgId = view.getUint32(1);
    const chunkIndex = view.getUint16(5);
    const totalChunks = view.getUint16(7);
    const payload = frame.subarray(CHUNK_HEADER_SIZE);

    let entry = this.pending.get(msgId);
    if (!entry) {
      entry = { chunks: new Array(totalChunks).fill(null), received: 0, totalSize: 0 };
      this.pending.set(msgId, entry);
    }

    if (entry.chunks[chunkIndex] === null) {
      entry.chunks[chunkIndex] = payload;
      entry.received++;
      entry.totalSize += payload.byteLength;
    }

    if (entry.received < totalChunks) return null;

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

    if (dc.readyState === "open") {
      this.resolveDcReady();
      onOpen?.();
    } else {
      dc.onopen = () => {
        this.resolveDcReady();
        onOpen?.();
      };
    }
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
    const chunks = chunkMessage(data);
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
  private relaySend: (target: string, data: string) => void;
  private messageListeners = new Set<(data: Uint8Array) => void>();
  private closeListeners = new Set<() => void>();
  private closed = false;
  private assembler = new ChunkAssembler();

  constructor(
    remotePublicKey: string,
    relaySend: (target: string, data: string) => void,
  ) {
    this.remotePublicKey = remotePublicKey;
    this.relaySend = relaySend;
  }

  send(data: Uint8Array): void {
    if (this.closed) return;
    const chunks = chunkMessage(data);
    for (const chunk of chunks) {
      this.relaySend(this.remotePublicKey, uint8ToBase64(chunk));
    }
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

class WebRtcTopic implements NetworkTopic {
  private localPeerId: string;
  private topicHex: string;
  private signalUrl: string;
  private encKey: CryptoKey | null;
  private rtcConfig: RTCConfiguration;
  private ws: WebSocket | null = null;
  private wsReady: Promise<void> = Promise.resolve();
  private resolveWsReady!: () => void;
  private destroyed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private peers = new Map<string, WebRtcPeer | RelayPeer>();
  private joinListeners = new Set<(peer: NetworkPeer) => void>();
  private leaveListeners = new Set<(publicKey: string) => void>();

  constructor(
    localPeerId: string,
    topicHex: string,
    signalUrl: string,
    encKey: CryptoKey | null,
    rtcConfig: RTCConfiguration,
  ) {
    this.localPeerId = localPeerId;
    this.topicHex = topicHex;
    this.signalUrl = signalUrl;
    this.encKey = encKey;
    this.rtcConfig = rtcConfig;
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

    this.wsReady = new Promise((r) => { this.resolveWsReady = r; });

    const url = `${this.signalUrl}/topic/${this.topicHex}?peerId=${this.localPeerId}`;
    this.ws = new WebSocket(url);

    const topicShort = this.topicHex.slice(0, 8);

    this.ws.onopen = () => {
      console.log(`[WS] connected topic=${topicShort} peer=${this.localPeerId.slice(0, 8)}`);
      this.reconnectAttempt = 0;
      this.resolveWsReady();
    };

    this.ws.onmessage = (e) => {
      this.handleWsMessage(e.data);
    };

    this.ws.onclose = (ev) => {
      console.log(`[WS] closed topic=${topicShort} code=${ev.code} clean=${ev.wasClean} reason=${ev.reason || "(none)"}`);
      if (!ev.wasClean) {
        console.error(`[WS] unexpected close topic=${topicShort} code=${ev.code} reason=${ev.reason || "(none)"}`);
      }
      // Tear down peer connections but keep listeners so reconnected peers
      // re-trigger handlePeerJoin in the Replicator.
      this._reset();

      if (this.destroyed) return;

      // Reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s)
      const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30000);
      this.reconnectAttempt++;
      this.ws = null;
      console.log(`[WS] reconnecting topic=${topicShort} attempt=${this.reconnectAttempt} delay=${delay}ms`);

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.ensureWs().catch(() => { /* will retry on next onclose */ });
      }, delay);
    };

    this.ws.onerror = () => {
      console.error(`[WS] connection error topic=${topicShort} url=${url}`);
      // onerror is always followed by onclose, which handles reconnection
    };

    return this.wsReady;
  }

  private wsSend(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.error(`[WS] send dropped — socket not open (state=${this.ws?.readyState ?? "null"}) topic=${this.topicHex.slice(0, 8)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Encrypted signal/relay sending
  // ---------------------------------------------------------------------------

  private async sendSignal(target: string, data: unknown): Promise<void> {
    const payload = JSON.stringify(data);
    const encrypted = this.encKey ? await encrypt(this.encKey, payload) : payload;
    this.wsSend({ type: "signal", target, data: encrypted });
  }

  private async sendRelay(target: string, data: string): Promise<void> {
    const encrypted = this.encKey ? await encrypt(this.encKey, data) : data;
    this.wsSend({ type: "relay", target, data: encrypted });
  }

  // ---------------------------------------------------------------------------
  // Incoming WebSocket messages
  // ---------------------------------------------------------------------------

  private async handleWsMessage(raw: any) {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch { return; }

    const topicShort = this.topicHex.slice(0, 8);

    switch (msg.type) {
      case "peers":
        console.log(`[WS] peers topic=${topicShort} count=${msg.peerIds.length} ids=[${msg.peerIds.map((id: string) => id.slice(0, 8)).join(", ")}]`);
        for (const peerId of msg.peerIds) {
          this._handlePeerJoin(peerId);
        }
        break;
      case "peer-join":
        console.log(`[WS] peer-join topic=${topicShort} peer=${msg.peerId.slice(0, 8)}`);
        this._handlePeerJoin(msg.peerId);
        break;
      case "peer-left":
        console.log(`[WS] peer-left topic=${topicShort} peer=${msg.peerId.slice(0, 8)}`);
        this._handlePeerLeft(msg.peerId);
        break;
      case "signal": {
        const decrypted = this.encKey
          ? await decrypt(this.encKey, msg.data)
          : msg.data;
        if (decrypted === null) {
          console.error(`[WebRTC] signal decryption failed from=${msg.from?.slice(0, 8)}`);
          return;
        }
        const data = typeof decrypted === "string" ? JSON.parse(decrypted) : decrypted;
        this._handleSignal(msg.from, data);
        break;
      }
      case "relay": {
        const decrypted = this.encKey
          ? await decrypt(this.encKey, msg.data)
          : msg.data;
        if (decrypted === null) {
          console.error(`[WebRTC] relay decryption failed from=${msg.from?.slice(0, 8)}`);
          return;
        }
        const bytes = base64ToUint8(decrypted);
        this._handleRelayMessage(msg.from, bytes);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Peer connection management (same logic as before)
  // ---------------------------------------------------------------------------

  async _handlePeerJoin(remotePeerId: string) {
    if (this.peers.has(remotePeerId)) return;

    const rShort = remotePeerId.slice(0, 8);
    const topicShort = this.topicHex.slice(0, 8);

    const pc = new RTCPeerConnection(this.rtcConfig);
    const peer = new WebRtcPeer(remotePeerId, pc);
    this.peers.set(remotePeerId, peer);

    // Deterministic: higher ID creates the offer (prevents duplicate connections)
    const isInitiator = this.localPeerId > remotePeerId;
    console.log(`[WebRTC] new peer remote=${rShort} topic=${topicShort} role=${isInitiator ? "initiator" : "responder"}`);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal(remotePeerId, { type: "ice", candidate: e.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] connectionState=${pc.connectionState} remote=${rShort}`);
      if (pc.connectionState === "failed") {
        console.error(`[WebRTC] connection failed remote=${rShort}`);
        this._promoteToRelay(remotePeerId);
      } else if (pc.connectionState === "closed") {
        this._removePeer(remotePeerId);
      }
    };

    // Firefox fires iceConnectionState "failed" more reliably than connectionState
    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] iceConnectionState=${pc.iceConnectionState} remote=${rShort}`);
      if (pc.iceConnectionState === "failed") {
        console.error(`[WebRTC] ICE failed remote=${rShort}`);
        this._promoteToRelay(remotePeerId);
      } else if (pc.iceConnectionState === "disconnected") {
        console.warn(`[WebRTC] ICE disconnected remote=${rShort}`);
      }
    };

    if (isInitiator) {
      const dc = pc.createDataChannel("data", { ordered: true });
      peer._setDataChannel(dc, () => {
        console.log(`[WebRTC] datachannel opened remote=${rShort}`);
        for (const cb of this.joinListeners) cb(peer);
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log(`[WebRTC] sent offer remote=${rShort}`);
      this.sendSignal(remotePeerId, { type: "offer", sdp: offer });
    } else {
      pc.ondatachannel = (e) => {
        peer._setDataChannel(e.channel, () => {
          console.log(`[WebRTC] datachannel opened remote=${rShort}`);
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
      // Exception: if ICE has gone to "disconnected" or "failed", the existing
      // connection is stale and the offer is a legitimate reconnect — tear down
      // the old peer and accept the new connection.
      if (peer instanceof WebRtcPeer && peer.pc.connectionState === "connected") {
        const iceHealthy =
          peer.pc.iceConnectionState === "connected" ||
          peer.pc.iceConnectionState === "completed";
        if (iceHealthy) {
          console.warn(`[WebRTC] ignoring renegotiation offer from ${fShort} (already connected)`);
          return;
        }
        console.log(`[WebRTC] stale connection to ${fShort} (ice=${peer.pc.iceConnectionState}) — accepting reconnect offer`);
        this._removePeer(from);
        peer = undefined;
      }

      if (!peer) {
        const pc = new RTCPeerConnection(this.rtcConfig);
        peer = new WebRtcPeer(from, pc);
        this.peers.set(from, peer);

        pc.onicecandidate = (e) => {
          if (e.candidate) {
            this.sendSignal(from, { type: "ice", candidate: e.candidate });
          }
        };

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "failed") {
            this._promoteToRelay(from);
          } else if (pc.connectionState === "closed") {
            this._removePeer(from);
          }
        };

        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === "failed") {
            this._promoteToRelay(from);
          }
        };

        pc.ondatachannel = (e) => {
          (peer as WebRtcPeer)._setDataChannel(e.channel, () => {
            for (const cb of this.joinListeners) cb(peer!);
          });
        };
      }

      await (peer as WebRtcPeer).pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await (peer as WebRtcPeer).pc.createAnswer();
      await (peer as WebRtcPeer).pc.setLocalDescription(answer);
      this.sendSignal(from, { type: "answer", sdp: answer });
    } else if (data.type === "answer") {
      if (!peer) return;
      await (peer as WebRtcPeer).pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === "ice") {
      if (!peer) return;
      await (peer as WebRtcPeer).pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  }

  _handlePeerLeft(remotePeerId: string) {
    this._removePeer(remotePeerId);
  }

  /** ICE failed — swap to relay transport, transparent to the Replicator */
  private _promoteToRelay(remotePeerId: string) {
    const existing = this.peers.get(remotePeerId);
    // Already relayed or already removed
    if (!existing || existing instanceof RelayPeer) return;

    // Remove from map BEFORE closing to prevent the "closed" connectionState
    // handler from firing _removePeer (which would emit leave events)
    this.peers.delete(remotePeerId);
    existing.close();

    // Create a relay peer that sends through the CF WebSocket (encrypted)
    const relayPeer = new RelayPeer(remotePeerId, (target, data) => {
      this.sendRelay(target, data);
    });
    this.peers.set(remotePeerId, relayPeer);

    console.log(`[WebRTC] ICE failed for ${remotePeerId.slice(0, 8)}… — falling back to relay`);

    // Fire join listeners so the Replicator sees a new (relay) peer
    for (const cb of this.joinListeners) cb(relayPeer);
  }

  /** Route an incoming relay message to the right RelayPeer */
  _handleRelayMessage(from: string, data: Uint8Array) {
    let peer = this.peers.get(from);

    // The remote side detected ICE failure before us and started relaying —
    // promote our side too so the message isn't dropped
    if (peer && !(peer instanceof RelayPeer)) {
      this._promoteToRelay(from);
      peer = this.peers.get(from);
    }

    if (peer instanceof RelayPeer) {
      peer._receiveRelay(data);
    }
  }

  private _removePeer(remotePeerId: string) {
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

  /**
   * Tear down peer connections but keep listeners intact.
   * Used on WebSocket reconnect — peers will re-establish, listeners must survive.
   */
  _reset() {
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();
    this.joinListeners.clear();
    this.leaveListeners.clear();
    this.ws?.close();
    this.ws = null;
  }
}

// =============================================================================
// Driver — manages topics, each with its own WebSocket to CF
// =============================================================================

class WebRtcNetworkDriver implements NetworkDriver {
  private signalUrl: string;
  private localPeerId: string = "";
  private topics = new Map<string, WebRtcTopic>();
  private topicKeys = new Map<string, Uint8Array>();
  private rtcConfig: RTCConfiguration = STUN_ONLY_CONFIG;
  private credentialsFetchedAt = 0;
  private credentialsFetching: Promise<void> | null = null;

  constructor(signalUrl: string) {
    this.signalUrl = signalUrl;
  }

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
   * Fetch short-lived TURN credentials from the Worker and cache them.
   * Falls back to STUN-only if the endpoint is unavailable (e.g. not yet configured).
   * Credentials are refreshed after TURN_CREDENTIAL_REFRESH_MS (12h).
   */
  private async ensureTurnCredentials(): Promise<void> {
    const now = Date.now();
    if (now - this.credentialsFetchedAt < TURN_CREDENTIAL_REFRESH_MS) return;
    if (this.credentialsFetching) return this.credentialsFetching;

    this.credentialsFetching = (async () => {
      try {
        const httpUrl = this.signalUrl.replace(/^wss?:\/\//, (m) => m === "wss://" ? "https://" : "http://");
        const res = await fetch(`${httpUrl}/turn-credentials`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { iceServers } = await res.json() as { iceServers: RTCIceServer };
        this.rtcConfig = {
          iceServers: [
            { urls: "stun:stun.cloudflare.com:3478" },
            iceServers,
          ],
        };
        this.credentialsFetchedAt = Date.now();
        console.log("[WebRTC] TURN credentials fetched");
      } catch (e) {
        console.warn("[WebRTC] TURN credentials unavailable, using STUN only:", e);
        this.rtcConfig = STUN_ONLY_CONFIG;
      } finally {
        this.credentialsFetching = null;
      }
    })();

    return this.credentialsFetching;
  }

  async join(topic: Uint8Array): Promise<NetworkTopic> {
    const hex = Array.from(topic).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (this.topics.has(hex)) return this.topics.get(hex)!;

    if (!this.localPeerId) {
      throw new Error("NetworkDriver: setLocalId() must be called before join()");
    }

    await this.ensureTurnCredentials();

    // Derive AES-GCM key from the raw topic key (if registered)
    const rawKey = this.topicKeys.get(hex);
    const encKey = rawKey ? await deriveAesKey(rawKey, `cypher-signal:${hex}`) : null;

    const nt = new WebRtcTopic(this.localPeerId, hex, this.signalUrl, encKey, this.rtcConfig);
    this.topics.set(hex, nt);

    await nt.connect();
    return nt;
  }

  async destroy(): Promise<void> {
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
