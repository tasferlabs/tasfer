import { describe, expect, it, vi } from "vitest";
import type { NetworkDriver, NetworkPeer, NetworkTopic } from "./driver";
import { PROTOCOL_VERSION, Replicator, type ReplicatorHost } from "./sync";
import type { Peer } from "./types";
import { compressOp, expandOp, WIRE_VERSION } from "./wire-codec";
import type { Operation } from "@tasfer/editor";

const LOCAL_PUBLIC_KEY = "a".repeat(64);
const REMOTE_PUBLIC_KEY = "b".repeat(64);
const SPACE_ID = "space";
const PAGE_ID = "page";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakePeer implements NetworkPeer {
  readonly remotePublicKey = REMOTE_PUBLIC_KEY;
  readonly sent: Array<Record<string, unknown>> = [];
  private messageHandler: ((data: Uint8Array) => void) | undefined;
  private closeHandler: (() => void) | undefined;

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
}

function pageOp(id: string): Operation {
  return {
    op: "block_delete",
    id,
    clock: { counter: 1, peerId: "remote" },
    pageId: PAGE_ID,
    blockId: "block",
  };
}

function pageOpsMessage(op: Operation) {
  return {
    type: "page-ops",
    spaceId: SPACE_ID,
    pageId: PAGE_ID,
    ops: [op],
  };
}

async function flushPeerQueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function setup() {
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
    getTrustedPeers: vi.fn(async () => [
      { publicKey: REMOTE_PUBLIC_KEY, trusted: true } as Peer,
    ]),
    getPeerSharedKey: vi.fn(async () => "c".repeat(64)),
    getSpaceIds: vi.fn(async () => [SPACE_ID]),
    getSpaceMembers: vi.fn(async () => [{ publicKey: REMOTE_PUBLIC_KEY }]),
    getSpaceVV: vi.fn(async () => ({})),
    getPageVVs: vi.fn(async () => ({})),
    updatePeerLastSeen: vi.fn(async () => {}),
    applyRemotePageOps: vi.fn(async () => {}),
  } as unknown as ReplicatorHost;

  const replicator = new Replicator(network, host);
  await replicator.start();
  return {
    replicator,
    peer,
    host: host as ReplicatorHost & {
      getSpaceVV: ReturnType<typeof vi.fn>;
      updatePeerLastSeen: ReturnType<typeof vi.fn>;
      applyRemotePageOps: ReturnType<typeof vi.fn>;
    },
  };
}

describe("Replicator protocol negotiation", () => {
  it("uses a new semantic epoch while retaining the existing wire codec", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(WIRE_VERSION).toBe(1);

    const operation = {
      op: "content_edit",
      id: "peer:2",
      clock: { counter: 2, peerId: "peer" },
      pageId: PAGE_ID,
      blockId: "block",
      contentId: "content",
      edit: {
        kind: "node_attr_set",
        nodeId: "node",
        key: "value",
        value: "x",
      },
    } satisfies Operation;
    const compressed = compressOp(operation, PAGE_ID);

    // content_edit was additive: wire v1 carries its long op name and nested
    // payload losslessly. The incompatibility is merge semantics, not bytes.
    expect(compressed.op).toBe("content_edit");
    expect(compressed.pageId).toBeUndefined();
    expect(expandOp(compressed, PAGE_ID)).toEqual(operation);
  });

  it("blocks before hello and on mismatch, then resumes after a matching hello", async () => {
    const { replicator, peer, host } = await setup();
    const mismatch = vi.fn();
    replicator.onPeerVersionMismatch(mismatch);

    expect(peer.sent[0]).toMatchObject({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      wireVersion: WIRE_VERSION,
    });

    peer.receive(pageOpsMessage(pageOp("before-hello")));
    await flushPeerQueue();
    expect(host.applyRemotePageOps).not.toHaveBeenCalled();

    peer.receive({
      type: "hello",
      publicKey: REMOTE_PUBLIC_KEY,
      protocolVersion: 1,
      wireVersion: WIRE_VERSION,
    });
    await vi.waitFor(() => expect(mismatch).toHaveBeenCalledTimes(1));
    expect(mismatch).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteProtocolVersion: 1,
        protocolCompatible: false,
        wireCompatible: true,
        syncCompatible: false,
      }),
    );

    peer.receive(pageOpsMessage(pageOp("mismatched")));
    replicator.pushPageOps(SPACE_ID, PAGE_ID, [pageOp("outbound-mismatch")]);
    await flushPeerQueue();
    expect(host.applyRemotePageOps).not.toHaveBeenCalled();
    expect(peer.sent.some((message) => message.type === "page-ops")).toBe(
      false,
    );

    peer.receive({
      type: "hello",
      publicKey: REMOTE_PUBLIC_KEY,
      protocolVersion: PROTOCOL_VERSION,
      wireVersion: WIRE_VERSION,
    });
    await vi.waitFor(() => expect(host.getSpaceVV).toHaveBeenCalled());
    expect(peer.sent.some((message) => message.type === "sync-pull")).toBe(
      true,
    );

    peer.receive(pageOpsMessage(pageOp("matched")));
    await vi.waitFor(() =>
      expect(host.applyRemotePageOps).toHaveBeenCalledWith(
        PAGE_ID,
        expect.arrayContaining([expect.objectContaining({ id: "matched" })]),
      ),
    );

    replicator.pushPageOps(SPACE_ID, PAGE_ID, [pageOp("outbound-match")]);
    expect(
      peer.sent.some(
        (message) =>
          message.type === "page-ops" &&
          (message.ops as Array<{ id: string }>)[0]?.id === "outbound-match",
      ),
    ).toBe(true);
  });

  it("treats a pre-negotiation hello with no versions as blocked v1", async () => {
    const { replicator, peer, host } = await setup();
    const mismatch = vi.fn();
    replicator.onPeerVersionMismatch(mismatch);

    peer.receive({ type: "hello", publicKey: REMOTE_PUBLIC_KEY });
    await vi.waitFor(() => expect(mismatch).toHaveBeenCalledTimes(1));
    expect(mismatch).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteProtocolVersion: 1,
        remoteWireVersion: 1,
        syncCompatible: false,
      }),
    );
    expect(host.getSpaceVV).not.toHaveBeenCalled();

    peer.receive(pageOpsMessage(pageOp("legacy")));
    await flushPeerQueue();
    expect(host.applyRemotePageOps).not.toHaveBeenCalled();
  });
});
