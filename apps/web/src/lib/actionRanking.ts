/**
 * Relevance ranking for the command palette (ActionCenter).
 *
 * The page-search engine is a recall filter: it returns every page whose title
 * or body contains the query, ordered only by recency. These helpers turn that
 * flat recall set — plus the static quick-actions — into a single Spotlight-like
 * ranking, combining how well the text matches with how often/recently the item
 * has been chosen ("frecency").
 *
 * Everything here is pure and host-agnostic so it can be unit-tested without a
 * DOM. React and persistence concerns stay in the component.
 */

/**
 * Score how well `query` matches a single `target` string, in [0, 1].
 *
 * The shape mirrors what users expect from Spotlight: an exact match beats a
 * prefix, a prefix beats a match at a word boundary, and that beats an arbitrary
 * substring. A match covering more of the target ranks slightly higher, so a
 * short precise title outranks the same query buried in a long one.
 *
 * When the query is not a substring, two fuzzy fallbacks kick in, both scored
 * strictly below any real substring match so exact hits always win:
 *   - subsequence matching, for skipped letters ("grcy" → "Grocery");
 *   - bounded edit distance, for genuine typos ("kalendar" → "Calendar").
 * Returns 0 when nothing plausibly matches.
 */
export function scoreMatch(target: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = target.toLowerCase();
  const idx = t.indexOf(q);
  if (idx < 0) return fuzzyScore(t, q);

  let base: number;
  if (t === q) {
    base = 1;
  } else if (idx === 0) {
    base = 0.9;
  } else if (isWordBoundary(t, idx)) {
    base = 0.7;
  } else {
    base = 0.45;
  }

  // Reward matches that cover more of the target (a tighter, more specific hit).
  const coverage = q.length / t.length;
  return Math.min(1, base + 0.1 * coverage);
}

/**
 * Fuzzy score in [0, 0.42] for a query that is not a substring of `t` (both
 * already lowercased). Combines subsequence and typo matching and stays below
 * the 0.45 floor of a real substring match. Single characters are never fuzzy —
 * they would match almost anything.
 */
function fuzzyScore(t: string, q: string): number {
  if (q.length < 2) return 0;
  return Math.max(subsequenceScore(t, q), typoScore(t, q));
}

/**
 * Score a query whose characters appear in order in the target but not
 * contiguously ("grcy" → "Grocery"). Rewards dense, boundary-aligned matches
 * and rejects ones scattered too thinly across the target.
 */
function subsequenceScore(t: string, q: string): number {
  let ti = 0;
  let qi = 0;
  let first = -1;
  let last = -1;
  let boundary = 0;
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) {
      if (first < 0) first = ti;
      if (isWordBoundary(t, ti)) boundary++;
      last = ti;
      qi++;
    }
    ti++;
  }
  if (qi < q.length) return 0; // not all query chars found in order

  const density = q.length / (last - first + 1); // 1 when contiguous
  if (density < 0.34) return 0; // too spread out to be intentional
  const start = first === 0 ? 0.06 : 0;
  const base = 0.14 + 0.18 * density + 0.03 * Math.min(boundary, 3) + start;
  return Math.min(0.4, base);
}

/**
 * Score a query against the target's words using bounded edit distance, so a
 * mistyped word still matches ("setings" → "settings", "kalendar" → "calendar").
 * The allowed number of edits scales with query length, and the query is also
 * compared against the leading slice of longer words to catch typos in prefixes.
 */
function typoScore(t: string, q: string): number {
  const allowed = q.length <= 2 ? 0 : q.length <= 5 ? 1 : q.length <= 9 ? 2 : 3;
  if (allowed === 0) return 0;

  let best = 0;
  for (const tok of t.split(/[^a-z0-9]+/)) {
    if (!tok) continue;
    let dist = editDistance(q, tok, allowed);
    let denom = Math.max(q.length, tok.length);
    if (tok.length > q.length) {
      const prefixDist = editDistance(q, tok.slice(0, q.length), allowed);
      if (prefixDist < dist) {
        dist = prefixDist;
        denom = q.length;
      }
    }
    if (dist > 0 && dist <= allowed) {
      best = Math.max(best, 0.42 * (1 - dist / denom));
    }
  }
  return best;
}

/**
 * Optimal string alignment distance (Levenshtein plus adjacent transpositions),
 * capped at `max`: once the best possible alignment exceeds `max` it returns
 * `max + 1` without finishing, keeping the common no-match case cheap.
 */
function editDistance(a: string, b: string, max: number): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  if (m === 0) return n;
  if (n === 0) return m;

  let prevPrev = new Array<number>(n + 1).fill(0);
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        v = Math.min(v, prevPrev[j - 2]! + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1; // no alignment can recover
    [prevPrev, prev, curr] = [prev, curr, prevPrev];
  }
  return prev[n]!;
}

/** True when position `idx` in `text` starts a new word. */
function isWordBoundary(text: string, idx: number): boolean {
  if (idx === 0) return true;
  return /[\s/\-_.,:(]/.test(text[idx - 1]!);
}

/** A record of how the user has interacted with one palette item. */
export interface FrecencyEntry {
  /** Number of times the item has been chosen. */
  count: number;
  /** Timestamp (ms since epoch) of the most recent choice. */
  last: number;
}

/**
 * Collapse a frecency entry into a single usage score, weighting the choice
 * count by how recently the item was last used. Recent, frequently-used items
 * score highest; stale ones decay toward zero.
 */
export function frecencyValue(entry: FrecencyEntry, now: number): number {
  const days = Math.max(0, (now - entry.last) / 86_400_000);
  const recency = days < 1 ? 1 : days < 7 ? 0.6 : days < 30 ? 0.3 : 0.1;
  return entry.count * recency;
}

/**
 * Turn a raw frecency value into a small additive boost in [0, 0.3). It
 * saturates so a heavily-used item floats up and breaks ties, but can never
 * outrank a genuinely stronger text match.
 */
export function frecencyBoost(value: number): number {
  if (value <= 0) return 0;
  return 0.3 * (value / (value + 4));
}
