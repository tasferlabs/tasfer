/**
 * Asset pulls resolve "nobody has this" from an explicit `asset-miss` reply
 * rather than from silence plus a timeout. Silence and an offline peer are
 * indistinguishable, so without the reply every missing hash costs the full
 * backstop — paid once per image by flows that resolve assets in bulk, like an
 * export. These drive the Replicator through a fake NetworkDriver, so no
 * WebRTC/WebSocket is exercised.
 */

import { describe, expect, it, vi } from "vitest";
import type { NetworkDriver, NetworkPeer, NetworkTopic } from "./driver";
import { PROTOCOL_VERSION, Replicator, type ReplicatorHost } from "./sync";
import type { Peer } from "./types";
import { WIRE_VERSION } from "./wire-codec";

const LOCAL_PUBLIC_KEY = "a".repeat(64);
const PEER_A = "b".repeat(64);
const PEER_B = "c".repeat(64);
const SPACE_ID = "space";
const HASH = "d".repeat(64);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakePeer implements NetworkPeer {
  readonly remotePublicKey: string;
  readonly sent: Array<Record<string, unknown>> = [];
  private messageHandler: ((data: Uint8Array) => void) | undefined;
  private closeHandler: (() => void) | undefined;

  constructor(remotePublicKey: string) {
    this.remotePublicKey = remotePublicKey;
  }

  send(data: Uint8Array): void {
    this.sent.push(JSON.parse(decoder.decode(data)) as Record<string, unknown>);
  }

  onMessage(cb: (data: Uint8Array) => void): () => void {
    this.messageHandler = cb;
    return () => {
      if (this.messageHandler === cb) this.messageHandler = undefined;
    };
  }

  onClose(cb: () => void): () => void {
    this.closeHandler = cb;
    return () => {
      if (this.closeHandler === cb) this.closeHandler = undefined;
    };
  }

  close(): void {
    this.closeHandler?.();
  }

  receive(message: Record<string, unknown>): void {
    this.messageHandler?.(encoder.encode(JSON.stringify(message)));
  }

  sentOfType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((message) => message.type === type);
  }
}

/** Let the per-peer message queue and any pending microtasks drain. */
async function flushPeerQueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function setup(publicKeys: string[] = [PEER_A]) {
  const peers = publicKeys.map((key) => new FakePeer(key));
  const topic: NetworkTopic = {
    onPeerJoin: () => () => {},
    onPeerLeave: () => () => {},
    getPeers: () => peers,
    destroy: vi.fn(async () => {}),
  };
  const network = {
    setLocalId: vi.fn(),
    registerTopicKey: vi.fn(),
    unregisterTopicKey: vi.fn(),
    join: vi.fn(async () => topic),
    destroy: vi.fn(async () => {}),
  } as unknown as NetworkDriver;

  const getAssetData = vi.fn(
    async (_hash: string): Promise<{ ext: string; data: Uint8Array } | null> =>
      null,
  );
  const host = {
    getIdentity: vi.fn(async () => ({ publicKey: LOCAL_PUBLIC_KEY })),
    getPeerRecords: vi.fn(async () =>
      publicKeys.map((key) => ({ publicKey: key, trusted: true }) as Peer),
    ),
    getPeerSharedKey: vi.fn(async () => "e".repeat(64)),
    getSpaceIds: vi.fn(async () => [SPACE_ID]),
    getOwnDeviceKeys: vi.fn(async () => [] as string[]),
    getSpaceState: vi.fn(async () => "active" as const),
    getSpaceMembers: vi.fn(async () =>
      publicKeys.map((key) => ({ publicKey: key })),
    ),
    getOwnSpaceStates: vi.fn(async () => []),
    applyOwnSpaceStates: vi.fn(async () => {}),
    getSpaceVV: vi.fn(async () => ({})),
    getPageVVs: vi.fn(async () => ({})),
    updatePeerLastSeen: vi.fn(async () => {}),
    applyRemoteSpaceOps: vi.fn(async () => {}),
    applyRemotePageOps: vi.fn(async () => {}),
    getAssetData,
    storeAssetData: vi.fn(async () => {}),
  } as unknown as ReplicatorHost & { getSpaceVV: ReturnType<typeof vi.fn> };

  const replicator = new Replicator(network, host);
  await replicator.start();

  // A pull only reaches a peer that has completed a compatible handshake.
  for (const peer of peers) {
    peer.receive({
      type: "hello",
      publicKey: peer.remotePublicKey,
      protocolVersion: PROTOCOL_VERSION,
      wireVersion: WIRE_VERSION,
    });
  }
  await vi.waitFor(() =>
    expect(host.getSpaceVV).toHaveBeenCalledTimes(peers.length),
  );

  return { replicator, peers, host, getAssetData };
}

describe("Replicator asset-miss", () => {
  it("answers a request it cannot serve instead of going quiet", async () => {
    const { peers, getAssetData } = await setup();

    peers[0].receive({ type: "asset-req", hash: HASH });
    await flushPeerQueue();

    expect(getAssetData).toHaveBeenCalledWith(HASH);
    expect(peers[0].sentOfType("asset-miss")).toEqual([
      { type: "asset-miss", hash: HASH },
    ]);
  });

  it("settles a pull once every peer has answered, without the backstop", async () => {
    const { replicator, peers } = await setup([PEER_A, PEER_B]);

    let settled: boolean | undefined;
    const pull = replicator.requestAsset(HASH).then((found) => {
      settled = found;
    });
    await flushPeerQueue();

    for (const peer of peers) {
      expect(peer.sentOfType("asset-req")).toEqual([
        { type: "asset-req", hash: HASH },
      ]);
    }

    // One peer answering is not an answer for the other: the second may still
    // be about to send the bytes.
    peers[0].receive({ type: "asset-miss", hash: HASH });
    await flushPeerQueue();
    expect(settled).toBeUndefined();

    peers[1].receive({ type: "asset-miss", hash: HASH });
    await pull;
    expect(settled).toBe(false);
  });

  it("falls back to the backstop for a peer that never answers", async () => {
    vi.useFakeTimers();
    try {
      const { replicator, peers } = await setup();

      let settled: boolean | undefined;
      const pull = replicator.requestAsset(HASH).then((found) => {
        settled = found;
      });

      await Promise.resolve();
      expect(peers[0].sentOfType("asset-req")).toHaveLength(1);
      expect(settled).toBeUndefined();

      // A peer predating asset-miss stays silent; only the timer settles it.
      await vi.advanceTimersByTimeAsync(10_000);
      await pull;
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a pull when the last peer that could answer disconnects", async () => {
    const { replicator, peers } = await setup();

    let settled: boolean | undefined;
    const pull = replicator.requestAsset(HASH).then((found) => {
      settled = found;
    });
    await flushPeerQueue();
    expect(settled).toBeUndefined();

    peers[0].close();
    await pull;
    expect(settled).toBe(false);
  });

  it("resolves immediately when no peer can be reached", async () => {
    const { replicator } = await setup([]);

    // No timer to advance — with nobody to ask, the answer is already known.
    await expect(replicator.requestAsset(HASH)).resolves.toBe(false);
  });
});
