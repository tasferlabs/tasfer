/**
 * Replicator pause()/resume() — the lifecycle-aware background-sync state
 * machine. These assert the orchestration contract (flush → close → suspend,
 * and resume → reopen → reconnect) via the public API with a fake NetworkDriver
 * and host, so no WebRTC/WebSocket/crypto is exercised. The transport-level
 * suspend/backoff and the on-device flush window are verified manually (see the
 * plan's device test steps).
 */

import { describe, expect, it, vi } from "vitest";
import type { NetworkDriver } from "./driver";
import { Replicator, type ReplicatorHost } from "./sync";
import type { Peer } from "./types";

function makeReplicator(
  trustedPeers: Peer[] = [],
  sharedKey: string | null = "b".repeat(64),
) {
  const flush = vi.fn(async (_ms: number) => {});
  const pause = vi.fn(async () => {});
  const resume = vi.fn(async () => {});
  const registerTopicKey = vi.fn();
  const join = vi.fn(async () => {
    throw new Error("join not expected in pause/resume test");
  });
  const network = {
    setLocalId: vi.fn(),
    registerTopicKey,
    unregisterTopicKey: vi.fn(),
    join,
    destroy: vi.fn(async () => {}),
    flush,
    pause,
    resume,
  } as unknown as NetworkDriver;

  const getTrustedPeers = vi.fn(async () => trustedPeers);
  const getPeerSharedKey = vi.fn(async () => sharedKey);
  const host = { getTrustedPeers, getPeerSharedKey } as unknown as ReplicatorHost;

  const replicator = new Replicator(network, host);
  return { replicator, flush, pause, resume, getTrustedPeers, join, registerTopicKey };
}

describe("Replicator pause/resume", () => {
  it("pause() flushes before suspending and reports disconnected", async () => {
    const { replicator, flush, pause } = makeReplicator();

    await replicator.pause();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);
    // Flush must run before the sockets are suspended, or the in-flight round
    // is torn down before it can drain.
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
      pause.mock.invocationCallOrder[0],
    );
    expect(replicator.getConnectionState()).toBe("disconnected");
  });

  it("pause() is idempotent", async () => {
    const { replicator, pause } = makeReplicator();

    await replicator.pause();
    await replicator.pause();

    expect(pause).toHaveBeenCalledTimes(1);
  });

  it("resume() re-opens the network and re-queries trusted peers", async () => {
    const { replicator, resume, getTrustedPeers } = makeReplicator();

    await replicator.pause();
    await replicator.resume();

    expect(resume).toHaveBeenCalledTimes(1);
    expect(getTrustedPeers).toHaveBeenCalledTimes(1);
  });

  it("resume() without a prior pause is a no-op", async () => {
    const { replicator, resume, getTrustedPeers } = makeReplicator();

    await replicator.resume();

    expect(resume).not.toHaveBeenCalled();
    expect(getTrustedPeers).not.toHaveBeenCalled();
  });

  it("resume() connects a trusted peer that has no topic yet", async () => {
    // With a trusted peer and no existing topic, resume() must attempt to
    // connect it — which routes through network.join() (here made to throw so
    // we can observe the attempt without standing up WebRTC).
    const peer = { publicKey: "a".repeat(64), trusted: true } as unknown as Peer;
    const { replicator, getTrustedPeers, join, registerTopicKey } =
      makeReplicator([peer]);

    await replicator.pause();
    // Should not reject even though the underlying connect throws.
    await expect(replicator.resume()).resolves.toBeUndefined();

    expect(getTrustedPeers).toHaveBeenCalledTimes(1);
    // The topic key is registered before the join, never after.
    expect(registerTopicKey).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledTimes(1);
    expect(registerTopicKey.mock.invocationCallOrder[0]).toBeLessThan(
      join.mock.invocationCallOrder[0],
    );
  });

  it("does not join a topic for a peer with no shared key", async () => {
    // Signaling is encrypted with the peer's shared key. Without one there is
    // nothing to encrypt with, and joining anyway would put SDP, ICE candidates
    // and relayed document bytes on the wire in cleartext.
    const peer = { publicKey: "a".repeat(64), trusted: true } as unknown as Peer;
    const { replicator, join, registerTopicKey } = makeReplicator([peer], null);

    await replicator.pause();
    await expect(replicator.resume()).resolves.toBeUndefined();

    expect(registerTopicKey).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });
});
