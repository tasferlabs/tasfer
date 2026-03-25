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

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

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

  constructor(remotePublicKey: string, pc: RTCPeerConnection) {
    this.remotePublicKey = remotePublicKey;
    this.pc = pc;
    this.dcReady = new Promise((r) => { this.resolveDcReady = r; });
  }

  /** Called by the topic when a data channel is established */
  _setDataChannel(dc: RTCDataChannel) {
    this.dc = dc;
    dc.binaryType = "arraybuffer";

    dc.onmessage = (e) => {
      const data = new Uint8Array(e.data as ArrayBuffer);
      for (const cb of this.messageListeners) cb(data);
    };

    dc.onclose = () => this._fireClose();

    if (dc.readyState === "open") {
      this.resolveDcReady();
    } else {
      dc.onopen = () => this.resolveDcReady();
    }
  }

  _fireClose() {
    for (const cb of this.closeListeners) cb();
    this.messageListeners.clear();
    this.closeListeners.clear();
  }

  send(data: Uint8Array): void {
    if (this.dc?.readyState === "open") {
      this.dc.send(data as ArrayBufferView<ArrayBuffer>);
    } else {
      this.dcReady.then(() => {
        if (this.dc?.readyState === "open") this.dc.send(data as ArrayBufferView<ArrayBuffer>);
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

  constructor(
    remotePublicKey: string,
    relaySend: (target: string, data: string) => void,
  ) {
    this.remotePublicKey = remotePublicKey;
    this.relaySend = relaySend;
  }

  send(data: Uint8Array): void {
    if (this.closed) return;
    // Encode binary as base64 for JSON transport
    this.relaySend(this.remotePublicKey, uint8ToBase64(data));
  }

  /** Called by the topic when a relay message arrives for this peer */
  _receiveRelay(data: Uint8Array): void {
    for (const cb of this.messageListeners) cb(data);
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
  ) {
    this.localPeerId = localPeerId;
    this.topicHex = topicHex;
    this.signalUrl = signalUrl;
    this.encKey = encKey;
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

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.resolveWsReady();
    };

    this.ws.onmessage = (e) => {
      this.handleWsMessage(e.data);
    };

    this.ws.onclose = () => {
      // Tear down peer connections but keep listeners so reconnected peers
      // re-trigger handlePeerJoin in the Replicator.
      this._reset();

      if (this.destroyed) return;

      // Reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s)
      const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30000);
      this.reconnectAttempt++;
      this.ws = null;

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.ensureWs().catch(() => { /* will retry on next onclose */ });
      }, delay);
    };

    this.ws.onerror = () => {
      // onerror is always followed by onclose, which handles reconnection
    };

    return this.wsReady;
  }

  private wsSend(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
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

    switch (msg.type) {
      case "peers":
        for (const peerId of msg.peerIds) {
          this._handlePeerJoin(peerId);
        }
        break;
      case "peer-join":
        this._handlePeerJoin(msg.peerId);
        break;
      case "peer-left":
        this._handlePeerLeft(msg.peerId);
        break;
      case "signal": {
        const decrypted = this.encKey
          ? await decrypt(this.encKey, msg.data)
          : msg.data;
        if (decrypted === null) return; // Decryption failed
        const data = typeof decrypted === "string" ? JSON.parse(decrypted) : decrypted;
        this._handleSignal(msg.from, data);
        break;
      }
      case "relay": {
        const decrypted = this.encKey
          ? await decrypt(this.encKey, msg.data)
          : msg.data;
        if (decrypted === null) return;
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

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peer = new WebRtcPeer(remotePeerId, pc);
    this.peers.set(remotePeerId, peer);

    // Deterministic: higher ID creates the offer (prevents duplicate connections)
    const isInitiator = this.localPeerId > remotePeerId;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal(remotePeerId, { type: "ice", candidate: e.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        this._promoteToRelay(remotePeerId);
      } else if (pc.connectionState === "closed") {
        this._removePeer(remotePeerId);
      }
    };

    // Firefox fires iceConnectionState "failed" more reliably than connectionState
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") {
        this._promoteToRelay(remotePeerId);
      }
    };

    if (isInitiator) {
      const dc = pc.createDataChannel("data", { ordered: true });
      peer._setDataChannel(dc);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendSignal(remotePeerId, { type: "offer", sdp: offer });

      for (const cb of this.joinListeners) cb(peer);
    } else {
      pc.ondatachannel = (e) => {
        peer._setDataChannel(e.channel);
        for (const cb of this.joinListeners) cb(peer);
      };
    }
  }

  /** Called when we receive signaling data from a remote peer */
  async _handleSignal(from: string, data: any) {
    let peer = this.peers.get(from);

    // Ignore signaling for peers that already fell back to relay
    if (peer instanceof RelayPeer) return;

    if (data.type === "offer") {
      if (!peer) {
        const pc = new RTCPeerConnection(RTC_CONFIG);
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
          (peer as WebRtcPeer)._setDataChannel(e.channel);
          for (const cb of this.joinListeners) cb(peer!);
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

  async join(topic: Uint8Array): Promise<NetworkTopic> {
    const hex = Array.from(topic).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (this.topics.has(hex)) return this.topics.get(hex)!;

    if (!this.localPeerId) {
      throw new Error("NetworkDriver: setLocalId() must be called before join()");
    }

    // Derive AES-GCM key from the raw topic key (if registered)
    const rawKey = this.topicKeys.get(hex);
    const encKey = rawKey ? await deriveAesKey(rawKey, `cypher-signal:${hex}`) : null;

    const nt = new WebRtcTopic(this.localPeerId, hex, this.signalUrl, encKey);
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
