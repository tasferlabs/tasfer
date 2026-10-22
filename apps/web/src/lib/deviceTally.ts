/**
 * Usage tallies ("how often, how lately") kept in the own-prefs register, one
 * key per device.
 *
 * The register merges each key last-writer-wins, which is right for a choice
 * but wrong for a count: two devices counting at once would each write the
 * whole map, and one device's counts would vanish. So a device writes only
 * `<prefix><its own key>`, and a read adds every device's key together — counts
 * sum, the latest use wins. No two devices ever write the same key, so there is
 * nothing for the merge to drop.
 *
 * A device can only change its own tally. An entry it wants gone (a deleted
 * page, say) leaves its own key; another device's copy goes when that device
 * notices too, so readers must still check entries against live data.
 */

import type { OwnPrefsStore } from "@/app/contexts/OwnPrefsContext";
import type { FrecencyEntry } from "./actionRanking";

/** The slice of the own-prefs store a tally is read from and written to. */
export type TallyPrefs = Pick<
  OwnPrefsStore,
  "get" | "set" | "entries" | "deviceKey" | "getSnapshot" | "whenLoaded"
>;

export type Tally<T extends FrecencyEntry = FrecencyEntry> = Record<string, T>;

/**
 * Checks one entry that arrived from some device's key. The base check covers
 * `count` and `last`; callers add whatever else their entries carry.
 */
export type EntryCheck<T extends FrecencyEntry> = (
  entry: FrecencyEntry & Record<string, unknown>,
) => entry is T & Record<string, unknown>;

function isEntry(
  value: unknown,
): value is FrecencyEntry & Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<FrecencyEntry>;
  return typeof entry.count === "number" && typeof entry.last === "number";
}

/** One device's tally, keeping only the entries that pass the checks. */
function parseTally<T extends FrecencyEntry>(
  value: unknown,
  check?: EntryCheck<T>,
): Tally<T> {
  const tally: Tally<T> = {};
  // Arrives from the person's other devices, so the shape is checked rather
  // than trusted: a bad entry costs one ranking slot, not the feature.
  if (!value || typeof value !== "object" || Array.isArray(value)) return tally;
  for (const [id, entry] of Object.entries(value)) {
    if (isEntry(entry) && (!check || check(entry))) tally[id] = entry as T;
  }
  return tally;
}

/**
 * Every device's tally under `prefix`, added together. Counts sum; the other
 * fields come from whichever device used the entry last.
 */
export function readTally<T extends FrecencyEntry = FrecencyEntry>(
  prefs: TallyPrefs,
  prefix: string,
  check?: EntryCheck<T>,
): Tally<T> {
  const merged: Tally<T> = {};
  for (const [, value] of prefs.entries(prefix)) {
    for (const [id, entry] of Object.entries(parseTally(value, check))) {
      const prev = merged[id];
      if (!prev) {
        merged[id] = { ...entry };
        continue;
      }
      const latest = entry.last > prev.last ? entry : prev;
      merged[id] = { ...latest, count: prev.count + entry.count };
    }
  }
  return merged;
}

/**
 * Change this device's own tally under `prefix` — the only one it may change.
 * `update` gets a copy it may edit and returns the tally to store, or null to
 * leave it as it is.
 *
 * Waits for the register's first read when it has not landed yet: before it,
 * this device's stored tally reads as empty, and writing over it would wipe
 * every count it holds here and on the person's other devices. Skipped when
 * this device's key could not be read, since a write under any other key would
 * be shared with another device and lose counts again.
 */
export function updateOwnTally<T extends FrecencyEntry = FrecencyEntry>(
  prefs: TallyPrefs,
  prefix: string,
  update: (own: Tally<T>) => Tally<T> | null,
  check?: EntryCheck<T>,
): void {
  if (!prefs.getSnapshot().loaded) {
    void prefs
      .whenLoaded()
      .then(() => updateOwnTally(prefs, prefix, update, check));
    return;
  }
  const device = prefs.deviceKey;
  if (!device) return;
  const next = update(
    parseTally(prefs.get<unknown>(prefix + device, null), check),
  );
  if (next) prefs.set(prefix + device, next);
}

/**
 * Keep the `limit` entries `rank` puts first, so a tally re-sent on every
 * handshake between devices cannot grow without bound.
 */
export function trimTally<T extends FrecencyEntry>(
  tally: Tally<T>,
  limit: number,
  rank: (a: T, b: T) => number,
): Tally<T> {
  const ids = Object.keys(tally);
  if (ids.length <= limit) return tally;
  const kept: Tally<T> = {};
  for (const id of ids
    .sort((a, b) => rank(tally[a]!, tally[b]!))
    .slice(0, limit))
    kept[id] = tally[id]!;
  return kept;
}
