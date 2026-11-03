/**
 * How often and how lately the person picks each command palette item — the
 * frecency half of the palette's ranking (see `./actionRanking`).
 *
 * Kept in the own-prefs register so the pages and actions someone reaches for
 * on the laptop float up on the phone too. Each device keeps its own tally and
 * a read adds them up (see `./deviceTally`), so picking items on two devices at
 * once never costs a count.
 */

import { frecencyValue, type FrecencyEntry } from "./actionRanking";
import {
  readTally,
  trimTally,
  updateOwnTally,
  type Tally,
  type TallyPrefs,
} from "./deviceTally";

/**
 * Key PREFIX: `palette.usage.<deviceKey>` → that device's tally. Mirrored in
 * `OWN_PREF_KEYS` so this module stays importable without the React context
 * module.
 */
export const PALETTE_USAGE_PREF_PREFIX = "palette.usage.";

/** Where this device kept the tally before it moved to the register. */
export const LEGACY_FRECENCY_KEY = "tasfer:action-center:frecency";

/**
 * Items kept per device. A tally is re-sent on every handshake between the
 * person's devices, so it is capped; the items cut are the ones that would
 * barely move the ranking anyway.
 */
const MAX_PER_DEVICE = 200;

/** Every device's tally, added together. Keyed by palette item id. */
export function readPaletteUsage(prefs: TallyPrefs): Tally {
  return readTally(prefs, PALETTE_USAGE_PREF_PREFIX);
}

/** Count one pick of `id` on this device. */
export function recordPaletteUse(
  prefs: TallyPrefs,
  id: string,
  now: number = Date.now(),
): void {
  updateOwnTally(prefs, PALETTE_USAGE_PREF_PREFIX, (own) => {
    own[id] = { count: (own[id]?.count ?? 0) + 1, last: now };
    return trimTally(
      own,
      MAX_PER_DEVICE,
      (a: FrecencyEntry, b: FrecencyEntry) =>
        frecencyValue(b, now) - frecencyValue(a, now) || b.last - a.last,
    );
  });
}

/** The tally this device kept in `localStorage`, adopted as its own. */
export function readLegacyFrecency(
  raw: string,
  deviceKey: string,
): Array<[string, unknown]> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return [[PALETTE_USAGE_PREF_PREFIX + deviceKey, parsed]];
}
