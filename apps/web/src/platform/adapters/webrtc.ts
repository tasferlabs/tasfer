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
 *   ← { type: "peer-join", topic, peerId }
 *   ← { type: "peer-left", topic, peerId }
 *   ← { type: "signal",    topic, from, data }
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
// Topic — manages all peer connections for one discovery topic
// =============================================================================

class WebRtcTopic implements NetworkTopic {
  private localPeerId: string;
  private signal: (target: string, data: unknown) => void;
  private peers = new Map<string, WebRtcPeer>();
  private joinListeners = new Set<(peer: NetworkPeer) => void>();
  private leaveListeners = new Set<(publicKey: string) => void>();

  constructor(
    localPeerId: string,
    signal: (target: string, data: unknown) => void,
  ) {
    this.localPeerId = localPeerId;
    this.signal = signal;
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
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this._removePeer(remotePeerId);
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
          if (pc.connectionState === "failed" || pc.connectionState === "closed") {
            this._removePeer(from);
          }
        };

        pc.ondatachannel = (e) => {
          peer!._setDataChannel(e.channel);
          for (const cb of this.joinListeners) cb(peer!);
        };
      }

      await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.signal(from, { type: "answer", sdp: answer });
    } else if (data.type === "answer") {
      if (!peer) return;
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === "ice") {
      if (!peer) return;
      await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  }

  _handlePeerLeft(remotePeerId: string) {
    this._removePeer(remotePeerId);
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

  constructor(signalUrl: string) {
    this.signalUrl = signalUrl;
  }

  private ensureWs(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.ws?.readyState === WebSocket.CONNECTING) return this.wsReady;

    this.wsReady = new Promise((r) => { this.resolveWsReady = r; });

    this.ws = new WebSocket(this.signalUrl);
    this.ws.onopen = () => this.resolveWsReady();

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
      }
    };

    this.ws.onclose = () => {
      for (const topic of this.topics.values()) {
        topic.destroy();
      }
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
      const arr = new Uint8Array(16);
      crypto.getRandomValues(arr);
      this.localPeerId = Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    await this.ensureWs();

    const nt = new WebRtcTopic(this.localPeerId, (target, data) => {
      this.wsSend({ type: "signal", topic: hex, target, data });
    });
    this.topics.set(hex, nt);

    this.wsSend({ type: "join", topic: hex, peerId: this.localPeerId });
    return nt;
  }

  async destroy(): Promise<void> {
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
