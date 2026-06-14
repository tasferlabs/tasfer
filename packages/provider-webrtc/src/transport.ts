/**
 * A {@link Transport} over WebRTC.
 *
 * Reaches peers in a room through a signaling WebSocket (the `apps/live`
 * relay), then upgrades each pair to a direct DataChannel — document bytes
 * never touch the server once ICE completes, so the relay genuinely cannot read
 * the content. The signaling wire is exactly what `apps/live/signal-room.ts`
 * speaks:
 *
 *   → { type: "signal", target, data }          (we send: offer/answer/ice)
 *   ← { type: "peers",     peerIds }             (existing peers on connect)
 *   ← { type: "peer-join", peerId }
 *   ← { type: "peer-left", peerId }
 *   ← { type: "signal",    from, data }
 *
 * The room name is hashed to the hex topic the server routes on. A deterministic
 * initiator (higher peerId offers) prevents duplicate connections.
 *
 * Trimmed from apps/web's production adapter. Deliberately omitted here, each a
 * clean follow-up: E2E signaling encryption, ICE→relay fallback, TURN, and
 * WebSocket auto-reconnect.
 */

import type { Transport, TransportPeer } from "@cypherkit/provider-core";

import { ChunkAssembler, chunkMessage } from "./chunk";

export interface WebrtcTransportOptions {
  /** Logical room — replicas sharing a room (and signaling server) converge. */
  room: string;
  /** Signaling base URL, e.g. "wss://relay.example.com". No trailing slash. */
  signaling: string;
  /** This replica's stable id. Pass `doc.peerId`. */
  peerId: string;
  /** ICE servers. Defaults to a public STUN server. */
  iceServers?: RTCIceServer[];
}

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

class WebrtcPeer implements TransportPeer {
  readonly id: string;
  readonly pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private readonly messageListeners = new Set<(b: Uint8Array) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly assembler = new ChunkAssembler();
  private nextMsgId = 0;
  private opened = false;

  constructor(id: string, pc: RTCPeerConnection) {
    this.id = id;
    this.pc = pc;
    this.ready = new Promise((r) => (this.resolveReady = r));
  }

  /** Bind the data channel; `onOpen` fires once it is ready to carry bytes. */
  _setChannel(dc: RTCDataChannel, onOpen: () => void): void {
    this.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.onmessage = (e) => {
      const message = this.assembler.process(new Uint8Array(e.data as ArrayBuffer));
      if (message) for (const cb of this.messageListeners) cb(message);
    };
    dc.onclose = () => this._close();
    const open = () => {
      if (this.opened) return;
      this.opened = true;
      this.resolveReady();
      onOpen();
    };
    if (dc.readyState === "open") open();
    else dc.onopen = open;
  }

  send(bytes: Uint8Array): void {
    const frames = chunkMessage(bytes, this.nextMsgId++);
    const flush = () => {
      if (this.dc?.readyState === "open") {
        for (const frame of frames) this.dc.send(frame as ArrayBufferView<ArrayBuffer>);
      }
    };
    if (this.dc?.readyState === "open") flush();
    else void this.ready.then(flush);
  }

  onMessage(cb: (b: Uint8Array) => void): () => void {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  _close(): void {
    this.assembler.clear();
    for (const cb of this.closeListeners) cb();
    this.messageListeners.clear();
    this.closeListeners.clear();
  }

  close(): void {
    this.dc?.close();
    this.pc.close();
    this._close();
  }
}

interface SignalMessage {
  type: string;
  from?: string;
  peerId?: string;
  peerIds?: string[];
  target?: string;
  data?: { type: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
}

export class WebrtcTransport implements Transport {
  private readonly room: string;
  private readonly signaling: string;
  private readonly peerId: string;
  private readonly iceServers: RTCIceServer[];

  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private destroyed = false;
  private readonly peers = new Map<string, WebrtcPeer>();
  private readonly joinListeners = new Set<(p: TransportPeer) => void>();
  private readonly leaveListeners = new Set<(id: string) => void>();

