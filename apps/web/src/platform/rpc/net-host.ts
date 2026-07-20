/**
 * Transport host (Phase 3), tab side.
 *
 * {@link serveNetwork} drives a real {@link NetworkDriver} (WebRTC) from the
 * commands the worker's {@link NetworkProxy} sends, and streams peer events
 * back. {@link startNetworkHostElection} makes a tab contend for the
 * `tasfer-net` Web Lock; the single winner becomes the device's transport host,
 * runs the WebRTC driver, and hands a `MessagePort` to the worker. When that tab
 * closes the lock frees and another tab takes over — invisible to editing.
 */

import type { NetworkDriver, NetworkPeer, NetworkTopic } from "../driver";
import type { NetCommand, NetEvent } from "./net-protocol";

interface HostTopic {
  topic: NetworkTopic;
  peers: Map<string, NetworkPeer>;
  unsubs: Array<() => void>;
}

/** Wire a real NetworkDriver to a port speaking the network RPC protocol. */
export function serveNetwork(driver: NetworkDriver, port: MessagePort): void {
  const topics = new Map<number, HostTopic>();

  const emit = (ev: NetEvent) => port.postMessage(ev);

  const registerPeer = (topicId: number, ht: HostTopic, peer: NetworkPeer) => {
    if (ht.peers.has(peer.remotePublicKey)) return;
    ht.peers.set(peer.remotePublicKey, peer);
    const peerId = peer.remotePublicKey;
    emit({ t: "peerJoin", topicId, peerId });
    ht.unsubs.push(
      peer.onMessage((data) => emit({ t: "peerMsg", topicId, peerId, data })),
    );
    ht.unsubs.push(
      peer.onClose(() => {
        ht.peers.delete(peerId);
        emit({ t: "peerClose", topicId, peerId });
      }),
    );
  };

  port.onmessage = async (e: MessageEvent) => {
    const cmd = e.data as NetCommand;
    switch (cmd.t) {
      case "setLocalId":
        driver.setLocalId(cmd.id);
        break;
      case "registerKey":
        driver.registerTopicKey(cmd.topicHex, cmd.key);
        break;
      case "unregisterKey":
        driver.unregisterTopicKey(cmd.topicHex);
        break;
      case "join": {
        const topic = await driver.join(cmd.topic);
        const ht: HostTopic = { topic, peers: new Map(), unsubs: [] };
        topics.set(cmd.topicId, ht);
        ht.unsubs.push(
          topic.onPeerJoin((peer) => registerPeer(cmd.topicId, ht, peer)),
        );
        ht.unsubs.push(
          topic.onPeerLeave((peerId) => {
            ht.peers.delete(peerId);
            emit({ t: "peerLeave", topicId: cmd.topicId, peerId });
          }),
        );
        // Surface peers that connected before our listeners attached.
        for (const peer of topic.getPeers()) registerPeer(cmd.topicId, ht, peer);
        break;
      }
      case "topicDestroy": {
        const ht = topics.get(cmd.topicId);
        if (ht) {
          for (const u of ht.unsubs) u();
          void ht.topic.destroy();
          topics.delete(cmd.topicId);
        }
        break;
      }
      case "peerSend":
        topics.get(cmd.topicId)?.peers.get(cmd.peerId)?.send(cmd.data);
        break;
      case "peerClose":
        topics.get(cmd.topicId)?.peers.get(cmd.peerId)?.close();
        break;
      case "destroy":
        for (const ht of topics.values()) {
          for (const u of ht.unsubs) u();
        }
        topics.clear();
        void driver.destroy();
        break;
    }
  };
  port.start();
}

/**
 * Contend for the `tasfer-net` lock; the winner hosts the device's single
 * WebRTC connection on the worker's behalf for as long as this tab lives.
 */
export function startNetworkHostElection(
  workerPort: MessagePort,
  signalUrl: string,
): void {
  if (typeof navigator === "undefined" || !navigator.locks) return;

  void navigator.locks.request("tasfer-net", async () => {
    const { createWebRtcNetworkDriver } = await import("../adapters/webrtc");
    const driver = createWebRtcNetworkDriver(signalUrl);

    const channel = new MessageChannel();
    serveNetwork(driver, channel.port1);
    // Hand the other end to the worker; it drives our WebRTC driver.
    workerPort.postMessage({ t: "netHost" }, [channel.port2]);

    // Hold the lock — and stay the host — until this tab goes away.
    await new Promise<void>((resolve) => {
      addEventListener("pagehide", () => {
        void driver.destroy();
        resolve();
      });
    });
  });
}
