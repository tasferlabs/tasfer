/**
 * Mark-span algebra — how a mark's anchored ranges change when the mark is
 * applied to, or removed from, a set of characters.
 *
 * There are two places in the engine that store inline marks: a block's
 * `formats` (carrying an HLC clock for LWW) and a structured node's
 * `markFields` (clock-free — structured edits fold in canonical op-log order,
 * so "last applied wins" already is LWW). The *algebra* is identical in both,
 * and it is the subtle part: a span's endpoint can be tombstoned while its
 * interior survives, so every decision here is made on document-order ordinals
 * over ALL chars (tombstones included) rather than by exact id lookup over the
 * visible ones. Resolving strictly would make a span whose endpoint was deleted
 * match nothing and silently vanish.
 *
 * This module is the single source of that logic; the two stores differ only in
 * what they hang off a range, which they supply as a `makeSpan` callback. It is
 * the write-side twin of `mark-runs.ts`, which resolves the same anchors for
 * reading — the two must agree on tolerance, which is why both key off ordinals.
 *
 * Kept dependency-light (types only) so it can be imported from anywhere in the
 * load order, matching `mark-runs`.
 */

import type { Char, Mark, MarkRange } from "../serlization/loadPage";

/** Shallow value-equality of two marks' attribute bags (order-independent). */
function attrsEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  if (a === b) return true;
  const aKeys = a ? Object.keys(a) : [];
  const bKeys = b ? Object.keys(b) : [];
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a![key] !== b?.[key]) return false;
  }
  return true;
}

/** Whether two marks are the same mark: same type, same attribute values. */
export function areMarksEqual(a: Mark, b: Mark): boolean {
  if (a.type !== b.type) return false;
  return attrsEqual(a.attrs, b.attrs);
}

/**
 * A stable string identity for a mark — its type plus a deterministic encoding
 * of its attrs. Two marks share a key iff `areMarksEqual` considers them equal.
 * Used to batch/group runs of identically-formatted characters (rendering and
 * the parser's active-mark tracking).
 */
export function markKey(mark: Mark): string {
  if (!mark.attrs) return mark.type;
  const keys = Object.keys(mark.attrs).sort();
  if (keys.length === 0) return mark.type;
  return (
    mark.type +
    ":" +
    keys.map((k) => `${k}=${String(mark.attrs![k])}`).join(",")
  );
}

/** Document-order position of every char id, tombstones included. */
function buildOrdinals(chars: Iterable<Char>): Map<string, number> {
  const ordinal = new Map<string, number>();
  let ord = 0;
  for (const { id } of chars) ordinal.set(id, ord++);
  return ordinal;
}

/** The visible char ids, in document order. */
function visibleIdsOf(chars: Iterable<Char>): string[] {
  const ids: string[] = [];
  for (const { id, deleted } of chars) {
    if (!deleted) ids.push(id);
  }
  return ids;
}

/**
 * Add `format` over `charIds`, folding every overlapping same-type span into
 * the result rather than replacing them.
 *
 * The union is what keeps coverage from silently shrinking: a mark that already
 * covered chars outside the requested range must keep covering them (re-marking
 * the second half of a rejoined inline-math chip must not strip the first half).
 * Chained overlaps coalesce into one span because the range grows as it absorbs.
 *
 * `chars` must be the field's chars in document order INCLUDING tombstones.
 * Returns `undefined` when the requested range cannot be resolved against
 * `chars` at all, which callers read as "no coherent change to make".
 */
export function applyMarkToRange<S extends MarkRange>(
  chars: Iterable<Char>,
  spans: readonly S[],
  charIds: readonly string[],
  format: Mark,
  makeSpan: (range: MarkRange) => S,
): S[] | undefined {
  if (charIds.length === 0) return undefined;
  const ordinal = buildOrdinals(chars);

  // `charIds` is a contiguous document-order run; min/max defends against any
  // ordering the caller hands us.
  let startId = charIds[0];
  let endId = charIds[charIds.length - 1];
  let startOrd = ordinal.get(startId);
  let endOrd = ordinal.get(endId);
  if (startOrd === undefined || endOrd === undefined) return undefined;
  if (startOrd > endOrd) {
    [startOrd, endOrd] = [endOrd, startOrd];
    [startId, endId] = [endId, startId];
  }

  const kept: S[] = [];
  for (const span of spans) {
    if (span.format.type !== format.type) {
      kept.push(span);
      continue;
    }
    const spanStart = ordinal.get(span.startCharId);
    const spanEnd = ordinal.get(span.endCharId);
    if (spanStart === undefined || spanEnd === undefined) {
      // Both anchors are foreign to this field — keep the span untouched rather
      // than dropping data we cannot reason about.
      kept.push(span);
      continue;
    }
    if (spanStart > endOrd || spanEnd < startOrd) {
      kept.push(span);
      continue;
    }
    if (spanStart < startOrd) {
      startOrd = spanStart;
      startId = span.startCharId;
    }
    if (spanEnd > endOrd) {
      endOrd = spanEnd;
      endId = span.endCharId;
    }
  }

  return [
    ...kept,
    makeSpan({ startCharId: startId, endCharId: endId, format }),
  ];
}

/**
 * Remove every span of `type` from `charIds`, re-emitting the parts of each
 * affected span that survive on either side of the removed range.
 *
 * A span is split rather than dropped, so un-bolding the middle of a bold run
 * leaves two bold runs. `keepSpan` receives the surviving range and the span it
 * came from, letting a clocked store carry the original span's clock onto its
 * fragments.
 *
 * Returns `undefined` when no span was affected.
 */
export function removeMarkFromRange<S extends MarkRange>(
  chars: Iterable<Char>,
  spans: readonly S[],
  charIds: readonly string[],
  type: string,
  keepSpan: (range: MarkRange, source: S) => S,
): S[] | undefined {
  if (charIds.length === 0) return undefined;
  const all = [...chars];
  const ordinal = buildOrdinals(all);
  const visibleIds = visibleIdsOf(all);
  const selection = new Set(charIds);

  const result: S[] = [];
  let changed = false;

  for (const span of spans) {
    if (span.format.type !== type) {
      result.push(span);
      continue;
    }
    const spanStart = ordinal.get(span.startCharId);
    const spanEnd = ordinal.get(span.endCharId);
    if (spanStart === undefined || spanEnd === undefined) {
      result.push(span);
      continue;
    }

    let overlaps = false;
    for (const charId of charIds) {
      const ord = ordinal.get(charId);
      if (ord !== undefined && ord >= spanStart && ord <= spanEnd) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) {
      result.push(span);
      continue;
    }

    changed = true;
    // Walk the span's visible chars and re-emit each maximal run the removal
    // did not select. A span entirely inside the selection emits nothing, which
    // is how the mark actually disappears.
    let runStart: string | null = null;
    let runEnd: string | null = null;
    for (const charId of visibleIds) {
      const ord = ordinal.get(charId)!;
      if (ord < spanStart) continue;
      if (ord > spanEnd) break;
      if (!selection.has(charId)) {
        if (runStart === null) runStart = charId;
        runEnd = charId;
      } else if (runStart !== null && runEnd !== null) {
        result.push(
          keepSpan(
            { startCharId: runStart, endCharId: runEnd, format: span.format },
            span,
          ),
        );
        runStart = null;
        runEnd = null;
      }
    }
    if (runStart !== null && runEnd !== null) {
      result.push(
        keepSpan(
          { startCharId: runStart, endCharId: runEnd, format: span.format },
          span,
        ),
      );
    }
  }

  return changed ? result : undefined;
}
