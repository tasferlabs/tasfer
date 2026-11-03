/**
 * Which pages this person files calendar events under, ranked by use.
 *
 * Tagging an event onto a parent means drilling the picker's rows from the top
 * every time, which punishes exactly the case that matters — a run of events
 * that all belong under the same page. These stats turn that into one tap: the
 * picker leads with the parents chosen most, and a fresh draft opens pre-tagged
 * with the last one while that choice is still fresh.
 *
 * Ranking reuses the command palette's frecency scoring, so "most used" means
 * the same thing in both places: often-chosen beats rarely-chosen, and a stale
 * favourite decays behind what the user reaches for now.
 *
 * The stats live in the own-prefs register, so they follow the person to their
 * other devices (never to a co-member): a run of events started on the laptop
 * carries on pre-tagged on the phone. Each device keeps its own tally per
 * space and a read adds them up (see `./deviceTally`), so two devices filing
 * at once never cost each other a count.
 *
 * Only ids and the ancestor chain are stored. Titles and colors are read back
 * from the live page rows at render time, so a renamed or deleted parent can
 * never show up here as a stale ghost.
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
 * Key PREFIX: `calendar.parentUsage.<spaceId>.<deviceKey>` → that device's
 * usage in that space. Mirrored in `OWN_PREF_KEYS` so this module stays
 * importable without the React context module.
 */
export const PARENT_USAGE_PREF_PREFIX = "calendar.parentUsage.";

/** Where this device kept the stats before they moved to the register. */
export const LEGACY_PARENT_USAGE_KEY = "tasfer:calendar:parent-usage";

/** The slice of the own-prefs store the stats are read from and written to. */
export type ParentUsagePrefs = TallyPrefs;

/**
 * Kept per space and device: enough to rank honestly, small enough to stay
 * cheap to send between devices.
 */
const MAX_PER_SPACE = 24;

/**
 * How long the last-used parent keeps pre-filling new drafts. Long enough to
 * cover a sitting spent entering events, short enough that next week's first
 * event isn't silently filed under last week's page.
 */
export const PREFILL_FRESH_MS = 12 * 60 * 60 * 1000;

/** A parent's ancestor chain, as the pickers pass it around. */
export interface ParentPathSegment {
  id: string;
  title: string;
  titleMd?: string;
  color?: string | null;
}

/** What we know about one page that has been used as a parent. */
export interface ParentUse extends FrecencyEntry {
  /** The page's own parent — the row we re-read its live title/color from. */
  parentId: string | null;
  /** Ancestor chain, so a shortcut can hand back a complete selection. */
  path: ParentPathSegment[];
}

export interface RecentParent extends ParentUse {
  id: string;
}

/** The shape both pickers already hold when a parent is chosen. */
export interface ParentChoice {
  id: string;
  parentId: string | null;
  path?: ParentPathSegment[] | null;
}

function spacePrefix(spaceId: string): string {
  return `${PARENT_USAGE_PREF_PREFIX}${spaceId}.`;
}

function isParentUse(
  entry: FrecencyEntry & Record<string, unknown>,
): entry is ParentUse & Record<string, unknown> {
  return (
    (entry.parentId === null || typeof entry.parentId === "string") &&
    Array.isArray(entry.path)
  );
}

function byScore(now: number) {
  return (a: ParentUse, b: ParentUse) =>
    frecencyValue(b, now) - frecencyValue(a, now) || b.last - a.last;
}

/**
 * The stats this device kept in `localStorage`, as this device's tally in
 * each space, for `OwnPrefsStore` to adopt on first run.
 */
export function readLegacyParentUsage(
  raw: string,
  deviceKey: string,
): Array<[string, unknown]> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") return [];
  return Object.entries(parsed as Record<string, unknown>)
    .filter(([, space]) => space && typeof space === "object")
    .map(([spaceId, space]) => [spacePrefix(spaceId) + deviceKey, space]);
}

/**
 * Record that an event was filed under `page`. Called when the filing actually
 * happens (a draft saved, a page re-parented) rather than when a tag is tapped,
 * so browsing the picker doesn't skew the ranking.
 */
export function recordParentUse(
  prefs: ParentUsagePrefs,
  spaceId: string | null | undefined,
  page: ParentChoice,
  now: number = Date.now(),
): void {
  if (!spaceId) return;
  updateOwnTally(
    prefs,
    spacePrefix(spaceId),
    (own) => {
      own[page.id] = {
        count: (own[page.id]?.count ?? 0) + 1,
        last: now,
        parentId: page.parentId,
        path: page.path ?? [],
      };
      return trimTally(own, MAX_PER_SPACE, byScore(now));
    },
    isParentUse,
  );
}

/**
 * The space's most-used parents across all of the person's devices, best
 * first. Callers resolve each id against the live page rows and drop the ones
 * that no longer exist; `skip` leaves out ids already known to be gone, so
 * their slots go to live pages.
 *
 * The last-used parent is always among them, even when its score doesn't earn a
 * slot: it is the one a new draft opens pre-tagged with, and a selection the
 * picker can't show anywhere is worse than a shortcut nobody presses.
 */
export function getRecentParents(
  prefs: ParentUsagePrefs,
  spaceId: string | null | undefined,
  options?: { limit?: number; now?: number; skip?: ReadonlySet<string> },
): RecentParent[] {
  if (!spaceId) return [];
  const now = options?.now ?? Date.now();
  const tally: Tally<ParentUse> = readTally(
    prefs,
    spacePrefix(spaceId),
    isParentUse,
  );
  const ranked = Object.entries(tally)
    .filter(([id]) => !options?.skip?.has(id))
    .map(([id, entry]) => ({ ...entry, id }))
    .sort(byScore(now));
  const limit = options?.limit ?? 6;
  const top = ranked.slice(0, limit);
  if (ranked.length > limit) {
    const latest = ranked.reduce((a, b) => (b.last > a.last ? b : a));
    if (!top.some((entry) => entry.id === latest.id)) top[limit - 1] = latest;
  }
  return top;
}

/**
 * The parent to pre-tag a new draft with: the one most recently used in this
 * space on any of the person's devices, and only while that choice is still
 * fresh (see PREFILL_FRESH_MS). Returns null otherwise, leaving the draft
 * unparented. `skip` leaves out ids already known to be gone: another device
 * may still list a page deleted since, and the one used before it should
 * pre-fill instead.
 */
export function getLastParent(
  prefs: ParentUsagePrefs,
  spaceId: string | null | undefined,
  options?: { now?: number; skip?: ReadonlySet<string> },
): RecentParent | null {
  if (!spaceId) return null;
  const now = options?.now ?? Date.now();
  const tally = readTally(prefs, spacePrefix(spaceId), isParentUse);
  let best: RecentParent | null = null;
  for (const [id, entry] of Object.entries(tally)) {
    if (options?.skip?.has(id)) continue;
    if (!best || entry.last > best.last) best = { ...entry, id };
  }
  if (!best || now - best.last > PREFILL_FRESH_MS) return null;
  return best;
}

/**
 * Drop a parent that no longer exists from this device's tally. Other
 * devices' copies go when they notice too; until then, pass the id in
 * `getRecentParents`' `skip`.
 */
export function forgetParent(
  prefs: ParentUsagePrefs,
  spaceId: string | null | undefined,
  pageId: string,
): void {
  if (!spaceId) return;
  updateOwnTally(
    prefs,
    spacePrefix(spaceId),
    (own) => {
      if (!own[pageId]) return null;
      delete own[pageId];
      return own;
    },
    isParentUse,
  );
}