  constructor(options: WebrtcTransportOptions) {
    this.room = options.room;
    this.signaling = options.signaling.replace(/\/$/, "");
    this.peerId = options.peerId;
    this.iceServers = options.iceServers ?? DEFAULT_ICE;
  }

  connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const topicHex = await sha256Hex(this.room);
      const url = `${this.signaling}/topic/${topicHex}?peerId=${this.peerId}`;
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error(`[provider-webrtc] signaling failed: ${url}`));
        ws.onmessage = (e) => void this.onSignal(e.data as string);
        ws.onclose = () => {
          // Direct P2P channels outlive the signaling socket, so connected
          // peers stay. (Reconnect to discover NEW peers is a follow-up.)
        };
      });
    })();
    return this.connecting;
  }

  private wsSend(msg: SignalMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private async onSignal(raw: string): Promise<void> {
    if (this.destroyed) return;
    let msg: SignalMessage;
    try {
      msg = JSON.parse(raw) as SignalMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "peers":
        for (const id of msg.peerIds ?? []) await this.handlePeerJoin(id);
        break;
      case "peer-join":
        if (msg.peerId) await this.handlePeerJoin(msg.peerId);
        break;
      case "peer-left":
        if (msg.peerId) this.removePeer(msg.peerId);
        break;
      case "signal":
        if (msg.from && msg.data) await this.handleSignal(msg.from, msg.data);
        break;
    }
  }

  /** Build a peer + its connection, wiring ICE and teardown. */
  private setupPeer(remoteId: string): WebrtcPeer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = new WebrtcPeer(remoteId, pc);
    this.peers.set(remoteId, peer);
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.wsSend({ type: "signal", target: remoteId, data: { type: "ice", candidate: e.candidate.toJSON() } });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.removePeer(remoteId);
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") this.removePeer(remoteId);
    };
    return peer;
  }

  private fireJoin(peer: WebrtcPeer): void {
    for (const cb of this.joinListeners) cb(peer);
  }

  private async handlePeerJoin(remoteId: string): Promise<void> {
    if (remoteId === this.peerId || this.peers.has(remoteId)) return;
    const peer = this.setupPeer(remoteId);
    // Deterministic initiator avoids both sides offering at once.
    if (this.peerId > remoteId) {
      const dc = peer.pc.createDataChannel("cypher", { ordered: true });
      peer._setChannel(dc, () => this.fireJoin(peer));
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      this.wsSend({ type: "signal", target: remoteId, data: { type: "offer", sdp: offer } });
    } else {
      peer.pc.ondatachannel = (e) => peer._setChannel(e.channel, () => this.fireJoin(peer));
    }
  }

  private async handleSignal(
    from: string,
    data: NonNullable<SignalMessage["data"]>,
  ): Promise<void> {
    let peer = this.peers.get(from);
    if (data.type === "offer") {
      if (!data.sdp) return;
      if (!peer) {
        peer = this.setupPeer(from);
        peer.pc.ondatachannel = (e) => peer!._setChannel(e.channel, () => this.fireJoin(peer!));
      }
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.wsSend({ type: "signal", target: from, data: { type: "answer", sdp: answer } });
    } else if (data.type === "answer" && peer && data.sdp) {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === "ice" && peer && data.candidate) {
      await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  }

  private removePeer(remoteId: string): void {
    const peer = this.peers.get(remoteId);
    if (!peer) return;
    this.peers.delete(remoteId);
    peer.close();
    for (const cb of this.leaveListeners) cb(remoteId);
  }

  onPeerJoin(cb: (p: TransportPeer) => void): () => void {
    this.joinListeners.add(cb);
    return () => this.joinListeners.delete(cb);
  }

  onPeerLeave(cb: (id: string) => void): () => void {
    this.leaveListeners.add(cb);
    return () => this.leaveListeners.delete(cb);
  }

  getPeers(): TransportPeer[] {
    return Array.from(this.peers.values());
  }

  destroy(): void {
    this.destroyed = true;
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.joinListeners.clear();
    this.leaveListeners.clear();
    this.ws?.close();
    this.ws = null;
  }
}
