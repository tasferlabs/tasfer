import { describe, expect, it, vi } from "vitest";
import type { NetworkDriver, NetworkPeer, NetworkTopic } from "./driver";
import {
  PROTOCOL_VERSION,
  Replicator,
  unionPullVersions,
  type ReplicatorHost,
} from "./sync";
import type { Peer } from "./types";
import { WIRE_VERSION } from "./wire-codec";

/**
 * Pausing a peer is a decision the app writes as a peer record (`trusted:
 * false`) and the transport reads as admission. These cover the transport half:
 * a paused peer is not dialed, a live connection to one is dropped, and what a
 * peer advertised before it went is kept — that record is the only thing that
 * can later say whether pausing it stranded anything.
 */

const LOCAL_PUBLIC_KEY = "a".repeat(64);
const REMOTE_PUBLIC_KEY = "b".repeat(64);
const SPACE = "shared-space";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakePeer implements NetworkPeer {
  readonly remotePublicKey = REMOTE_PUBLIC_KEY;
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
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

  close(): void {
    this.closed = true;
  }

  receive(message: Record<string, unknown>): void {
    this.messageHandler?.(encoder.encode(JSON.stringify(message)));
  }
}

function setup(options: { paused: boolean; ownDevice?: boolean; pausedSelf?: boolean }) {
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

  const records: Peer[] = [
    { publicKey: REMOTE_PUBLIC_KEY, trusted: !options.paused } as Peer,
  ];
  if (options.pausedSelf) {
    records.push({ publicKey: LOCAL_PUBLIC_KEY, trusted: false } as Peer);
  }

  const host = {
    getIdentity: vi.fn(async () => ({ publicKey: LOCAL_PUBLIC_KEY })),
    getPeerRecords: vi.fn(async () => records),
    getPeerSharedKey: vi.fn(async () => "c".repeat(64)),
    getSpaceIds: vi.fn(async () => [SPACE]),
    getOwnDeviceKeys: vi.fn(async () =>
      options.ownDevice ? [REMOTE_PUBLIC_KEY] : [],
    ),
    getSpaceState: vi.fn(async () => "active" as const),
    getSpaceMembers: vi.fn(async () => [{ publicKey: REMOTE_PUBLIC_KEY }]),
    getOwnSpaceStates: vi.fn(async () => []),
    applyOwnSpaceStates: vi.fn(async () => {}),
    getOwnPrefs: vi.fn(async () => []),
    applyOwnPrefs: vi.fn(async () => {}),
    getSpaceVV: vi.fn(async () => ({})),
    getPageVVs: vi.fn(async () => ({})),
    buildSyncResponse: vi.fn(async () => ({ spaceOps: [], pageOps: {} })),
    updatePeerLastSeen: vi.fn(async () => {}),
    applyRemoteSpaceOps: vi.fn(async () => {}),
    applyRemotePageOps: vi.fn(async () => {}),
  } as unknown as ReplicatorHost & {
    updatePeerLastSeen: ReturnType<typeof vi.fn>;
  };

  return { network, host, peer, records, replicator: new Replicator(network, host) };
}

describe("a paused peer", () => {
  it("is never dialed", async () => {
    const { replicator, network } = setup({ paused: true });
    await replicator.start();

    expect(network.join).not.toHaveBeenCalled();
  });

  it("is still dialed while it is not paused", async () => {
    const { replicator, network } = setup({ paused: false });
    await replicator.start();

    expect(network.join).toHaveBeenCalled();
  });

  it("loses its live connection the moment it is paused", async () => {
    const { replicator, records, peer } = setup({ paused: false });
    await replicator.start();
    peer.receive({
      type: "hello",
      publicKey: REMOTE_PUBLIC_KEY,
      protocolVersion: PROTOCOL_VERSION,
      wireVersion: WIRE_VERSION,
    });

    records[0] = { ...records[0], trusted: false };
    await replicator.refreshSpaces();

    expect(peer.closed).toBe(true);
  });

  it("has its version vector recorded while it is still talking", async () => {
    const { replicator, host, peer } = setup({ paused: false });
    await replicator.start();
    peer.receive({
      type: "hello",
      publicKey: REMOTE_PUBLIC_KEY,
      protocolVersion: PROTOCOL_VERSION,
      wireVersion: WIRE_VERSION,
    });

    peer.receive({
      type: "sync-pull",
      spaceId: SPACE,
      spaceVV: { [REMOTE_PUBLIC_KEY]: 3 },
      pageVVs: { "page-1": { [REMOTE_PUBLIC_KEY]: 9, [LOCAL_PUBLIC_KEY]: 2 } },
    });

    await vi.waitFor(() =>
      expect(host.updatePeerLastSeen).toHaveBeenCalledWith(REMOTE_PUBLIC_KEY, {
        [REMOTE_PUBLIC_KEY]: 9,
        [LOCAL_PUBLIC_KEY]: 2,
      }),
    );
  });
});

describe("a pause naming this device", () => {
  it("stops it dialing the person's other devices", async () => {
    // The sibling that wrote the register is already refusing us, so a dial
    // from this end could only be declined and retried forever — and the
    // sibling is a member of our shared space too, which is the path that
    // would otherwise keep admitting it.
    const { replicator, network } = setup({
      paused: false,
      ownDevice: true,
      pausedSelf: true,
    });
    await replicator.start();

    expect(network.join).not.toHaveBeenCalled();
  });

  it("leaves co-members alone", async () => {
    const { replicator, network } = setup({
      paused: false,
      ownDevice: false,
      pausedSelf: true,
    });
    await replicator.start();

    expect(network.join).toHaveBeenCalled();
  });
});

describe("flattening a pull's version vectors", () => {
  it("keeps the highest clock each replica reached in any scope", () => {
    expect(
      unionPullVersions({
        spaceVV: { alice: 4, bob: 1 },
        pageVVs: {
          "page-1": { alice: 2, bob: 7 },
          "page-2": { carol: 5 },
        },
      }),
    ).toEqual({ alice: 4, bob: 7, carol: 5 });
  });
});
