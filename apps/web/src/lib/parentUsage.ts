/**
 * Which pages this device files calendar events under, ranked by use.
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
 * Like a remembered picker choice this is a per-device convenience rather than
 * a preference the user set, so it lives in `localStorage`, is never
 * replicated, and is keyed by space — a parent cannot cross a space boundary.
 *
 * Only ids and the ancestor chain are stored. Titles and colors are read back
 * from the live page rows at render time, so a renamed or deleted parent can
 * never show up here as a stale ghost.
 */

import { frecencyValue, type FrecencyEntry } from "./actionRanking";

const KEY = "tasfer:calendar:parent-usage";

/** Kept per space: enough to rank honestly, small enough to stay cheap. */
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

type SpaceStore = Record<string, ParentUse>;
type Store = Record<string, SpaceStore>;

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    // Unavailable (private mode) — nothing is remembered, nothing breaks.
    return null;
  }
}

function load(): Store {
  const store = storage();
  if (!store) return {};
  try {
    const raw = store.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    // Corrupt or unreadable: start over rather than break the picker.
    return {};
  }
}

function save(store: Store): void {
  const target = storage();
  if (!target) return;
  try {
    target.setItem(KEY, JSON.stringify(store));
  } catch {
    // A stat that cannot be stored simply isn't remembered.
  }
}

/**
 * Record that an event was filed under `page`. Called when the filing actually
 * happens (a draft saved, a page re-parented) rather than when a tag is tapped,
 * so browsing the picker doesn't skew the ranking.
 */
export function recordParentUse(
  spaceId: string | null | undefined,
  page: ParentChoice,
  now: number = Date.now(),
): void {
  if (!spaceId) return;
  const store = load();
  const space: SpaceStore = { ...(store[spaceId] ?? {}) };
  const prev = space[page.id];
  space[page.id] = {
    count: (prev?.count ?? 0) + 1,
    last: now,
    parentId: page.parentId,
    path: page.path ?? [],
  };

  // Trim the tail by score so an unbounded history can't grow in storage.
  const ids = Object.keys(space);
  if (ids.length > MAX_PER_SPACE) {
    const ranked = ids
      .sort(
        (a, b) =>
          frecencyValue(space[b]!, now) - frecencyValue(space[a]!, now) ||
          space[b]!.last - space[a]!.last,
      )
      .slice(0, MAX_PER_SPACE);
    const trimmed: SpaceStore = {};
    for (const id of ranked) trimmed[id] = space[id]!;
    store[spaceId] = trimmed;
  } else {
    store[spaceId] = space;
  }
  save(store);
}

/**
 * The space's most-used parents, best first. Callers resolve each id against
 * the live page rows and drop the ones that no longer exist.
 *
 * The last-used parent is always among them, even when its score doesn't earn a
 * slot: it is the one a new draft opens pre-tagged with, and a selection the
 * picker can't show anywhere is worse than a shortcut nobody presses.
 */
export function getRecentParents(
  spaceId: string | null | undefined,
  options?: { limit?: number; now?: number },
): RecentParent[] {
  if (!spaceId) return [];
  const now = options?.now ?? Date.now();
  const space = load()[spaceId];
  if (!space) return [];
  const ranked = Object.entries(space)
    .map(([id, entry]) => ({ id, ...entry }))
    .sort(
      (a, b) =>
        frecencyValue(b, now) - frecencyValue(a, now) || b.last - a.last,
    );
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
 * space, and only while that choice is still fresh (see PREFILL_FRESH_MS).
 * Returns null otherwise, leaving the draft unparented.
 */
export function getLastParent(
  spaceId: string | null | undefined,
  now: number = Date.now(),
): RecentParent | null {
  if (!spaceId) return null;
  const space = load()[spaceId];
  if (!space) return null;
  let best: RecentParent | null = null;
  for (const [id, entry] of Object.entries(space)) {
    if (!best || entry.last > best.last) best = { id, ...entry };
  }
  if (!best || now - best.last > PREFILL_FRESH_MS) return null;
  return best;
}

/** Drop a parent that no longer exists, so its slot goes to a live page. */
export function forgetParent(
  spaceId: string | null | undefined,
  pageId: string,
): void {
  if (!spaceId) return;
  const store = load();
  const space = store[spaceId];
  if (!space || !space[pageId]) return;
  const next = { ...space };
  delete next[pageId];
  store[spaceId] = next;
  save(store);
}
