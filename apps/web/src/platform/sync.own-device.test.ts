import { describe, expect, it, vi } from "vitest";
import type { NetworkDriver, NetworkPeer, NetworkTopic } from "./driver";
import { PROTOCOL_VERSION, Replicator, type ReplicatorHost } from "./sync";
import type { Peer, SpaceOperation } from "./types";
import { WIRE_VERSION } from "./wire-codec";

/**
 * A space that exists on only one of a person's devices must reach the others.
 * Nobody else may push a space at us (see `handleSyncData`), so the sibling
 * exception is the whole mechanism — these cover both sides of it.
 */

const LOCAL_PUBLIC_KEY = "a".repeat(64);
const REMOTE_PUBLIC_KEY = "b".repeat(64);
const KNOWN_SPACE = "known-space";
const NEW_SPACE = "new-space";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
}

/** Let the per-peer message queue drain, for assertions about what did NOT happen. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function spaceOp(id: string): SpaceOperation {
  return {
    op: "space_set",
    id,
    clock: { counter: 1, peerId: REMOTE_PUBLIC_KEY },
    spaceId: NEW_SPACE,
    field: "name",
    value: "Recipes",
  } as SpaceOperation;
}

async function setup(options: {
  ownDevice: boolean;
  /** Spaces this device already belongs to. */
  spaceIds?: string[];
  /** State reported for NEW_SPACE. */
  newSpaceState?: "active" | "archived" | "unknown";
}) {
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

  const spaceIds = options.spaceIds ?? [];
  const host = {
    getIdentity: vi.fn(async () => ({ publicKey: LOCAL_PUBLIC_KEY })),
    getPeerRecords: vi.fn(async () => [
      { publicKey: REMOTE_PUBLIC_KEY, trusted: true } as Peer,
    ]),
    getPeerSharedKey: vi.fn(async () => "c".repeat(64)),
    getSpaceIds: vi.fn(async () => spaceIds),
    getOwnDeviceKeys: vi.fn(async () =>
      options.ownDevice ? [REMOTE_PUBLIC_KEY] : [],
    ),
    getSpaceState: vi.fn(async (spaceId: string) =>
      spaceId === NEW_SPACE
        ? (options.newSpaceState ?? "unknown")
        : ("active" as const),
    ),
    getSpaceMembers: vi.fn(async () => [{ publicKey: REMOTE_PUBLIC_KEY }]),
    getSpaceVV: vi.fn(async () => ({})),
    getPageVVs: vi.fn(async () => ({})),
    updatePeerLastSeen: vi.fn(async () => {}),
    applyRemoteSpaceOps: vi.fn(async () => {}),
    applyRemotePageOps: vi.fn(async () => {}),
  } as unknown as ReplicatorHost;

  const replicator = new Replicator(network, host);
  await replicator.start();

  peer.receive({
    type: "hello",
    publicKey: REMOTE_PUBLIC_KEY,
    protocolVersion: PROTOCOL_VERSION,
    wireVersion: WIRE_VERSION,
  });
  await vi.waitFor(() =>
    expect(host.updatePeerLastSeen).toHaveBeenCalledWith(REMOTE_PUBLIC_KEY),
  );

  return {
    replicator,
    peer,
    host: host as ReplicatorHost & {
      applyRemoteSpaceOps: ReturnType<typeof vi.fn>;
    },
    pullsFor: (spaceId: string) =>
      peer.sent.filter(
        (message) =>
          message.type === "sync-pull" && message.spaceId === spaceId,
      ),
  };
}

describe("Replicator — a person's own devices", () => {
  it("dials another of our devices even with no space in common", async () => {
    const { peer } = await setup({ ownDevice: true });
    expect(peer.sent[0]).toMatchObject({ type: "hello" });
  });

  it("adopts a space pushed by our own device and pulls its history", async () => {
    const { peer, host, pullsFor } = await setup({ ownDevice: true });

    peer.receive({
      type: "sync-data",
      spaceId: NEW_SPACE,
      spaceOps: [spaceOp("remote:1")],
      pageOps: {},
    });

    await vi.waitFor(() =>
      expect(host.applyRemoteSpaceOps).toHaveBeenCalledWith(
        NEW_SPACE,
        expect.arrayContaining([expect.objectContaining({ id: "remote:1" })]),
      ),
    );
    await vi.waitFor(() => expect(pullsFor(NEW_SPACE).length).toBe(1));
  });

  it("asks our own device for a space we have never seen", async () => {
    const { peer, host, pullsFor } = await setup({ ownDevice: true });

    // Both the live push and a pull naming the space mean the same thing:
    // that device holds a space we were never told about.
    peer.receive({ type: "space-ops", spaceId: NEW_SPACE, ops: [] });
    await vi.waitFor(() => expect(pullsFor(NEW_SPACE).length).toBe(1));
    expect(host.applyRemoteSpaceOps).not.toHaveBeenCalled();

    peer.receive({
      type: "sync-pull",
      spaceId: NEW_SPACE,
      spaceVV: {},
      pageVVs: {},
    });
    await vi.waitFor(() => expect(pullsFor(NEW_SPACE).length).toBe(2));
  });

  it("keeps a space we archived here archived, whoever pushes it", async () => {
    const { peer, host, pullsFor } = await setup({
      ownDevice: true,
      newSpaceState: "archived",
    });

    peer.receive({
      type: "sync-data",
      spaceId: NEW_SPACE,
      spaceOps: [spaceOp("remote:1")],
      pageOps: {},
    });
    peer.receive({ type: "space-ops", spaceId: NEW_SPACE, ops: [] });
    await settle();

    expect(host.applyRemoteSpaceOps).not.toHaveBeenCalled();
    expect(pullsFor(NEW_SPACE)).toEqual([]);
  });

  it("refuses a space pushed by another person", async () => {
    const { peer, host, pullsFor } = await setup({
      ownDevice: false,
      spaceIds: [KNOWN_SPACE],
    });

    peer.receive({
      type: "sync-data",
      spaceId: NEW_SPACE,
      spaceOps: [spaceOp("remote:1")],
      pageOps: {},
    });
    peer.receive({ type: "space-ops", spaceId: NEW_SPACE, ops: [] });
    await settle();

    expect(host.applyRemoteSpaceOps).not.toHaveBeenCalledWith(
      NEW_SPACE,
      expect.anything(),
    );
    expect(pullsFor(NEW_SPACE)).toEqual([]);
  });
});
