/**
 * The prefetcher decides which peer bytes get pulled and how often peers are
 * re-asked, so the invariants worth pinning are: only content hashes missing
 * from the local store are requested, a hash is asked at most once per peer
 * epoch (no request loops against the same peers), and a failed pull survives
 * until retry() — a lost asset must not be forgotten.
 */

import { describe, expect, it, vi } from "vitest";
import { AssetPrefetcher, assetHashFromRef } from "./asset-prefetch";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

async function settle() {
  // Drain runs through a chain of awaits; a few microtask hops settle it.
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("assetHashFromRef", () => {
  it("accepts a raw content hash", () => {
    expect(assetHashFromRef(HASH_A)).toBe(HASH_A);
  });

  it("normalizes case", () => {
    expect(assetHashFromRef(HASH_A.toUpperCase())).toBe(HASH_A);
  });

  it("extracts the hash from a legacy /api/images/ URL", () => {
    expect(assetHashFromRef(`/api/images/${HASH_A}`)).toBe(HASH_A);
    expect(assetHashFromRef(`/api/images/${HASH_A}?w=200`)).toBe(HASH_A);
  });

  it.each([
    ["external http", "https://example.com/cat.png"],
    ["blob url", "blob:https://example.com/123"],
    ["data uri", "data:image/png;base64,AAAA"],
    ["short hex", "abc123"],
    ["non-hex", "z".repeat(64)],
    ["legacy with non-hash id", "/api/images/logo.png"],
    ["empty", ""],
  ])("rejects %s", (_label, ref) => {
    expect(assetHashFromRef(ref)).toBeNull();
  });
});

describe("AssetPrefetcher", () => {
  function makePrefetcher(opts: {
    local?: string[];
    request?: (hash: string) => Promise<boolean>;
  }) {
    const requestAsset = vi.fn(opts.request ?? (() => Promise.resolve(true)));
    const prefetcher = new AssetPrefetcher({
      listLocalAssetHashes: async () => new Set(opts.local ?? []),
      requestAsset,
    });
    return { prefetcher, requestAsset };
  }

  it("requests missing hashes and skips local ones and non-asset refs", async () => {
    const { prefetcher, requestAsset } = makePrefetcher({ local: [HASH_B] });
    prefetcher.noteRefs([HASH_A, HASH_B, "https://example.com/x.png"]);
    await settle();
    expect(requestAsset.mock.calls).toEqual([[HASH_A]]);
  });

  it("asks for a hash at most once per peer epoch, even across noteRefs", async () => {
    const { prefetcher, requestAsset } = makePrefetcher({
      request: () => Promise.resolve(false),
    });
    prefetcher.noteRefs([HASH_A]);
    await settle();
    prefetcher.noteRefs([HASH_A]);
    await settle();
    expect(requestAsset).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed hash queued and re-requests it on retry()", async () => {
    const { prefetcher, requestAsset } = makePrefetcher({
      request: () => Promise.resolve(false),
    });
    prefetcher.noteRefs([HASH_A]);
    await settle();
    prefetcher.retry();
    await settle();
    expect(requestAsset.mock.calls).toEqual([[HASH_A], [HASH_A]]);
  });

  it("drops a found hash — retry() does not re-request it", async () => {
    const { prefetcher, requestAsset } = makePrefetcher({});
    prefetcher.noteRefs([HASH_A]);
    await settle();
    prefetcher.retry();
    await settle();
    expect(requestAsset).toHaveBeenCalledTimes(1);
  });

  it("pulls sequentially — one request in flight at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { prefetcher, requestAsset } = makePrefetcher({
      request: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
        return true;
      },
    });
    prefetcher.noteRefs([HASH_A, HASH_B]);
    await settle();
    expect(requestAsset).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
  });

  it("a request rejection is treated as not-found, not a crash", async () => {
    const { prefetcher, requestAsset } = makePrefetcher({
      request: () => Promise.reject(new Error("channel closed")),
    });
    prefetcher.noteRefs([HASH_A]);
    await settle();
    prefetcher.retry();
    await settle();
    expect(requestAsset).toHaveBeenCalledTimes(2);
  });
});
