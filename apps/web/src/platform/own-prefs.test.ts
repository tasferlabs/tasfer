/**
 * Own prefs are a last-writer-wins register per key, merged by stamp. A save
 * reads the stored stamp before writing one above it, so two saves that
 * overlap must not both read the same stamp: they would write the same one,
 * and a sibling that saw the first would then refuse the second as a tie.
 */

import { describe, expect, it } from "vitest";
import { memoryEngine } from "./memoryEngine.testing";

/** A stamp from a sibling whose clock runs well ahead of this one. */
const AHEAD = Date.now() + 3_600_000;

async function stored(
  engine: Awaited<ReturnType<typeof memoryEngine>>,
  key: string,
) {
  const [row] = await engine.driver.db.query<{ value: string; stamp: number }>(
    "SELECT value, stamp FROM own_prefs WHERE key = ?",
    [key],
  );
  return row;
}

describe("own prefs", () => {
  it("gives two overlapping saves of one key different stamps", async () => {
    const device = await memoryEngine();
    await device.driver.db.mutate(
      "INSERT INTO own_prefs (key, value, stamp, by) VALUES (?, ?, ?, ?)",
      ["fold", "true", AHEAD, "sibling"],
    );

    await Promise.all([
      device.engine.prefs.set("fold", false),
      device.engine.prefs.set("fold", true),
    ]);

    // Each save lands one above the last, so the second outranks the first
    // everywhere — not only here.
    expect(await stored(device, "fold")).toEqual({
      value: "true",
      stamp: AHEAD + 2,
    });
  });

  it("never writes a save under a newer decision that arrives meanwhile", async () => {
    const device = await memoryEngine();
    const merge = (
      device.engine as unknown as {
        applyOwnPrefs(
          prefs: Array<{
            key: string;
            value: string;
            stamp: number;
            by: string;
          }>,
        ): Promise<void>;
      }
    ).applyOwnPrefs.bind(device.engine);

    await Promise.all([
      device.engine.prefs.set("theme", "light"),
      merge([{ key: "theme", value: '"dark"', stamp: AHEAD, by: "sibling" }]),
    ]);

    // Whichever ran first, the stored stamp is at least the sibling's: either
    // its decision stands, or the save landed above it and outranks it there
    // too. A save written under it would leave this device holding "light"
    // while every sibling keeps "dark".
    const row = await stored(device, "theme");
    expect(row.stamp).toBeGreaterThanOrEqual(AHEAD);
    if (row.value === '"light"') expect(row.stamp).toBeGreaterThan(AHEAD);
  });
});
