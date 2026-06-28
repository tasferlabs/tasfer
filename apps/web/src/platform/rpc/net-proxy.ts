/**
 * NetworkProxy (Phase 3) — a {@link NetworkDriver} that runs in the worker but
 * performs no WebRTC itself. It forwards every call to whichever tab currently
 * holds the `cypher-net` Web Lock (the transport host) and surfaces that tab's
 * peer events back to the worker's `Replicator`.
 *
 * The host can change at any time (the holding tab closes, another takes over).
 * The proxy keeps enough state — local id, topic keys, joined topics — to replay
 * the full driver setup onto a freshly-elected host, and it fires `onClose` for
 * every live peer across a handover so the Replicator re-discovers them on the
 * new connection. While no host is registered the network is simply offline;
 * calls are buffered as state and replayed once a host appears.
 */

import type { NetworkDriver, NetworkPeer, NetworkTopic } from "../driver";
import type { NetCommand, NetEvent } from "./net-protocol";

class PeerProxy implements NetworkPeer {
  readonly remotePublicKey: string;
  private readonly topic: TopicProxy;
  private readonly msgListeners = new Set<(d: Uint8Array) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(topic: TopicProxy, peerId: string) {
    this.topic = topic;
    this.remotePublicKey = peerId;
  }

  send(data: Uint8Array): void {
    this.topic.post({
      t: "peerSend",
      topicId: this.topic.id,
      peerId: this.remotePublicKey,
      data,
    });
  }

  onMessage(cb: (data: Uint8Array) => void): () => void {
    this.msgListeners.add(cb);
    return () => this.msgListeners.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  close(): void {
    this.topic.post({
      t: "peerClose",
      topicId: this.topic.id,
      peerId: this.remotePublicKey,
    });
  }

  _emitMessage(data: Uint8Array): void {
    for (const cb of this.msgListeners) cb(data);
  }

  _emitClose(): void {
    for (const cb of this.closeListeners) cb();
  }
}

class TopicProxy implements NetworkTopic {
  readonly peers = new Map<string, PeerProxy>();
  readonly id: number;
  readonly topicBytes: Uint8Array;
  private readonly proxy: NetworkProxy;
  private readonly joinListeners = new Set<(p: NetworkPeer) => void>();
  private readonly leaveListeners = new Set<(publicKey: string) => void>();

  constructor(proxy: NetworkProxy, id: number, topicBytes: Uint8Array) {
    this.proxy = proxy;
    this.id = id;
    this.topicBytes = topicBytes;
  }

  post(cmd: NetCommand): void {
    this.proxy._post(cmd);
  }

  onPeerJoin(cb: (peer: NetworkPeer) => void): () => void {
    this.joinListeners.add(cb);
    return () => this.joinListeners.delete(cb);
  }

  onPeerLeave(cb: (publicKey: string) => void): () => void {
    this.leaveListeners.add(cb);
    return () => this.leaveListeners.delete(cb);
  }

  getPeers(): NetworkPeer[] {
    return [...this.peers.values()];
  }

  async destroy(): Promise<void> {
    this.post({ t: "topicDestroy", topicId: this.id });
    this.proxy._removeTopic(this.id);
  }

  _peerJoin(peerId: string): void {
    if (this.peers.has(peerId)) return;
    const peer = new PeerProxy(this, peerId);
    this.peers.set(peerId, peer);
    for (const cb of this.joinListeners) cb(peer);
  }

  _peerLeave(peerId: string): void {
    this.peers.delete(peerId);
    for (const cb of this.leaveListeners) cb(peerId);
  }

  /** Drop all peers (host handover): fire close so the Replicator re-discovers. */
  _resetPeers(): void {
    for (const peer of this.peers.values()) peer._emitClose();
    this.peers.clear();
  }
}

export class NetworkProxy implements NetworkDriver {
  private port: MessagePort | null = null;
  private localId: string | null = null;
  private readonly keys = new Map<string, Uint8Array>();
  private readonly topics = new Map<number, TopicProxy>();
  private nextTopicId = 1;

  /** Install (or replace) the transport-host port and replay setup onto it. */
  setHost(port: MessagePort): void {
    this.port = port;
    port.onmessage = (e: MessageEvent) => this.onEvent(e.data as NetEvent);
    port.start();

    // Existing peers belong to the previous host — drop them so the Replicator
    // reconnects over the new one.
    for (const topic of this.topics.values()) topic._resetPeers();

    // Replay driver setup so the new host reaches the same peers.
    if (this.localId) port.postMessage({ t: "setLocalId", id: this.localId });
    for (const [topicHex, key] of this.keys) {
      port.postMessage({ t: "registerKey", topicHex, key });
    }
    for (const topic of this.topics.values()) {
      port.postMessage({ t: "join", topicId: topic.id, topic: topic.topicBytes });
    }
  }

  _post(cmd: NetCommand): void {
    this.port?.postMessage(cmd);
  }

  _removeTopic(id: number): void {
    this.topics.delete(id);
  }

  private onEvent(ev: NetEvent): void {
    const topic = this.topics.get(ev.topicId);
    if (!topic) return;
    switch (ev.t) {
      case "peerJoin":
        topic._peerJoin(ev.peerId);
        break;
      case "peerLeave":
        topic._peerLeave(ev.peerId);
        break;
      case "peerMsg":
        topic.peers.get(ev.peerId)?._emitMessage(ev.data);
        break;
      case "peerClose":
        topic.peers.get(ev.peerId)?._emitClose();
        topic.peers.delete(ev.peerId);
        break;
    }
  }

  // ---- NetworkDriver ----

  setLocalId(id: string): void {
    this.localId = id;
    this._post({ t: "setLocalId", id });
  }

  registerTopicKey(topicHex: string, key: Uint8Array): void {
    this.keys.set(topicHex, key);
    this._post({ t: "registerKey", topicHex, key });
  }

  unregisterTopicKey(topicHex: string): void {
    this.keys.delete(topicHex);
    this._post({ t: "unregisterKey", topicHex });
  }

  async join(topic: Uint8Array): Promise<NetworkTopic> {
    const id = this.nextTopicId++;
    const proxy = new TopicProxy(this, id, topic);
    this.topics.set(id, proxy);
    this._post({ t: "join", topicId: id, topic });
    return proxy;
  }

  async destroy(): Promise<void> {
    this._post({ t: "destroy" });
    for (const topic of this.topics.values()) topic._resetPeers();
    this.topics.clear();
    this.port = null;
  }
}
