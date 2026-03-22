/**
 * WebRTC Network Driver
 *
 * Shared across all platforms (Electron, Web, Capacitor).
 * WebRTC is available everywhere — Electron is Chromium, mobile WebViews
 * support DataChannels. One transport, one network, all peers can talk.
 *
 * Uses a lightweight WebSocket signaling relay for peer discovery.
 * After signaling, data flows directly peer-to-peer over DataChannels.
 *
 * Signaling protocol (WebSocket JSON messages):
 *
 *   → { type: "join",      topic, peerId }
 *   → { type: "leave",     topic }
 *   → { type: "signal",    topic, target, data }   (SDP offer/answer/ICE)
 *   → { type: "relay",     topic, target, data }   (base64 binary — fallback)
 *   ← { type: "peer-join", topic, peerId }
 *   ← { type: "peer-left", topic, peerId }
 *   ← { type: "signal",    topic, from, data }
 *   ← { type: "relay",     topic, from, data }
 *   ← { type: "peers",     topic, peerIds }        (current peers on join)
 */

import type { NetworkDriver, NetworkTopic, NetworkPeer } from "../driver";

// =============================================================================
// Config
// =============================================================================

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

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
// RelayPeer — fallback when ICE fails, routes data through signaling WebSocket
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
    let binary = "";
    for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
    this.relaySend(this.remotePublicKey, btoa(binary));
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
// Topic — manages all peer connections for one discovery topic
// =============================================================================

class WebRtcTopic implements NetworkTopic {
  private localPeerId: string;
  signal: (target: string, data: unknown) => void;
  relay: (target: string, data: string) => void;
  private peers = new Map<string, WebRtcPeer | RelayPeer>();
  private joinListeners = new Set<(peer: NetworkPeer) => void>();
  private leaveListeners = new Set<(publicKey: string) => void>();

  constructor(
    localPeerId: string,
    signal: (target: string, data: unknown) => void,
    relay: (target: string, data: string) => void,
  ) {
    this.localPeerId = localPeerId;
    this.signal = signal;
    this.relay = relay;
  }

  /** Called when the signaling server tells us a new peer joined */
  async _handlePeerJoin(remotePeerId: string) {
    if (this.peers.has(remotePeerId)) return;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peer = new WebRtcPeer(remotePeerId, pc);
    this.peers.set(remotePeerId, peer);

    // Deterministic: higher ID creates the offer (prevents duplicate connections)
    const isInitiator = this.localPeerId > remotePeerId;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.signal(remotePeerId, { type: "ice", candidate: e.candidate });
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
      this.signal(remotePeerId, { type: "offer", sdp: offer });

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
            this.signal(from, { type: "ice", candidate: e.candidate });
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
      this.signal(from, { type: "answer", sdp: answer });
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

    // Create a relay peer that sends through the signaling WebSocket
    const relayPeer = new RelayPeer(remotePeerId, (target, data) => {
      this.relay(target, data);
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

  /** Replace the signaling + relay functions after WebSocket reconnection */
  _resetSignal(
    signal: (target: string, data: unknown) => void,
    relay: (target: string, data: string) => void,
  ) {
    this.signal = signal;
    this.relay = relay;
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
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();
    this.joinListeners.clear();
    this.leaveListeners.clear();
  }
}

// =============================================================================
// Driver — connects to signaling relay, manages topics
// =============================================================================

class WebRtcNetworkDriver implements NetworkDriver {
  private signalUrl: string;
  private localPeerId: string = "";
  private ws: WebSocket | null = null;
  private topics = new Map<string, WebRtcTopic>();
  private wsReady: Promise<void> = Promise.resolve();
  private resolveWsReady!: () => void;
  private destroyed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(signalUrl: string) {
    this.signalUrl = signalUrl;
  }

  /**
   * Set the local peer ID used for signaling.
   * Should be the device's public key so remote peers can identify us.
   */
  setLocalId(id: string): void {
    this.localPeerId = id;
  }

  private ensureWs(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.ws?.readyState === WebSocket.CONNECTING) return this.wsReady;

    this.wsReady = new Promise((r) => { this.resolveWsReady = r; });

    this.ws = new WebSocket(this.signalUrl);
    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.resolveWsReady();
    };

    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const topic = this.topics.get(msg.topic);
      if (!topic) return;

      switch (msg.type) {
        case "peers":
          for (const peerId of msg.peerIds) {
            topic._handlePeerJoin(peerId);
          }
          break;
        case "peer-join":
          topic._handlePeerJoin(msg.peerId);
          break;
        case "peer-left":
          topic._handlePeerLeft(msg.peerId);
          break;
        case "signal":
          topic._handleSignal(msg.from, msg.data);
          break;
        case "relay": {
          const binary = atob(msg.data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          topic._handleRelayMessage(msg.from, bytes);
          break;
        }
      }
    };

    this.ws.onclose = () => {
      // Tear down peer connections but keep listeners so reconnected peers
      // can re-trigger handlePeerJoin in the Replicator.
      for (const topic of this.topics.values()) {
        topic._reset();
      }

      if (this.destroyed) return;

      // Reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s)
      const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30000);
      this.reconnectAttempt++;
      this.ws = null;

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.ensureWs().then(() => {
          // Re-join all topics so peers can rediscover each other
          for (const [hex, topic] of this.topics) {
            // Recreate signaling for existing topics
            topic._resetSignal(
              (target, data) => { this.wsSend({ type: "signal", topic: hex, target, data }); },
              (target, data) => { this.wsSend({ type: "relay", topic: hex, target, data }); },
            );
            this.wsSend({ type: "join", topic: hex, peerId: this.localPeerId });
          }
        }).catch(() => {
          // Will retry on next onclose
        });
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

  async join(topic: Uint8Array): Promise<NetworkTopic> {
    const hex = Array.from(topic).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (this.topics.has(hex)) return this.topics.get(hex)!;

    if (!this.localPeerId) {
      throw new Error("NetworkDriver: setLocalId() must be called before join()");
    }

    await this.ensureWs();

    const nt = new WebRtcTopic(
      this.localPeerId,
      (target, data) => { this.wsSend({ type: "signal", topic: hex, target, data }); },
      (target, data) => { this.wsSend({ type: "relay", topic: hex, target, data }); },
    );
    this.topics.set(hex, nt);

    this.wsSend({ type: "join", topic: hex, peerId: this.localPeerId });
    return nt;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [hex, topic] of this.topics) {
      this.wsSend({ type: "leave", topic: hex });
      await topic.destroy();
    }
    this.topics.clear();
    this.ws?.close();
    this.ws = null;
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createWebRtcNetworkDriver(signalUrl: string): NetworkDriver {
  return new WebRtcNetworkDriver(signalUrl);
}
