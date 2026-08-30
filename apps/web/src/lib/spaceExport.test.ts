/**
 * The export resolves assets concurrently so that one unresolvable reference
 * does not add its whole wait to the next one's. That only stays safe because
 * results come back in input order: bundled image filenames are handed out by
 * position, so a bundle would otherwise depend on which fetch happened to
 * finish first.
 */

import { describe, expect, it } from "vitest";
import { ASSET_FETCH_CONCURRENCY, mapWithConcurrency } from "./spaceExport";

describe("mapWithConcurrency", () => {
  it("returns results in input order, not completion order", async () => {
    // Reverse delays: the last item settles first.
    const items = [40, 30, 20, 10];
    const result = await mapWithConcurrency(items, 4, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `done:${ms}`;
    });

    expect(result).toEqual(["done:40", "done:30", "done:20", "done:10"]);
  });

  it("never exceeds the limit, and still visits every item", async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;

    const result = await mapWithConcurrency(items, 4, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return i * 2;
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually concurrent, not accidentally serial
    expect(result).toEqual(items.map((i) => i * 2));
  });

  it("overlaps waits rather than adding them up", async () => {
    // Four items that each block for the same span: serially that is 4x, and
    // concurrently it is ~1x. This is the export's missing-asset case.
    const started = Date.now();
    await mapWithConcurrency([0, 1, 2, 3], 4, async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(Date.now() - started).toBeLessThan(150);
  });

  it("propagates the first rejection", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("handles an empty list without starting a worker", async () => {
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
  });

  it("keeps the asset bound small enough to protect the peer connection", () => {
    expect(ASSET_FETCH_CONCURRENCY).toBeGreaterThan(1);
    expect(ASSET_FETCH_CONCURRENCY).toBeLessThanOrEqual(8);
  });
});
