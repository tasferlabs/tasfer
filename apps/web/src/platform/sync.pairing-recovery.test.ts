import { describe, expect, it, vi } from "vitest";
import type { NetworkDriver, NetworkPeer, NetworkTopic } from "./driver";
import {
  Replicator,
  type DeviceLinkPayload,
  type ReplicatorHost,
} from "./sync";
import type { Peer } from "./types";

/**
 * Pairing has to survive the network it runs on. A device link is the least
 * forgiving case: the accepting side is trusted the moment the proofs match,
 * but owns nothing until the enrolment payload lands — so a drop in that gap
 * must be recoverable, and a wait that can never end must say so.
 */

const LOCAL_PUBLIC_KEY = "a".repeat(64);
const REMOTE_PUBLIC_KEY = "b".repeat(64);
const SECRET = "c".repeat(64);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

class FakePeer implements NetworkPeer {
  readonly remotePublicKey = REMOTE_PUBLIC_KEY;
  readonly sent: Array<Record<string, unknown>> = [];
  private messageHandler: ((data: Uint8Array) => void) | undefined;

  send(data: Uint8Array): void {
    this.sent.push(JSON.parse(decoder.decode(data)) as Record<string, unknown>);
  }

  onMessage(cb: (data: Uint8Array) => void): () => void {
    this.messageHandler = cb;
    return () => {
      if (this.messageHandler === cb) this.messageHandler = undefined;
    };
  }

  onClose(): () => void {
    return () => {};
  }

  close(): void {}

  receive(message: Record<string, unknown>): void {
    this.messageHandler?.(encoder.encode(JSON.stringify(message)));
  }

  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === type);
  }
}

const PAYLOAD: DeviceLinkPayload = {
  rootPublicKey: "d".repeat(64),
  rootPrivateKey: "e".repeat(64),
  cert: "cert",
  issuedAt: 1,
  deviceCerts: [],
  spaces: [],
  profile: { name: "Owner", avatar: null },
  prefs: [],
};

function makeReplicator() {
  const peer = new FakePeer();
  const topic: NetworkTopic = {
    onPeerJoin: () => () => {},
    onPeerLeave: () => () => {},
    getPeers: () => [peer],
    destroy: vi.fn(async () => {}),
  };
  const network = {
    setLocalId: vi.fn(),
    registerTopicKey: vi.fn(),
    unregisterTopicKey: vi.fn(),
    join: vi.fn(async () => topic),
    destroy: vi.fn(async () => {}),
  } as unknown as NetworkDriver;

  const host = {
    getIdentity: vi.fn(async () => ({ publicKey: LOCAL_PUBLIC_KEY })),
    getPeerRecords: vi.fn(async () => [] as Peer[]),
    getPeerSharedKey: vi.fn(async () => null),
    getSpaceIds: vi.fn(async () => []),
    getOwnDeviceKeys: vi.fn(async () => []),
    getSpaceMembers: vi.fn(async () => []),
    getCrypto: () => ({
      sign: async () => "proof",
      verify: async () => true,
    }),
  } as unknown as ReplicatorHost;

  return { peer, network, host, replicator: new Replicator(network, host) };
}

/** The already-linked side, listening on a code it just showed. */
async function startInitiator(
  ttlMs: number,
  callbacks: Parameters<Replicator["startPairing"]>[0]["callbacks"] = {},
) {
  const { peer, replicator } = makeReplicator();
  const issueDeviceLink = vi.fn(async () => PAYLOAD);
  await replicator.startPairing({
    invite: {
      secret: SECRET,
      spaceId: "__device__",
      expiresAt: Date.now() + ttlMs,
    },
    role: "initiator",
    mode: "device",
    localPublicKey: LOCAL_PUBLIC_KEY,
    localName: "Laptop",
    privateKey: "priv",
    callbacks,
    issueDeviceLink,
  });
  return { peer, replicator, issueDeviceLink };
}

const hello = {
  type: "pair-hello",
  publicKey: REMOTE_PUBLIC_KEY,
  name: "Phone",
  proof: "proof",
  spaceId: "__device__",
};

describe("Replicator — pairing recovery", () => {
  it("re-sends the enrolment payload when a half-linked device says hello again", async () => {
    const { peer } = await startInitiator(60_000);

    peer.receive(hello);
    await vi.waitFor(() => expect(peer.ofType("device-link").length).toBe(1));

    // What a device that dropped before the payload landed does on reconnect.
    peer.receive(hello);
    await vi.waitFor(() => expect(peer.ofType("device-link").length).toBe(2));

    // The handshake itself does not repeat — only the payload it still owes.
    expect(peer.ofType("pair-ack").length).toBe(1);
  });

  it("reports a code that ran out while a device was still waiting on it", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      await startInitiator(1000, { onError });

      await vi.advanceTimersByTimeAsync(1500);
      expect(onError).toHaveBeenCalledWith("expired");
    } finally {
      vi.useRealTimers();
    }
  });
});
